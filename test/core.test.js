// Deterministic regression checks use temporary profiles and synthetic records.
// These tests never open the user archive or require a running language model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Archive, metadataOf } from '../src/archive.js';
import { chunkText } from '../src/embeddings.js';
import { Config, validateSettings, defaults } from '../src/config.js';
import { buildQuery, librarianPayload, validateAnswer, archivistPayload, validateDraft, fitDraftInput, fitSources, NO_MATCH_ANSWER } from '../src/protocol.js';
import { downloadVerified } from '../src/download.js';
import { Model } from '../src/model.js';
import { Application } from '../src/application.js';
import { fileURLToPath } from 'node:url';

function cleanupTestDirectory(directory) {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('aletheia-'));
    fs.rmSync(target, { recursive: true, force: true });
}

function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-test-'));
    const archive = new Archive(home, { tokenCount: text => Array.from(text).length, embed: async () => Array(384).fill(0) });
    t.after(async () => { await archive.close(); cleanupTestDirectory(home); });
    return { archive, home };
}
const source = { id: 'magic', title: 'Magic', content: 'A warlock is a practitioner of magic.', metadata: {}, is_excerpt: false };
const result = documents => ({ success: true, search_scope: 'hybrid_top_k', truncated: false, results: documents, documents });
const raw = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });

test('local archive saves atomically, finds singular/plural terms, preserves originals, and rejects unrelated queries', async t => {
    const { archive, home } = fixture(t);
    const saved = await archive.save('# Magic glossary\n\nA warlock practices magic.\n\n## Metadata\n\nType: Reference\n');
    assert.ok(saved.id.includes('magic-glossary'));
    assert.equal(metadataOf(saved.content).id, saved.id);
    const filename = path.join(home, 'knowledge', saved.id + '.md');
    const original = fs.readFileSync(filename, 'utf8');
    const found = await archive.search('Do you have any entries on warlocks?');
    assert.equal(found.results[0].id, saved.id);
    assert.equal(found.results[0].content, original);
    assert.deepEqual((await archive.search('Any documents about gardening?')).results, []);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    const small = await archive.search('warlock', { maxChars: 30 });
    assert.ok(small.results[0].content.length <= 30);
    assert.equal(small.results[0].is_excerpt, true);
    assert.equal(small.truncated, true);
    fs.unlinkSync(filename);
    await archive.scan();
    assert.deepEqual(archive.list(), []);
});

test('imports preserve stable IDs and duplicate IDs make retrieval unavailable until repaired', async t => {
    const { archive, home } = fixture(t);
    const content = '# Original memory\n\nThe barn was green.\n\n## Metadata\n\nID: original-memory\nCreated: 2020-01-01\n';
    assert.equal((await archive.save(content, { preserveId: true })).id, 'original-memory');
    assert.equal((await archive.save(content, { preserveId: true })).duplicate, true);
    assert.equal(archive.get('original-memory').content, content);
    fs.writeFileSync(path.join(home, 'knowledge', 'duplicate.md'), content);
    await assert.rejects(archive.scan(), /Duplicate archive ID/);
    await assert.rejects(archive.search('barn'), /Duplicate archive ID/);
    fs.unlinkSync(path.join(home, 'knowledge', 'duplicate.md'));
    await archive.scan();
    assert.equal((await archive.search('barn')).results.length, 1);
    await assert.rejects(archive.save(content.replace('green', 'blue'), { preserveId: true }), /different document/);
});

