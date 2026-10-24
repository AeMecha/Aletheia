/** Small OpenAI-compatible Chat Completions transport shared by discovery and
 * generation. It does not require a particular vendor or a /models endpoint. */
export class ApiError extends Error {
    constructor(message, status, parameter) { super(message); this.status = status; this.parameter = parameter; }
}

export async function apiRequest(send, baseUrl, key, route, body, signal, timeout = 180000) {
    const response = await send(baseUrl + route, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]),
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { /* Some servers send plain-text HTTP errors. */ }
    if (!response.ok) {
        const detail = value?.error?.message ?? (typeof value?.error === 'string' ? value.error : undefined) ?? value?.message;
        throw new ApiError(typeof detail === 'string' ? detail.slice(0, 1200) : `The API returned HTTP ${response.status}. Check the address, credentials and selected model.`, response.status, value?.error?.param);
    }
    if (!value || typeof value !== 'object') throw new Error('The API did not return JSON. Use a Chat Completions API base address (usually ending in /v1).');
    return value;
}

// Retry format negotiation only for an explicit unsupported-format HTTP error.
// Authentication, quota, network failures and rejected model output never retry.
export function unsupportedFormat(error) {
    return error instanceof ApiError && [400, 422].includes(error.status)
        && /response_format|json_schema|json_object|structured[ _-]outputs?/i.test(`${error.parameter ?? ''} ${error.message}`);
}

export function completionBody(payload, { model, mode, limit, tokenLimitField = 'max_tokens', local = false, defaultQwen = false }) {
    let messages = payload.messages.map(message => ({ ...message }));
    const schema = payload.response_format?.json_schema?.schema;
    if (mode !== 'json_schema' && schema) {
        // Even servers without constrained decoding receive the exact contract.
        // The existing application validators remain authoritative in every mode.
        const instruction = '\n\nReturn only one JSON object matching this JSON schema, without Markdown fences or extra text: ' + JSON.stringify(schema);
        const index = messages.findIndex(message => message.role === 'system');
        if (index < 0) messages.unshift({ role: 'system', content: instruction.trim() });
        else messages[index].content += instruction;
    }
    return {
        model, messages, stream: false, [tokenLimitField]: limit,
        ...(mode === 'json_schema' && payload.response_format ? { response_format: payload.response_format } : mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
        // External endpoints get a minimal portable request. Qwen's no-thinking
        // option stays confined to the bundled default model, not other models.
        ...(local ? { temperature: 0, top_p: 1, tools: [], tool_choice: 'none', ...(defaultQwen ? { reasoning_effort: 'none' } : {}) } : {}),
    };
}
