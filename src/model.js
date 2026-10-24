/** Embedded mode owns one authenticated loopback llama-server child. Optional
 * LM Studio mode owns no server process. Both enforce the exact model ID. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MODEL_ID } from './config.js';
import { runtimeExecutable } from './runtime.js';

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
            if (settings.provider === 'lmstudio') {
                this.status('loading', 'Connecting to LM Studio…');
                this.baseUrl = settings.lmStudioUrl;
                this.key = settings.apiKey;
                const models = await this.request('/models', undefined, signal);
                if (!models.data?.some(model => model.id === MODEL_ID)) throw new Error(`LM Studio must expose the model ID ${MODEL_ID}. Select or download it there, then reconnect.`);
                this.status('ready', 'Connected to LM Studio', { provider: 'lmstudio', backend: 'external' });
                return;
            }
            if (!settings.modelPath || !fs.existsSync(settings.modelPath)) {
                this.status('setup', 'Choose your existing Qwen model or download it.');
                return;
            }
            const header = Buffer.alloc(4);
            const handle = fs.openSync(settings.modelPath, 'r');
            try { fs.readSync(handle, header, 0, 4, 0); } finally { fs.closeSync(handle); }
            if (header.toString() !== 'GGUF') throw new Error('The selected model is not a GGUF file.');
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
            throw new Error('The built-in engine could not load Qwen. ' + failures.join(' | '));
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
        this.status('loading', backend === 'cpu' ? 'Loading Qwen on the CPU…' : 'Loading Qwen with automatic GPU acceleration…', { backend });
        this.log = '';
        const child = this.launch(executable, [
            '--model', settings.modelPath, '--alias', MODEL_ID,
            '--host', '127.0.0.1', '--port', String(port), '--api-key', this.key,
            '--ctx-size', String(settings.contextSize), '--parallel', '1', '--n-gpu-layers', backend === 'cpu' ? '0' : '99',
            '--jinja', '--reasoning-budget', '0', '--no-webui',
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
                    if (!models.data?.some(model => model.id === MODEL_ID)) throw new Error('The loaded engine did not expose the expected Qwen model.');
                    this.status('ready', backend === 'cpu' ? 'Qwen is ready · CPU' : 'Qwen is ready · GPU acceleration', { provider: 'embedded', backend });
                    return;
                }
            } catch (error) { if (signal.aborted) throw error; }
            await delay(350, undefined, { signal });
        }
        throw new Error('Loading the model timed out. Try CPU mode or a smaller context size.');
    }
    headers() { return { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) }; }
    async request(route, body, signal, timeout = 180000) {
        const response = await this.send(this.baseUrl + route, { method: body ? 'POST' : 'GET', headers: this.headers(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message || value.error || `Model engine returned HTTP ${response.status}.`);
        return value;
    }
    async countTokens(text, signal) {
        if (this.config.value.provider === 'lmstudio') return Buffer.byteLength(text, 'utf8');
        const response = await this.send(this.baseUrl.replace(/\/v1$/, '/tokenize'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ content: text, add_special: false }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10000)]) });
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.tokens)) throw new Error('Could not measure the model context.');
        return value.tokens.length;
    }
    async complete(payload, signal) {
        await this.start();
        if (this.state.phase !== 'ready') throw new Error('Finish model setup before asking Qwen.');
        // UTF-8 bytes are a conservative upper bound in the optional LM Studio path.
        const inputSize = await this.countTokens(JSON.stringify(payload.messages), signal);
        const available = this.config.value.contextSize - inputSize - 128;
        if (available < 256) throw new Error('This request exceeds the selected context size. Increase it in Settings or shorten the input.');
        const raw = await this.request('/chat/completions', { ...payload, max_tokens: Math.min(payload.max_tokens, available), model: MODEL_ID, stream: false }, signal);
        if (raw.model !== MODEL_ID) throw new Error('The engine answered with a different model. No answer was accepted.');
        return raw;
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
