/** Local mode owns one authenticated loopback llama-server child. API mode
 * connects to the user's selected server/model and owns no external process. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_MODEL_FILENAME, LOCAL_MODEL_ID, validateApiConnection } from './config.js';
import { runtimeExecutable } from './runtime.js';
import { validateGguf } from './gguf.js';
import { ApiError, apiRequest, completionBody, unsupportedFormat } from './api.js';

async function availablePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

export class Model extends EventEmitter {
    constructor(config, resources, { send = fetch, launch = spawn } = {}) {
        super();
        Object.assign(this, { config, resources, send, launch });
        this.state = { phase: 'stopped', message: 'Choose your model to get started.' };
        this.log = '';
    }
    status(phase, message, extra = {}) { this.state = { phase, message, ...extra }; this.emit('status', this.state); }
    start() {
        // Share a pending start so concurrent requests do not load competing engines.
        if (this.starting) return this.starting;
        if (this.state.phase === 'ready') return Promise.resolve();
        this.controller = new AbortController();
        const pending = this.open(this.controller.signal);
        this.starting = pending;
        pending.finally(() => { if (this.starting === pending) this.starting = null; }).catch(() => {});
        return pending;
    }
    async open(signal) {
        const settings = this.config.value;
        try {
            this.negotiatedFormat = null;
            if (settings.provider === 'api') {
                this.status('loading', 'Connecting to your API…');
                this.baseUrl = settings.apiUrl;
                this.key = settings.apiKey;
                if (!settings.apiModel?.trim()) throw new Error('Enter the API model ID in Settings.');
                this.modelId = settings.apiModel;
                // Catalogs are optional: private deployments and proxy APIs may
                // accept chat requests without implementing model discovery.
                let discovered = true;
                try { await this.request('/models', undefined, signal, 15000); }
                catch (error) { if (!(error instanceof ApiError) || ![404, 405, 501].includes(error.status)) throw error; discovered = false; }
                this.status('ready', `${discovered ? 'API connected' : 'API configured; model checked on first request'} · ${this.modelId}`, { provider: 'api', backend: 'external', model: this.modelId });
                return;
            }
            if (!settings.modelPath || !fs.existsSync(settings.modelPath)) {
                this.status('setup', 'Choose a local GGUF model, download the default Qwen, or connect to an API in Settings.');
                return;
            }
            validateGguf(settings.modelPath);
            const backends = settings.gpu === 'cpu' ? ['cpu'] : ['vulkan', 'cpu'];
            const failures = [];
            for (const backend of backends) {
                signal.throwIfAborted();
                try { await this.openLocal(backend, signal); return; }
                catch (error) {
                    failures.push(`${backend}: ${error.message}`);
                    await this.killChild();
                    signal.throwIfAborted();
                }
            }
            throw new Error('The built-in engine could not load this model. Use a llama.cpp-compatible instruction/chat GGUF with an embedded chat template, or try CPU mode/a smaller context. ' + failures.join(' | '));
        } catch (error) {
            if (!signal.aborted) this.status('error', error.message);
            throw error;
        }
    }
    async openLocal(backend, signal) {
        // Use an ephemeral loopback port/key; open() retries CPU if GPU loading fails.
        const executable = runtimeExecutable(this.resources, backend);
        if (!fs.existsSync(executable)) throw new Error('The packaged model engine is missing. Run the asset preparation step or reinstall Aletheia.');
        const port = await availablePort();
        this.key = randomBytes(32).toString('hex');
        this.baseUrl = `http://127.0.0.1:${port}/v1`;
        const settings = this.config.value;
        this.modelId = LOCAL_MODEL_ID;
        const name = path.basename(settings.modelPath);
        this.status('loading', `Loading ${name} · ${backend === 'cpu' ? 'CPU' : 'automatic GPU acceleration'}…`, { backend, model: name });
        this.log = '';
        const child = this.launch(executable, [
            '--model', settings.modelPath, '--alias', this.modelId,
            '--host', '127.0.0.1', '--port', String(port), '--api-key', this.key,
            '--ctx-size', String(settings.contextSize), '--parallel', '1', '--n-gpu-layers', backend === 'cpu' ? '0' : '99',
            '--jinja', '--no-webui',
            ...(name === DEFAULT_MODEL_FILENAME ? ['--reasoning-budget', '0'] : []),
        ], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(executable),
            // Scope the Linux library search path to the engine child. Electron
            // keeps its own libraries while llama-server finds its bundled .so's.
            env: { ...process.env, ...(process.platform === 'linux' ? { LD_LIBRARY_PATH: path.dirname(executable) + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') } : {}) },
        });
        this.child = child;
        let failure;
        const capture = chunk => { this.log = (this.log + chunk.toString()).slice(-10000); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        child.on('error', error => { failure = error; });
        child.on('exit', code => {
            if (this.child === child && this.state.phase === 'ready') {
                this.child = null;
                this.status('error', `The model engine stopped (code ${code}). Try loading it again or choose CPU mode.`);
            }
        });
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
            signal.throwIfAborted();
            if (failure || child.exitCode !== null || child.signalCode !== null) throw failure || new Error(`Engine exited. ${this.log.slice(-2500)}`);
            try {
                const response = await this.send(this.baseUrl.replace(/\/v1$/, '/health'), { headers: this.headers(), signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
                if (response.ok) {
                    const models = await this.request('/models', undefined, signal);
                    if (!models.data?.some(model => model.id === this.modelId)) throw new Error('The loaded engine did not expose the selected local model.');
                    this.status('ready', `${name} is ready · ${backend === 'cpu' ? 'CPU' : 'GPU acceleration'}`, { provider: 'embedded', backend, model: name });
                    return;
                }
            } catch (error) { if (signal.aborted) throw error; }
            await delay(350, undefined, { signal });
        }
        throw new Error('Loading the model timed out. Try CPU mode or a smaller context size.');
    }
    headers() { return { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) }; }
    async request(route, body, signal, timeout = 180000) {
        return apiRequest(this.send, this.baseUrl, this.key, route, body, signal, timeout);
    }
    async models(connection) {
        // Fetch using the edited form fields without saving, changing providers,
        // stopping a working local model, or exposing a generic network IPC call.
        const { apiUrl, apiKey } = validateApiConnection(connection);
        const result = await apiRequest(this.send, apiUrl, apiKey, '/models', undefined, undefined, 15000);
        if (!Array.isArray(result.data)) throw new Error('This API does not provide a model list. Enter the model ID manually.');
        return [...new Set(result.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 512 && !/[\x00-\x1f]/.test(id)))].sort().slice(0, 1000);
    }
    async countTokens(text, signal) {
        // Without a server tokenizer, UTF-8 bytes provide a deliberately generous
        // estimate. Set context size to the actual model/deployment limit.
        if (this.config.value.provider === 'api') return Buffer.byteLength(text, 'utf8');
        const response = await this.send(this.baseUrl.replace(/\/v1$/, '/tokenize'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ content: text, add_special: false }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10000)]) });
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.tokens)) throw new Error('Could not measure the model context.');
        return value.tokens.length;
    }
    async complete(payload, signal) {
        await this.start();
        if (this.state.phase !== 'ready') throw new Error('Finish AI setup before generating an answer.');
        const settings = this.config.value;
        const local = settings.provider === 'embedded';
        const selected = settings.responseMode ?? 'auto';
        const outputLimit = settings.outputTokens ?? payload.max_tokens;
        const modes = selected === 'auto' ? ['json_schema', 'json_object', 'prompt'].slice(Math.max(0, ['json_schema', 'json_object', 'prompt'].indexOf(this.negotiatedFormat))) : [selected];
        for (const mode of modes) {
            const body = completionBody(payload, { model: this.modelId, mode, limit: outputLimit, local, defaultQwen: local && path.basename(settings.modelPath) === DEFAULT_MODEL_FILENAME, tokenLimitField: local ? 'max_tokens' : settings.tokenLimitField });
            const inputSize = await this.countTokens(JSON.stringify(body.messages), signal);
            const available = settings.contextSize - inputSize - 256;
            if (available < 256) throw new Error('This request exceeds the selected context size. Increase it only if your model supports more context, or shorten the input.');
            body[local ? 'max_tokens' : settings.tokenLimitField] = Math.min(outputLimit, available);
            try {
                const raw = await this.request('/chat/completions', body, signal);
                if (local && raw.model !== this.modelId) throw new Error('The local engine answered with a different model. No answer was accepted.');
                // Remote services may resolve a requested alias to a dated model
                // ID. Request the exact selected ID but allow that response alias.
                if (selected === 'auto') this.negotiatedFormat = mode;
                return raw;
            } catch (error) {
                // Some local chat templates prefill text that cannot enter a
                // JSON grammar. A sampler-initialization rejection happens before
                // generation and can use the same bounded format fallback.
                const localGrammarFailure = local && error instanceof ApiError && error.status === 400 && /(?:initializ.*sampler|grammar)/i.test(error.message);
                if (selected !== 'auto' || mode === modes.at(-1) || !(unsupportedFormat(error) || localGrammarFailure)) throw error;
            }
        }
    }
    async killChild() {
        // Stop only our owned child, never an external server or all named processes.
        const child = this.child;
        this.child = null;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit').catch(() => {});
        child.kill();
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    async stop() {
        this.controller?.abort();
        await this.killChild();
        await this.starting?.catch(() => {});
        this.status('stopped', 'The model engine is stopped.');
    }
}
