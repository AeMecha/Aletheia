/** Validate persisted preferences at the boundary. Defaults fill missing fields
 * in older profiles so updates preserve existing model and data settings. */
import fs from 'node:fs';
import path from 'node:path';

export const MODEL_ID = 'qwen3.8-9b-hermes-fc-tooluse';
export const defaults = Object.freeze({ provider: 'embedded', modelPath: '', contextSize: 16384, gpu: 'auto', lmStudioUrl: 'http://127.0.0.1:1234/v1', apiKey: '', autoStart: true, theme: 'light' });

export function validateSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
    if (!['embedded', 'lmstudio'].includes(value.provider)) throw new Error('Choose the built-in engine or LM Studio.');
    if (!['auto', 'cpu'].includes(value.gpu)) throw new Error('Choose automatic acceleration or CPU.');
    const theme = value.theme ?? 'light';
    if (!['light', 'dark'].includes(theme)) throw new Error('Choose light or dark mode.');
    if (!Number.isInteger(value.contextSize) || value.contextSize < 4096 || value.contextSize > 32768) throw new Error('Context size must be between 4,096 and 32,768.');
    if (typeof value.modelPath !== 'string' || (value.modelPath && (!path.isAbsolute(value.modelPath) || path.extname(value.modelPath).toLowerCase() !== '.gguf'))) throw new Error('Choose a local GGUF model file.');
    let url;
    try { url = new URL(value.lmStudioUrl); } catch { throw new Error('Enter a valid LM Studio API address.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS LM Studio API address.');
    if (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || typeof value.autoStart !== 'boolean') throw new Error('Invalid connection settings.');
    return { provider: value.provider, modelPath: value.modelPath, contextSize: value.contextSize, gpu: value.gpu, lmStudioUrl: url.href.replace(/\/+$/, ''), apiKey: value.apiKey, autoStart: value.autoStart, theme };
}

export function atomicJson(filename, value) {
    // Replace in the same directory to avoid truncated settings/conversation files.
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = filename + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, filename);
}

export class Config {
    constructor(home) {
        this.home = home;
        this.filename = path.join(home, 'settings.json');
        fs.mkdirSync(home, { recursive: true });
        this.value = fs.existsSync(this.filename) ? validateSettings({ ...defaults, ...JSON.parse(fs.readFileSync(this.filename, 'utf8')) }) : { ...defaults };
    }
    save(value) { this.value = validateSettings(value); atomicJson(this.filename, this.value); return this.value; }
}
