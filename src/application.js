/** Coordinate UI snapshots, documents and inference. Archive owns Markdown and
 * its index, Model owns the engine connection, Config owns saved preferences. */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Config, atomicJson } from './config.js';
import { Archive } from './archive.js';
import { Embeddings } from './embeddings.js';
import { Model } from './model.js';
import { downloadVerified } from './download.js';
import { validateGguf } from './gguf.js';
import { isInventoryQuestion, formatInventory } from './inventory.js';
import { buildQuery, fitSources, librarianPayload, validateAnswer, fitDraftInput, validateDraft, NO_MATCH_ANSWER } from './protocol.js';

export class Application extends EventEmitter {
    constructor({ home, resources, root }) {
        super();
        Object.assign(this, { home, resources, root });
        this.config = new Config(home);
        this.manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8'));
        this.prompts = Object.fromEntries(['librarian', 'archivist'].map(name => [name, fs.readFileSync(path.join(root, 'prompts', name + '.md'), 'utf8')]));
        this.model = new Model(this.config, resources);
        this.model.on('status', () => this.publish());
        this.libraryState = { phase: 'loading', message: 'Opening your library…' };
        this.historyFile = path.join(home, 'conversation.json');
        this.chat = fs.existsSync(this.historyFile) ? JSON.parse(fs.readFileSync(this.historyFile, 'utf8')) : { id: randomUUID(), messages: [] };
    }
    snapshot() {
        return { settings: { ...this.config.value }, model: this.model.state, library: this.libraryState, busy: Boolean(this.operation), progress: this.progress ?? null, chat: this.chat, documents: this.archive && !this.archive.error ? this.archive.list() : [], home: this.home };
    }
    publish() { this.emit('state', this.snapshot()); }
    async initialize() {
        // Open search first so browsing/imports/inventory work before Qwen setup.
        try {
            this.embedder = new Embeddings(path.join(this.resources, 'embedding'));
            await this.embedder.initialize();
            this.archive = new Archive(this.home, this.embedder, status => { this.libraryState = status; this.publish(); });
            await this.refresh();
            this.scanTimer = setInterval(() => { if (!this.operation && !this.scanning) this.refresh().catch(() => {}); }, 15000);
            this.scanTimer.unref();
        } catch (error) { this.libraryState = { phase: 'error', message: error.message }; this.publish(); throw error; }
        if (this.config.value.autoStart) this.model.start().catch(() => {});
    }
    async refresh() {
        // Periodic scans and user actions share one in-flight refresh promise.
        if (this.scanning) { await this.scanning; return this.snapshot(); }
        this.scanning = this.archive.scan();
        try {
            const result = await this.scanning;
            this.libraryState = { phase: 'ready', message: `${result.count} document${result.count === 1 ? '' : 's'} in your library`, count: result.count };
            this.publish();
            return this.snapshot();
        } catch (error) { this.libraryState = { phase: 'error', message: error.message }; this.publish(); throw error; }
        finally { this.scanning = null; }
    }
    requireArchive() { if (!this.archive || this.libraryState.phase === 'error') throw new Error(this.libraryState.message || 'Your library is still opening.'); }
    async exclusive(action) {
        // One operation owns one cancellation signal; publish busy state to the UI.
        if (this.operation) throw new Error('Finish or stop the current operation first.');
        const controller = new AbortController();
        this.operation = controller;
        this.publish();
        const pending = Promise.resolve().then(() => action(controller.signal));
        this.pendingOperation = pending;
        try { return await pending; }
        finally { if (this.operation === controller) this.operation = null; if (this.pendingOperation === pending) this.pendingOperation = null; this.progress = null; this.publish(); }
    }
    cancel() { this.operation?.abort(new Error('Stopped.')); if (this.model.state.phase === 'loading') this.model.stop().catch(() => {}); }
    persistChat() { atomicJson(this.historyFile, this.chat); atomicJson(path.join(this.home, 'conversations', this.chat.id + '.json'), this.chat); }
    newChat() {
        if (this.operation) throw new Error('Stop the current answer before starting a new conversation.');
        if (this.chat.messages.length) this.persistChat();
        this.chat = { id: randomUUID(), messages: [] };
        this.persistChat();
        this.publish();
        return this.snapshot();
    }
    async ask(question) {
        this.requireArchive();
        return this.exclusive(async signal => {
            const query = buildQuery(question, this.chat.messages);
            signal.throwIfAborted();
            await this.refresh();
            // Inventory requests use a complete SQL count and real titles. They
            // remain useful even when the AI is stopped or not yet configured.
            if (isInventoryQuestion(question)) {
                const accepted = formatInventory(await this.archive.inventory());
                signal.throwIfAborted();
                this.rememberAnswer(question, accepted);
                return accepted;
            }
            await this.model.start();
            if (this.model.state.phase !== 'ready') throw new Error('Choose or download your model in Settings first.');
            this.progress = { phase: 'searching', message: 'Searching your library…' }; this.publish();
            const result = await this.archive.search(query);
            signal.throwIfAborted();
            let accepted;
            if (!result.results.length) accepted = { answer: NO_MATCH_ANSWER, sources: [], search_scope: result.search_scope };
            else {
                const budget = Math.min(4500, Math.floor(this.config.value.contextSize * 0.25));
                const fitted = await fitSources(result, budget, text => this.model.countTokens(text, signal));
                this.progress = { phase: 'answering', message: 'Reading the retrieved sources…' }; this.publish();
                const payload = librarianPayload(this.prompts.librarian, question.trim(), query, fitted);
                accepted = validateAnswer(await this.model.complete(payload, signal), fitted);
            }
            signal.throwIfAborted();
            this.rememberAnswer(question, accepted);
            return accepted;
        });
    }
    /** Both inventory and evidence-based answers share the same chat lifecycle. */
    rememberAnswer(question, accepted) {
        this.chat.messages.push({ role: 'user', content: question.trim() }, { role: 'assistant', content: accepted.answer, sources: accepted.sources });
        this.chat.messages = this.chat.messages.slice(-100);
        this.persistChat();
    }
    async draft(content) {
        // Generate metadata only; retain the original body and require review/save.
        if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new Error('Provide between 1 and 20,000 characters to archive.');
        return this.exclusive(async signal => {
            this.progress = { phase: 'drafting', message: 'Preparing an archive document…' }; this.publish();
            await this.model.start();
            if (this.model.state.phase !== 'ready') throw new Error('Choose or download your model in Settings first.');
            signal.throwIfAborted();
            for (let attempt = 0; attempt < 2; attempt++) {
                const instructions = this.prompts.archivist + (attempt ? '\nThe previous attempt did not return valid metadata. Return all four keys: title, summary, keywords, type. Keep the summary to one short sentence and use at most five keywords.' : '');
                const fitted = await fitDraftInput(instructions, content, this.config.value.contextSize, text => this.model.countTokens(text, signal), attempt ? 600 : 1200);
                const raw = await this.model.complete(fitted.payload, signal);
                signal.throwIfAborted();
                try { return { markdown: validateDraft(raw, content), source_excerpted: fitted.excerpted }; }
                catch (error) {
                    if (attempt) throw error;
                    this.progress = { phase: 'drafting', message: 'Retrying document preparation…' }; this.publish();
                }
            }
        });
    }
    async save(content) { this.requireArchive(); return this.exclusive(async signal => { signal.throwIfAborted(); const saved = await this.archive.save(content); await this.refresh(); return saved; }); }
    async renameTitle(id, title, revision) {
        this.requireArchive();
        return this.exclusive(async signal => {
            signal.throwIfAborted();
            const document = await this.archive.renameTitle(id, title, revision);
            for (const message of this.chat.messages) for (const source of message.sources ?? []) if (source.id === id) source.title = document.title;
            this.persistChat();
            await this.refresh();
            return document;
        });
    }
    theme(theme) {
        if (!['light', 'dark'].includes(theme)) throw new Error('Choose light or dark mode.');
        this.config.save({ ...this.config.value, theme });
        this.publish();
        return { theme };
    }
    async importFiles(filenames) {
        this.requireArchive();
        return this.exclusive(async signal => {
            let imported = 0;
            let duplicates = 0;
            const errors = [];
            for (const filename of filenames) {
                signal.throwIfAborted();
                try {
                    if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error('File exceeds 2 MiB.');
                    const result = await this.archive.save(fs.readFileSync(filename, 'utf8'), { preserveId: true });
                    if (result.duplicate) duplicates++; else imported++;
                } catch (error) { errors.push(`${path.basename(filename)}: ${error.message}`); }
                this.progress = { phase: 'importing', message: `Imported ${imported} documents…` }; this.publish();
            }
            await this.refresh();
            return { imported, duplicates, errors };
        });
    }
    async selectModel(filename) {
        return this.exclusive(async signal => {
            // User-selected GGUF files need not match the default download hash.
            // Validate the container; the engine reports unsupported architectures.
            validateGguf(filename);
            signal.throwIfAborted();
            await this.model.stop();
            this.config.save({ ...this.config.value, provider: 'embedded', modelPath: filename });
            await this.model.start();
            return this.snapshot();
        });
    }
    async downloadModel() {
        return this.exclusive(async signal => {
            const asset = this.manifest.model;
            const destination = path.join(this.home, 'models', asset.filename);
            let lastUpdate = 0;
            await downloadVerified(asset, destination, { signal, progress: progress => {
                if (Date.now() - lastUpdate < 200 && progress.phase !== 'verifying') return;
                lastUpdate = Date.now();
                this.progress = { ...progress, message: progress.phase === 'verifying' ? 'Verifying the downloaded model…' : 'Downloading your Qwen model…' }; this.publish();
            } });
            fs.writeFileSync(path.join(this.home, 'models', 'MODEL-NOTICES.md'), fs.readFileSync(path.join(this.root, 'THIRD-PARTY-NOTICES.md')));
            await this.model.stop();
            this.config.save({ ...this.config.value, provider: 'embedded', modelPath: destination });
            await this.model.start();
            return this.snapshot();
        });
    }
    async settings(value) {
        if (this.operation) throw new Error('Finish or stop the current operation before changing settings.');
        // Validate before stopping the active connection.
        const { validateSettings } = await import('./config.js');
        const settings = validateSettings(value);
        await this.model.stop();
        this.config.save({ ...settings, theme: this.config.value.theme });
        this.publish();
        await this.model.start();
        return this.snapshot();
    }
    async close() { clearInterval(this.scanTimer); this.cancel(); await this.model.stop(); await this.pendingOperation?.catch(() => {}); await this.archive?.close(); await this.embedder?.close(); }
}
