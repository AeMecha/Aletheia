/** Check a user-selected local GGUF without copying it or modifying its profile.
 * Only synthetic text is submitted; the owned CPU engine closes on every path.
 * Usage: node scripts/model-smoke.js /absolute/path/to/model.gguf */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults } from '../src/config.js';
import { Model } from '../src/model.js';
import { archivistPayload, validateDraft, librarianPayload, validateAnswer } from '../src/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Pass an absolute GGUF model path.');
const model = new Model({ value: { ...defaults, modelPath: path.resolve(process.argv[2]), gpu: 'cpu', contextSize: 4096 } }, path.join(root, 'resources'));
model.on('status', state => console.log(state.message));
const original = 'This synthetic verification note records a blue bicycle in a green barn.';
try {
    await model.start();
    const draft = await model.complete(archivistPayload('Prepare faithful archive metadata.', original));
    if (!validateDraft(draft, original).includes(original)) throw new Error('The original text was not retained.');
    const retrieval = { success: true, documents: [{ id: 'synthetic-note', title: 'Bicycle note', content: original, is_excerpt: false }], search_scope: 'hybrid_top_k', truncated: false };
    const raw = await model.complete(librarianPayload('Answer using only supplied sources.', 'What color is the bicycle?', 'bicycle', retrieval));
    validateAnswer(raw, retrieval);
    console.log(JSON.stringify({ passed: true, model: path.basename(process.argv[2]), draftFinish: draft.choices[0].finish_reason, answerFinish: raw.choices[0].finish_reason, sourceIds: ['synthetic-note'] }));
} finally { await model.stop(); }