test('title edits preserve document IDs, filenames, content and creation dates, and update search', async t => {
    const { archive, home } = fixture(t);
    const saved = await archive.save('# Old heading\n\nThe barn was green.\n\n## Metadata\n\nType: Memory\n');
    const before = archive.get(saved.id);
    const files = fs.readdirSync(path.join(home, 'knowledge'));
    const renamed = await archive.renameTitle(saved.id, 'Bicycle maintenance reference', before.revision);
    assert.equal(renamed.id, saved.id);
    assert.equal(renamed.title, 'Bicycle maintenance reference');
    assert.match(renamed.content, /^# Bicycle maintenance reference\n\nThe barn was green\./);
    assert.equal(renamed.metadata.created, before.metadata.created);
    assert.equal(renamed.metadata.id, before.metadata.id);
    assert.ok(renamed.metadata.modified);
    assert.deepEqual(fs.readdirSync(path.join(home, 'knowledge')), files);
    assert.equal((await archive.search('Bicycle maintenance')).results[0].id, saved.id);
    await assert.rejects(archive.renameTitle(saved.id, 'Overwritten heading', before.revision), /changed after/);
    await assert.rejects(archive.renameTitle(saved.id, 'Injected\n# Heading', renamed.revision), /one line/);
});

test('title edits do not overwrite external changes and handle legacy Markdown without metadata', async t => {
    const { archive, home } = fixture(t);
    const filename = path.join(home, 'knowledge', 'legacy.md');
    fs.writeFileSync(filename, 'Original content without a heading.\r\n');
    await archive.scan();
    const original = archive.get('legacy');
    const renamed = await archive.renameTitle('legacy', 'Legacy title', original.revision);
    assert.equal(renamed.id, 'legacy');
    assert.match(renamed.content, /^# Legacy title\r\n\r\nOriginal content without a heading\./);
    assert.equal(renamed.metadata.id, 'legacy');
    fs.appendFileSync(filename, '\r\nA manual addition.');
    await assert.rejects(archive.renameTitle('legacy', 'Another title', renamed.revision), /changed after/);
    assert.match(fs.readFileSync(filename, 'utf8'), /A manual addition/);
});

test('theme toggles persist without restarting the model or interrupting an active operation', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-theme-'));
    t.after(() => cleanupTestDirectory(home));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    const operation = new AbortController();
    application.operation = operation;
    let stops = 0;
    application.model.stop = () => { stops++; };
    assert.deepEqual(application.theme('dark'), { theme: 'dark' });
    assert.equal(new Config(home).value.theme, 'dark');
    assert.equal(application.operation, operation);
    assert.equal(stops, 0);
    assert.throws(() => application.theme('unknown'), /light or dark/);
    application.theme('light');
    assert.equal(new Config(home).value.theme, 'light');
    const legacySettings = { ...defaults }; delete legacySettings.theme;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(legacySettings));
    assert.equal(new Config(home).value.theme, 'light');
});

