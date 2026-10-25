/** Binder workflow provenance: https://github.com/AdeptTel1/Aletheia by Adeptus Telvannus.
 * Covered upstream material retains the custom terms in LICENSES/LicenseRef-AdeptTel1-Aletheia.txt; see ATTRIBUTION.md. */
/** Markdown is authoritative; SQLite/FTS/vectors are derived. A shared queue
 * serializes index work. Stable IDs keep citations valid after title edits. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chunkText } from './embeddings.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const stopWords = new Set('a an the any all are am is was were be been being do does did have has had can could would should will shall i me my we our you your he she it its they their them this that these those there here what when where why how who which about on in at to of for with from and or but not please tell show find search archive archives document documents entry entries note notes recorded record know information say says more current question recent conversation resolving references user librarian'.split(' '));
export function searchTerms(query) {
    return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 1 && !stopWords.has(word)))].slice(0, 40);
}
function metadataBlocks(content) { return [...content.matchAll(/(^## Metadata[^\S\r\n]*\r?\n)([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)]; }
function rewriteMetadata(content, transform) {
    // Only the final, outer Metadata block is editable; quoted source stays intact.
    const block = metadataBlocks(content).at(-1);
    return content.slice(0, block.index) + transform(block[1], block[2]) + content.slice(block.index + block[0].length);
}
export function metadataOf(content) {
    return Object.assign({}, ...metadataBlocks(content).map(block => Object.fromEntries([...block[2].matchAll(/^([\w -]+):[ \t]*(.*)$/gm)].map(match => [match[1].trim().toLowerCase(), match[2].trim()]))));
}
const titleOf = content => content.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 400) || 'Untitled';
function* markdownFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* markdownFiles(filename);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) yield filename;
    }
}

export class Archive {
    constructor(home, embedder, status = () => {}) {
        this.home = home;
        this.directory = path.join(home, 'knowledge');
        this.embedder = embedder;
        this.status = status;
        fs.mkdirSync(this.directory, { recursive: true });
        this.db = new DatabaseSync(path.join(home, 'archive.sqlite3'));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, filename TEXT UNIQUE NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chunks(rowid INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, title TEXT NOT NULL, text TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, embedding BLOB NOT NULL);
            CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(title, text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO passages(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;
            CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO passages(passages,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); END;`);
        const version = 'bge-small-v1.5-onnx-q8-mean-384-chunk240-overlap40-v1';
        const existing = this.db.prepare("SELECT value FROM settings WHERE key='embedding'").get()?.value;
        if (existing && existing !== version) throw new Error('The derived search index uses a different embedding configuration. Back up and rebuild archive.sqlite3; original Markdown is unchanged.');
        this.db.prepare("INSERT OR IGNORE INTO settings VALUES('embedding',?)").run(version);
        this.queue = Promise.resolve();
        this.error = null;
    }
    run(operation) {
        // Return failures to the caller without poisoning later queued operations.
        const result = this.queue.then(operation);
        this.queue = result.catch(() => {});
        return result;
    }
    async scan() {
        // Hashes skip unchanged files. Prepare vectors before replacing rows in SQL.
        return this.run(async () => {
            try {
                const files = [...markdownFiles(this.directory)];
                const records = files.map(filename => {
                    if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error(`Archive file exceeds 2 MiB: ${path.basename(filename)}`);
                    const content = fs.readFileSync(filename, 'utf8');
                    const metadata = metadataOf(content);
                    return { id: metadata.id || path.basename(filename, path.extname(filename)), filename, content, metadata, hash: digest(content), title: titleOf(content) };
                });
                const ids = new Set();
                for (const record of records) {
                    if (ids.has(record.id)) throw new Error(`Duplicate archive ID: ${record.id}. Give the documents distinct IDs before searching.`);
                    ids.add(record.id);
                }
                let changed = 0;
                for (const record of records) {
                    const previous = this.db.prepare('SELECT hash FROM documents WHERE id=?').get(record.id);
                    if (previous?.hash === record.hash) {
                        this.db.prepare('UPDATE documents SET filename=? WHERE id=?').run(record.filename, record.id);
                        continue;
                    }
                    this.status({ phase: 'indexing', message: `Indexing ${record.title}`, done: changed, total: records.length });
                    const chunks = chunkText(record.content, text => this.embedder.tokenCount(text));
                    for (const chunk of chunks) chunk.embedding = await this.embedder.embed(chunk.text);
                    this.db.exec('BEGIN IMMEDIATE');
                    try {
                        this.db.prepare('DELETE FROM documents WHERE id=? OR filename=?').run(record.id, record.filename);
                        this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?)').run(record.id, record.filename, record.title, record.content, JSON.stringify(record.metadata), record.hash);
                        const insert = this.db.prepare('INSERT INTO chunks(document_id,title,text,start,end,embedding) VALUES(?,?,?,?,?,?)');
                        for (const chunk of chunks) insert.run(record.id, record.title, chunk.text, chunk.start, chunk.end, Buffer.from(new Float32Array(chunk.embedding).buffer));
                        this.db.exec('COMMIT');
                    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
                    changed++;
                }
                for (const record of this.db.prepare('SELECT id FROM documents').all()) if (!ids.has(record.id)) this.db.prepare('DELETE FROM documents WHERE id=?').run(record.id);
                this.error = null;
                return { count: records.length, changed };
            } catch (error) { this.error = error; throw error; }
        });
    }
    list() {
        if (this.error) throw this.error;
        return this.db.prepare('SELECT id,title,metadata FROM documents ORDER BY rowid DESC LIMIT 500').all().map(record => ({ ...record, metadata: JSON.parse(record.metadata) }));
    }
    /** Count the complete index; the title examples are deliberately bounded. */
    async inventory(limit = 12) {
        return this.run(async () => {
            if (this.error) throw this.error;
            if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid inventory limit.');
            const total = this.db.prepare('SELECT COUNT(*) AS total FROM documents').get().total;
            const types = this.db.prepare("SELECT COALESCE(NULLIF(TRIM(json_extract(metadata,'$.type')),''),'Uncategorized') AS type,COUNT(*) AS count FROM documents GROUP BY type ORDER BY count DESC,type LIMIT 15").all();
            const documents = this.db.prepare('SELECT id,title FROM documents ORDER BY rowid DESC LIMIT ?').all(limit);
            // Metadata topics are labels supplied by documents, not model-inferred
            // claims about unseen source text. Scan all labels, not just examples.
            const topics = new Map();
            for (const row of this.db.prepare("SELECT json_extract(metadata,'$.topics') AS topics FROM documents WHERE json_extract(metadata,'$.topics') IS NOT NULL").all()) {
                if (typeof row.topics !== 'string') continue;
                const seen = new Set();
                for (const label of row.topics.split(/[,;\n]/).map(value => value.trim().slice(0, 100)).filter(value => value && !/^(none|unknown|n\/a)$/i.test(value))) {
                    const key = label.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const current = topics.get(key) || { topic: label, count: 0 };
                    current.count++; topics.set(key, current);
                }
            }
            return { total, types, documents, topics: [...topics.values()].sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, 10) };
        });
    }
    get(id) {
        if (this.error) throw this.error;
        const record = this.db.prepare('SELECT id,title,content,metadata,hash AS revision FROM documents WHERE id=?').get(id);
        if (!record) throw new Error('This document is no longer in the archive.');
        return { ...record, metadata: JSON.parse(record.metadata) };
    }
    async search(query, { limit = 5, maxChars = 20000 } = {}) {
        // Fuse lexical and semantic ranks. Selected passages are not an inventory.
        return this.run(async () => {
            if (this.error) throw this.error;
            if (typeof query !== 'string' || query.length > 8000) throw new Error('Search questions must contain at most 8,000 characters.');
            if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 40000) throw new Error('Invalid search limits.');
            const terms = searchTerms(query);
            const candidates = new Map();
            const add = (row, score) => {
                const old = candidates.get(row.document_id);
                if (old) { old.score += score; old.spans.push([row.start, row.end]); }
                else candidates.set(row.document_id, { id: row.document_id, score, spans: [[row.start, row.end]] });
            };
            if (terms.length) {
                const expression = terms.map(term => `"${term}"`).join(' OR ');
                const matches = this.db.prepare('SELECT c.document_id,c.start,c.end,bm25(passages,3,1) AS rank FROM passages JOIN chunks c ON c.rowid=passages.rowid WHERE passages MATCH ? ORDER BY rank LIMIT 80').all(expression);
                matches.forEach((row, rank) => add(row, 1 / (60 + rank)));
            }
            if (query.trim() && this.db.prepare('SELECT 1 FROM chunks LIMIT 1').get()) {
                const vector = await this.embedder.embed(query.slice(0, 2000), true);
                const semantic = this.db.prepare('SELECT document_id,start,end,embedding FROM chunks').all().map(row => {
                    const bytes = row.embedding;
                    const values = new Float32Array(Uint8Array.from(bytes).buffer);
                    let similarity = 0;
                    for (let i = 0; i < vector.length; i++) similarity += vector[i] * values[i];
                    return { ...row, similarity };
                }).filter(row => row.similarity >= 0.65).sort((a, b) => b.similarity - a.similarity).slice(0, 80);
                semantic.forEach((row, rank) => add(row, 1 / (60 + rank)));
            }
            let remaining = maxChars;
            let truncated = false;
            const results = [];
            for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit)) {
                if (!remaining) { truncated = true; break; }
                const record = this.get(candidate.id);
                let content = record.content;
                if (content.length > remaining) {
                    const spans = candidate.spans.sort((a, b) => a[0] - b[0]);
                    const merged = [];
                    for (const span of spans) {
                        const last = merged.at(-1);
                        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
                        else merged.push([...span]);
                    }
                    content = merged.map(([start, end]) => record.content.slice(start, end)).join('\n\n[...]\n\n').slice(0, remaining);
                    truncated = true;
                }
                remaining -= content.length;
                results.push({ ...record, content, is_excerpt: content !== record.content });
            }
            return { success: true, query, results, truncated, search_scope: 'hybrid_top_k' };
        });
    }
    async save(content, { preserveId = false } = {}) {
        // Atomic file replacement keeps scanners from seeing partial Markdown.
        if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Save a nonempty Markdown document of at most 2 MiB.');
        const saved = await this.run(async () => {
            const metadata = metadataOf(content);
            let id = preserveId && metadata.id;
            if (id) {
                const existing = this.db.prepare('SELECT hash FROM documents WHERE id=?').get(id);
                if (existing?.hash === digest(content)) return { id, duplicate: true };
                if (existing) throw new Error(`A different document already uses the ID ${id}.`);
                if (!/^[\p{L}\p{N}_-]{1,240}$/u.test(id)) throw new Error('The imported document has an unsafe or excessively long ID.');
            } else {
                const now = new Date().toISOString();
                const stamp = now.slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
                const slug = titleOf(content).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'untitled';
                id = `${stamp}_${slug}`;
                let suffix = 0;
                while (fs.existsSync(path.join(this.directory, id + '.md')) || this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)) id = `${stamp}_${slug}_${++suffix}`;
                const fields = `ID: ${id}\nCreated: ${now}\nModified: ${now}\n`;
                if (/^## Metadata\s*$/m.test(content)) {
                    content = rewriteMetadata(content, (heading, block) => heading + '\n' + fields + block.replace(/^(?:ID|Created|Modified):.*\r?\n?/gmi, '').trim() + '\n');
                } else content += '\n\n## Metadata\n\n' + fields;
            }
            const destination = path.join(this.directory, id + '.md');
            if (fs.existsSync(destination)) {
                if (fs.readFileSync(destination, 'utf8') === content) return { id, duplicate: true };
                throw new Error('A document with this filename already exists.');
            }
            const temporary = path.join(this.directory, randomUUID() + '.tmp');
            fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
            try { fs.renameSync(temporary, destination); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
            return { id, duplicate: false };
        });
        await this.scan();
        return { ...this.get(saved.id), duplicate: saved.duplicate };
    }
    async renameTitle(id, title, revision) {
        // Revision checks prevent overwriting external edits made since opening.
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 400 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Enter a title of 1–400 characters on one line.');
        if (typeof id !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Reopen the document before changing its title.');
        await this.run(async () => {
            if (this.error) throw this.error;
            const record = this.db.prepare('SELECT filename,hash FROM documents WHERE id=?').get(id);
            if (!record) throw new Error('This document is no longer in the archive.');
            const relative = path.relative(fs.realpathSync(this.directory), fs.realpathSync(record.filename));
            if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(record.filename).isSymbolicLink()) throw new Error('The document must be inside the archive folder.');
            const original = fs.readFileSync(record.filename, 'utf8');
            if (record.hash !== revision || digest(original) !== revision) throw new Error('This document changed after it was opened. Close it and reopen it before editing the title.');
            const eol = original.includes('\r\n') ? '\r\n' : '\n';
            const heading = /^#[ \t]+[^\r\n]*(\r?)$/m;
            let content = heading.test(original) ? original.replace(heading, (_line, cr) => '# ' + title.trim() + cr) : '# ' + title.trim() + eol + eol + original;
            const modified = new Date().toISOString();
            const metadata = /(^## Metadata[^\S\r\n]*\r?\n)([\s\S]*?)(?=^##\s|$(?![\s\S]))/m;
            if (metadata.test(content)) content = rewriteMetadata(content, (heading, block) => {
                const fields = metadataOf('## Metadata\n' + block);
                const updated = block.replace(/^Modified:[^\r\n]*(?:\r?\n|$)/gmi, '');
                return heading + (fields.id ? '' : 'ID: ' + id + eol) + 'Modified: ' + modified + eol + updated;
            });
            else content += eol + eol + '## Metadata' + eol + eol + 'ID: ' + id + eol + 'Modified: ' + modified + eol;
            const temporary = path.join(path.dirname(record.filename), randomUUID() + '.tmp');
            fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
            try { fs.renameSync(temporary, record.filename); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        });
        await this.scan();
        return this.get(id);
    }
    async close() { await this.queue; this.db.close(); }
}
