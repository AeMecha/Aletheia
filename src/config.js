/** Validate persisted preferences at the boundary. Defaults fill missing fields
 * in older profiles so updates preserve existing model and data settings. */
import fs from 'node:fs';
import path from 'node:path';

// Qwen is a convenient default download, not a restriction on selected models.
export const DEFAULT_MODEL_ID = 'qwen3.8-9b-hermes-fc-tooluse';
export const DEFAULT_MODEL_FILENAME = DEFAULT_MODEL_ID + '.Q4_K_S.gguf';
export const LOCAL_MODEL_ID = 'aletheia-local';
export const defaults = Object.freeze({ provider: 'embedded', modelPath: '', contextSize: 16384, outputTokens: 1536, gpu: 'auto', apiUrl: 'http://127.0.0.1:1234/v1', apiModel: DEFAULT_MODEL_ID, apiKey: '', responseMode: 'auto', tokenLimitField: 'max_tokens', autoStart: true, theme: 'light' });

export function validateApiConnection(value) {
    let url;
    try { url = new URL(value.apiUrl); } catch { throw new Error('Enter a valid API base address, including its API path (usually /v1).'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS API base address without credentials or query parameters.');
    if (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\r\n]/.test(value.apiKey)) throw new Error('Invalid API key.');
    return { apiUrl: url.href.replace(/\/+$/, ''), apiKey: value.apiKey };
}

export function validateSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
    // Migrate v0.1.x profiles before applying defaults so a custom LM Studio URL
    // and the existing selected file survive the update without a reset.
    value = { ...defaults, ...value, ...(value.provider === 'lmstudio' ? { provider: 'api', apiUrl: value.lmStudioUrl ?? value.apiUrl ?? defaults.apiUrl } : {}) };
    if (!['embedded', 'api'].includes(value.provider)) throw new Error('Choose a local model or an API connection.');
    if (!['auto', 'cpu'].includes(value.gpu)) throw new Error('Choose automatic acceleration or CPU.');
    const theme = value.theme ?? 'light';
    if (!['light', 'dark'].includes(theme)) throw new Error('Choose light or dark mode.');
    if (!Number.isInteger(value.contextSize) || value.contextSize < 4096 || value.contextSize > 262144) throw new Error('Context size must be between 4,096 and 262,144.');
    if (!Number.isInteger(value.outputTokens) || value.outputTokens < 256 || value.outputTokens > 32768) throw new Error('Response token budget must be between 256 and 32,768.');
    if (typeof value.modelPath !== 'string' || (value.modelPath && (!path.isAbsolute(value.modelPath) || path.extname(value.modelPath).toLowerCase() !== '.gguf'))) throw new Error('Choose a local GGUF model file.');
    const connection = validateApiConnection(value);
    if (typeof value.apiModel !== 'string' || value.apiModel.length > 512 || /[\r\n\x00-\x1f]/.test(value.apiModel) || (value.provider === 'api' && !value.apiModel.trim())) throw new Error('Enter the API model ID, or fetch the available models.');
    if (!['auto', 'json_schema', 'json_object', 'prompt'].includes(value.responseMode)) throw new Error('Choose a supported response format.');
    if (!['max_tokens', 'max_completion_tokens'].includes(value.tokenLimitField) || typeof value.autoStart !== 'boolean') throw new Error('Invalid connection settings.');
    return { provider: value.provider, modelPath: value.modelPath, contextSize: value.contextSize, outputTokens: value.outputTokens, gpu: value.gpu, ...connection, apiModel: value.apiModel.trim(), responseMode: value.responseMode, tokenLimitField: value.tokenLimitField, autoStart: value.autoStart, theme };
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
        this.value = fs.existsSync(this.filename) ? validateSettings(JSON.parse(fs.readFileSync(this.filename, 'utf8'))) : { ...defaults };
    }
    save(value) { this.value = validateSettings(value); atomicJson(this.filename, this.value); return this.value; }
}