test('passages retain exact spans without exceeding tokenizer limits, including Unicode', () => {
    const text = 'Memory 🌿 with original punctuation. '.repeat(70);
    const chunks = chunkText(text, value => Array.from(value).length, 90);
    assert.ok(chunks.length > 2);
    assert.equal(chunks.at(-1).end, text.length);
    for (const chunk of chunks) {
        assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
        assert.ok(Array.from(chunk.text).length <= 90);
        assert.doesNotMatch(chunk.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start <= chunks[i - 1].end);
    const longWord = 'x'.repeat(20000);
    assert.ok(chunkText(longWord, () => 2).length < 15);
});

test('follow-ups use bounded context and source fitting preserves original evidence', async () => {
    const history = [{ role: 'user', content: 'Any magic notes?' }, { role: 'assistant', content: 'A glossary mentions warlocks.' }];
    assert.match(buildQuery('What does it say about them?', history), /glossary mentions warlocks/);
    assert.equal(buildQuery('Any documents about gardening?', history), 'Any documents about gardening?');
    const large = { ...source, content: 'Original source. '.repeat(800) };
    const fitted = await fitSources(result([large]), 600, async text => Array.from(text).length);
    assert.ok(Array.from(JSON.stringify(fitted.documents)).length <= 600);
    assert.ok(large.content.startsWith(fitted.documents[0].content));
    assert.equal(fitted.truncated, true);
});

test('Librarian requests isolate evidence; malformed output, fabricated dialogue, tools and unsupported citations are rejected', () => {
    const retrieved = result([source]);
    const payload = librarianPayload('Trusted instructions', 'Any magic?', 'magic', retrieved);
    assert.deepEqual(payload.messages.map(message => message.role), ['system', 'user']);
    assert.doesNotMatch(payload.messages[0].content, /warlock is/);
    assert.equal('tools' in payload, false); // Transport adapters add only supported options.
    const accepted = validateAnswer(raw({ answer: 'The archive includes a magic glossary.', sources: ['magic'] }), retrieved);
    assert.equal(accepted.sources[0].id, 'magic');
    for (const value of [
        { answer: 'Yes.\nuser: Another question', sources: ['magic'] },
        { answer: 'web_search: invented', sources: ['magic'] },
        { answer: 'Yes.', sources: ['invented'] },
        { answer: 'Yes. [Source: invented]', sources: ['magic'] },
        { answer: 'Yes.', sources: [] },
    ]) assert.throws(() => validateAnswer(raw(value), retrieved));
    const tool = raw({ answer: 'Yes.', sources: ['magic'] }); tool.choices[0].message.tool_calls = [{ function: { name: 'web_search' } }];
    assert.throws(() => validateAnswer(tool, retrieved), /tool operation/);
    const trailing = raw({ answer: 'Yes.', sources: ['magic'] }); trailing.choices[0].message.content += '\nuser\nAnother question';
    assert.throws(() => validateAnswer(trailing, retrieved), /malformed/);
    assert.equal(validateAnswer(raw({ answer: NO_MATCH_ANSWER, sources: [] }), result([])).answer, NO_MATCH_ANSWER);
    assert.throws(() => validateAnswer(raw({ answer: 'Nothing exists.', sources: [] }), result([])), /misrepresented/);
});

test('settings accept optional LM Studio and reject invalid paths, protocols and context sizes', () => {
    assert.equal(validateSettings({ ...defaults, provider: 'lmstudio', lmStudioUrl: 'http://127.0.0.1:1234/v1/' }).apiUrl, 'http://127.0.0.1:1234/v1');
    for (const patch of [{ provider: 'unknown' }, { apiUrl: 'file:///tmp' }, { apiUrl: 'http://user:secret@localhost/v1' }, { contextSize: 100 }, { modelPath: '../model.gguf' }]) assert.throws(() => validateSettings({ ...defaults, ...patch }));
});

test('Archivist validates metadata and retains the original text, including legitimate role labels and Markdown', () => {
    const input = 'My project is named Aletheia.';
    const value = { title: 'Aletheia', summary: 'The project is named Aletheia.', keywords: ['Aletheia'], type: 'Fact' };
    assert.match(validateDraft(raw(value), input), /^# Aletheia/);
    assert.match(validateDraft(raw(value), input), /Source: User-provided information/);
    assert.throws(() => validateDraft(raw({ ...value, summary: 'user\nI work with Rust and Vue.js.' }), input), /invalid document metadata/);
    assert.throws(() => validateDraft(raw({ ...value, title: '# Wrong\nuser' }), input), /invalid document metadata/);
    const trailing = raw(value); trailing.choices[0].message.content += '\nuser\nInvented';
    assert.throws(() => validateDraft(trailing, input), /malformed/);
    const payload = archivistPayload('Trusted instructions', input);
    assert.deepEqual(JSON.parse(payload.messages[1].content), { user_input: input, source_is_excerpt: false });
    assert.equal(payload.response_format.type, 'json_schema');
    assert.equal('content' in payload.response_format.json_schema.schema.properties, false);
    const markdown = '# User text\n\nuser\nThis is a real transcript.\nassistant\nUnderstood.\n\n## Keywords\noriginal\n\n## Metadata\nID: inner-id\nType: Conversation\n';
    assert.ok(validateDraft(raw(value), markdown).includes(markdown));
    const stopped = raw(value); stopped.choices[0].finish_reason = 'length';
    assert.throws(() => validateDraft(stopped, input), /generation limit/);
});

test('long draft inputs use bounded excerpts for metadata and keep the complete source in the rendered document', async () => {
    const content = 'Original information with Unicode 🌱.\n'.repeat(500);
    const fitted = await fitDraftInput('Archive the quoted information.', content, 4096, async text => Buffer.byteLength(text));
    assert.equal(fitted.excerpted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted.payload.messages)) <= 4096 - 1536 - 256);
    const input = JSON.parse(fitted.payload.messages[1].content);
    assert.equal(input.source_is_excerpt, true);
    assert.ok(input.user_input.startsWith(content.slice(0, 100)));
    assert.ok(input.user_input.endsWith(content.slice(-100)));
    const value = { title: 'Original information', summary: 'Selected passages contain original information.', keywords: ['information'], type: 'Reference' };
    assert.ok(validateDraft(raw(value), content).includes(content));
});

