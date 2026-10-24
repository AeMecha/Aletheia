/** Offline BGE vectors are separate from Qwen generation. Bundled q8 weights,
 * mean pooling and normalization match the search index version. */
import path from 'node:path';

export class Embeddings {
    constructor(directory) { this.directory = directory; }
    async initialize() {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowRemoteModels = false;
        this.extractor = await pipeline('feature-extraction', path.resolve(this.directory) + path.sep, {
            dtype: 'q8', device: 'cpu', local_files_only: true,
            session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
        });
    }
    tokenCount(text) { return this.extractor.tokenizer.encode(text).length; }
    async embed(text, query = false) {
        // Apply the BGE retrieval prefix to queries only, exactly once.
        const result = await this.extractor((query ? 'Represent this sentence for searching relevant passages: ' : '') + text, { pooling: 'mean', normalize: true, truncation: true });
        return Array.from(result.data);
    }
    async close() { await this.extractor?.dispose(); }
}

export function chunkText(text, countTokens, size = 240) {
    // Binary-search token-bounded spans; keep offsets into the original Unicode text.
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let low = 1;
        let high = Math.min(text.length - start, 4000);
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (countTokens(text.slice(start, start + mid)) <= size) low = mid;
            else high = mid - 1;
        }
        let end = start + low;
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        if (end <= start) throw new Error('Could not split an archive document into retrieval passages.');
        chunks.push({ start, end, text: text.slice(start, end) });
        if (end === text.length) break;
        // Keep at most 40 overlapping tokens, preserving exact original spans.
        let overlap = end;
        const minimumStart = start + Math.max(1, Math.floor((end - start) / 2));
        while (overlap > minimumStart && countTokens(text.slice(overlap - 1, end)) <= 40) overlap--;
        if (/[\uDC00-\uDFFF]/.test(text[overlap])) overlap++;
        start = Math.max(minimumStart, overlap);
    }
    return chunks;
}
