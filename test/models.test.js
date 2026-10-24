/** Exercise model selection and actual transport payloads with synthetic GGUF
 * headers and HTTP responses. No user model, archive, credentials or API is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Config, defaults, DEFAULT_MODEL_ID, DEFAULT_MODEL_FILENAME, LOCAL_MODEL_ID, validateSettings } from '../src/config.js';
import { Model } from '../src/model.js';
import { Application } from '../src/application.js';
import { validateGguf } from '../src/gguf.js';
import { librarianPayload, validateAnswer, archivistPayload, validateDraft } from '../src/protocol.js';

function directory(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-model-test-'));
    t.after(() => {
        const target = path.resolve(home);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('aletheia-model-test-'));
        fs.rmSync(target, { recursive: true, force: true });
    });
    return home;
}
function gguf(home, name = 'another-instruct.Q4_K_M.gguf') {
    const filename = path.join(home, name);
    const bytes = Buffer.alloc(24); bytes.write('GGUF'); bytes.writeUInt32LE(3, 4);
    fs.writeFileSync(filename, bytes);
    return filename;
}
const source = { id: 'real-note', title: 'Bicycle', content: 'The bicycle is blue.', is_excerpt: false };
const retrieval = { success: true, documents: [source], search_scope: 'hybrid_top_k', truncated: false };
const payload = () => librarianPayload('Use the supplied archive.', 'What color?', 'bicycle', retrieval);
const response = content => ({ model: 'provider/resolved-model-2026', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const apiSettings = patch => ({ value: validateSettings({ ...defaults, provider: 'api', apiUrl: 'https://models.example.test/custom/v1', apiModel: 'org/selected-chat-model:latest', ...patch }) });

test('legacy LM Studio settings migrate without losing a custom endpoint, key, file, or theme', t => {
    const home = directory(t);
    const filename = gguf(home);
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ provider: 'lmstudio', lmStudioUrl: 'http://192.0.2.1:1234/v1/', apiKey: 'synthetic-test-key', modelPath: filename, contextSize: 8192, gpu: 'cpu', autoStart: false, theme: 'dark' }));
    const config = new Config(home);
    assert.equal(config.value.provider, 'api');
    assert.equal(config.value.apiUrl, 'http://192.0.2.1:1234/v1');
    assert.equal(config.value.apiModel, DEFAULT_MODEL_ID);
    assert.equal(config.value.apiKey, 'synthetic-test-key');
    assert.equal(config.value.modelPath, filename);
    assert.equal(config.value.theme, 'dark');
    config.save(config.value);
    assert.deepEqual(new Config(home).value, config.value);
    assert.equal('lmStudioUrl' in config.value, false);
    assert.throws(() => validateSettings({ ...defaults, provider: 'api', apiModel: ' ' }), /model ID/);
});

test('selecting any supported GGUF container preserves the default download and rejects invalid files before stopping', async t => {
    const home = directory(t);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    const downloaded = application.manifest.model.sha256;
    const filename = gguf(home);
    let stops = 0; let starts = 0;
    application.model = { state: { phase: 'stopped' }, stop: async () => { stops++; }, start: async () => { starts++; } };
    await application.selectModel(filename);
    assert.equal(application.config.value.modelPath, filename);
    assert.equal(application.config.value.provider, 'embedded');
    assert.equal(starts, 1); assert.equal(stops, 1);
    assert.equal(application.manifest.model.sha256, downloaded);
    const bad = path.join(home, 'not-a-model.gguf'); fs.writeFileSync(bad, 'bad');
    await assert.rejects(application.selectModel(bad), /GGUF/);
    assert.equal(stops, 1);
    assert.equal(application.config.value.modelPath, filename);
    assert.throws(() => validateGguf(path.join(home, 'other.safetensors')), /GGUF/);
});

test('local models use a generic alias, their own file and chat template, and no Qwen reasoning override', async t => {
    const home = directory(t);
    const filename = gguf(home);
    const config = { value: { ...defaults, modelPath: filename, gpu: 'cpu' } };
    const runtime = path.join(home, 'runtime', 'cpu'); fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), 'synthetic runtime');
    let args; let completion; let completions = 0;
    const model = new Model(config, home, {
        launch: (_executable, argv) => {
            args = argv;
            const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
            return child;
        },
        send: async (url, options) => {
            if (url.endsWith('/health')) return json({ status: 'ok' });
            if (url.endsWith('/models')) return json({ data: [{ id: LOCAL_MODEL_ID }] });
            if (url.endsWith('/tokenize')) return json({ tokens: [1, 2, 3] });
            completion = JSON.parse(options.body);
            if (!completions++) return json({ error: { message: 'Failed to initialize samplers: Unexpected empty grammar stack' } }, 400);
            return json({ ...response({ answer: 'The bicycle is blue.', sources: [source.id] }), model: LOCAL_MODEL_ID });
        },
    });
    t.after(() => model.stop());
    await model.start();
    assert.equal(args[args.indexOf('--model') + 1], filename);
    assert.equal(args[args.indexOf('--alias') + 1], LOCAL_MODEL_ID);
    assert.ok(args.includes('--jinja'));
    assert.ok(!args.includes('--reasoning-budget'));
    assert.equal(model.state.model, path.basename(filename));
    validateAnswer(await model.complete(payload()), retrieval);
    assert.equal(model.negotiatedFormat, 'json_object');
    assert.equal(completion.model, LOCAL_MODEL_ID);
    assert.equal('reasoning_effort' in completion, false);
    // The pinned default keeps the previously verified no-thinking behavior.
    config.value.modelPath = gguf(home, DEFAULT_MODEL_FILENAME);
    await model.stop(); await model.start();
    assert.ok(args.includes('--reasoning-budget'));
    await model.complete(payload());
    assert.equal(completion.reasoning_effort, 'none');
});

test('manual API model works without discovery, includes auth, and accepts a resolved response alias', async () => {
    const requests = [];
    const config = apiSettings({ apiKey: 'synthetic-test-key', tokenLimitField: 'max_completion_tokens', outputTokens: 4096 });
    const model = new Model(config, '.', { send: async (url, options) => {
        requests.push({ url, options });
        return url.endsWith('/models') ? json({ error: { message: 'Not found' } }, 404) : json(response({ answer: 'The bicycle is blue.', sources: [source.id] }));
    } });
    await model.start();
    assert.equal(model.state.phase, 'ready');
    validateAnswer(await model.complete(payload()), retrieval);
    const request = requests.at(-1);
    assert.equal(request.url, config.value.apiUrl + '/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key');
    assert.equal(request.options.redirect, 'error');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, config.value.apiModel);
    assert.equal(body.max_completion_tokens, 4096);
    for (const key of ['max_tokens', 'reasoning_effort', 'tools', 'tool_choice', 'temperature', 'top_p']) assert.equal(key in body, false);
    await model.stop();
});

test('format negotiation falls back only on HTTP format rejection, caches success, and retains citation validation', async () => {
    const formats = [];
    const model = new Model(apiSettings(), '.', { send: async (url, options) => {
        if (url.endsWith('/models')) return json({ data: [] });
        const body = JSON.parse(options.body); const mode = body.response_format?.type ?? 'prompt'; formats.push(mode);
        if (mode !== 'prompt') return json({ error: { message: 'Unsupported response_format', param: 'response_format' } }, 400);
        assert.match(body.messages[0].content, /JSON schema/);
        assert.match(body.messages[0].content, /real-note/);
        return json(response({ answer: 'The bicycle is blue.', sources: ['invented-source'] }));
    } });
    const first = await model.complete(payload());
    assert.deepEqual(formats, ['json_schema', 'json_object', 'prompt']);
    assert.throws(() => validateAnswer(first, retrieval), /unavailable source/);
    await model.complete(payload()); assert.deepEqual(formats, ['json_schema', 'json_object', 'prompt', 'prompt']);
    await model.stop();
});

test('authorization, quota, malformed output, and explicit format failures do not trigger negotiation retries', async () => {
    for (const [status, message] of [[401, 'Unauthorized response_format'], [429, 'Quota exceeded'], [500, 'response_format error']]) {
        let calls = 0;
        const model = new Model(apiSettings(), '.', { send: async url => url.endsWith('/models') ? json({ data: [] }) : (calls++, json({ error: { message } }, status)) });
        await assert.rejects(model.complete(payload()), new RegExp(message));
        assert.equal(calls, 1); await model.stop();
    }
    let calls = 0;
    const model = new Model(apiSettings({ responseMode: 'json_schema' }), '.', { send: async url => url.endsWith('/models') ? json({ data: [] }) : (calls++, json({ error: { message: 'Unsupported response_format' } }, 400)) });
    await assert.rejects(model.complete(payload()), /Unsupported/); assert.equal(calls, 1); await model.stop();
    const malformed = new Model(apiSettings(), '.', { send: async url => url.endsWith('/models') ? json({ data: [] }) : (calls++, json(response('not a JSON answer'))) });
    calls = 0;
    assert.throws(() => validateAnswer(response('not a JSON answer'), retrieval), /invalid answer/);
    const raw = await malformed.complete(payload()); assert.throws(() => validateAnswer(raw, retrieval), /invalid answer/);
    assert.equal(calls, 1); await malformed.stop();
});

test('model discovery uses unsaved connection settings, and draft validation still preserves original input', async () => {
    const config = apiSettings();
    const model = new Model(config, '.', { send: async (url, options) => {
        if (url.startsWith('http://localhost:11434/v1/')) {
            assert.equal(options.headers.Authorization, undefined);
            return json({ data: [{ id: 'other:7b' }, { id: 'other:7b' }, { id: 'text:small' }, { id: null }] });
        }
        if (url.endsWith('/models')) return json({ data: [] });
        const body = JSON.parse(options.body);
        assert.equal(body.model, config.value.apiModel);
        return json(response({ title: 'Bicycle note', summary: 'The bicycle is blue.', keywords: ['bicycle'], type: 'Observation' }));
    } });
    assert.deepEqual(await model.models({ apiUrl: 'http://localhost:11434/v1', apiKey: '' }), ['other:7b', 'text:small']);
    assert.equal(model.state.phase, 'stopped');
    const input = '# Original\n\nThe bicycle is blue.';
    assert.ok(validateDraft(await model.complete(archivistPayload('Prepare metadata.', input)), input).includes(input));
    await model.stop();
});