test('Prepare document retries one rejected model response and never saves an incomplete result', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-draft-'));
    t.after(() => cleanupTestDirectory(home));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    const input = '# Source\n\nThe bicycle is blue.\n\n## Metadata\nType: Observation\n';
    const metadata = { title: 'Blue bicycle', summary: 'The bicycle is blue.', keywords: ['bicycle'], type: 'Observation' };
    const incomplete = raw(metadata); incomplete.choices[0].finish_reason = 'length';
    let calls = 0;
    application.model = { state: { phase: 'ready' }, start: async () => {}, countTokens: async text => Math.ceil(text.length / 4), complete: async () => ++calls === 1 ? incomplete : raw(metadata) };
    const draft = await application.draft(input);
    assert.equal(calls, 2);
    assert.ok(draft.markdown.includes(input));
    assert.equal(fs.existsSync(path.join(home, 'knowledge')), false);
    calls = 0;
    application.model.complete = async () => { calls++; return incomplete; };
    await assert.rejects(application.draft(input), /generation limit/);
    assert.equal(calls, 2);
});

test('saving and renaming prepared Markdown never rewrite metadata inside the source text', async t => {
    const { archive } = fixture(t);
    const original = '# Workshop\n\n## Content\nThe tire is blue.\n\n## Metadata\nID: original-source-id\nCreated: 2001-01-01\n';
    const value = { title: 'Workshop notes', summary: 'A workshop note records a blue tire.', keywords: ['tire'], type: 'Observation' };
    const saved = await archive.save(validateDraft(raw(value), original));
    assert.notEqual(saved.id, 'original-source-id');
    assert.equal(saved.metadata.id, saved.id);
    assert.ok(saved.content.includes(original));
    const renamed = await archive.renameTitle(saved.id, 'Blue tire', saved.revision);
    assert.ok(renamed.content.includes(original));
    assert.equal(renamed.id, saved.id);
});

test('model downloads resume partial data, verify checksums, and never publish corrupt files', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-download-'));
    t.after(() => cleanupTestDirectory(home));
    const content = Buffer.from('verified model content');
    let range;
    const server = http.createServer((request, response) => {
        range = request.headers.range;
        const start = range ? Number(range.match(/\d+/)[0]) : 0;
        if (range) response.writeHead(206, { 'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}` });
        response.end(content.subarray(start));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close());
    const asset = { url: `http://127.0.0.1:${server.address().port}`, sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
    const destination = path.join(home, 'model.gguf');
    fs.writeFileSync(destination + '.part', content.subarray(0, 5));
    await downloadVerified(asset, destination);
    assert.equal(range, 'bytes=5-');
    assert.deepEqual(fs.readFileSync(destination), content);
    const corrupt = path.join(home, 'corrupt.gguf');
    await assert.rejects(downloadVerified({ ...asset, sha256: '0'.repeat(64) }, corrupt), /integrity/);
    assert.equal(fs.existsSync(corrupt), false);
});

test('API connections request the selected model and accept server-resolved model aliases', async () => {
    const requests = [];
    const config = { value: { ...defaults, provider: 'api', apiUrl: 'http://example.test:1234/v1', apiModel: 'my-instruction-model' } };
    const model = new Model(config, '.', { send: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'qwen3.8-9b-hermes-fc-tooluse' }] } : { model: 'other-model', choices: [] }));
    } });
    await model.start();
    assert.equal(model.state.phase, 'ready');
    assert.equal((await model.complete({ messages: [{ role: 'user', content: 'Test' }], max_tokens: 100 })).model, 'other-model');
    assert.equal(requests[1].url, 'http://example.test:1234/v1/chat/completions');
    assert.equal(JSON.parse(requests[1].options.body).model, 'my-instruction-model');
    await model.stop();
});

test('concurrent refreshes return consistent application snapshots', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-state-'));
    t.after(() => cleanupTestDirectory(home));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    let scans = 0;
    application.archive = { scan: async () => { scans++; await new Promise(resolve => setTimeout(resolve, 10)); return { count: 2 }; }, list: () => [] };
    const states = await Promise.all([application.refresh(), application.refresh()]);
    assert.equal(scans, 1);
    for (const state of states) { assert.equal(state.settings.provider, 'embedded'); assert.equal(state.library.count, 2); }
});
