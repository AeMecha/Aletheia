// Exercise metadata generation with short, Markdown and long synthetic sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Config } from '../src/config.js';
import { Model } from '../src/model.js';
import { fitDraftInput, validateDraft } from '../src/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, 'test-output', 'draft-' + randomUUID());
const config = new Config(home);
const lmStudioFlag = process.argv.indexOf('--lmstudio');
config.save({ ...new Config(path.join(root, '.local')).value, autoStart: false, gpu: 'cpu', ...(lmStudioFlag >= 0 ? { provider: 'lmstudio', lmStudioUrl: process.argv[lmStudioFlag + 1] } : {}) });
const model = new Model(config, path.join(root, 'resources'));
const instructions = fs.readFileSync(path.join(root, 'prompts', 'archivist.md'), 'utf8');
const cases = [
    ['short', 'I bought a blue bicycle in Portland on October 12, 2025. It cost $450.'],
    ['markdown', '# Workshop notes\n\n## Summary\nWe repaired a bicycle.\n\n## Content\nThe rear tire was replaced. The new tire is blue.\n\n## Keywords\nbicycle, tire\n\n## Metadata\nType: Observation\n'],
    ['long', Array.from({ length: 105 }, (_, i) => `Workshop observation ${i + 1}: On this visit I recorded the wheel condition, checked the tire pressure, and kept the original handwritten inspection details for future reference.`).join('\n\n')],
];
const evidence = [];
try {
    await model.start();
    for (const [name, input] of cases) {
        const fitted = await fitDraftInput(instructions, input, config.value.contextSize, text => model.countTokens(text));
        const raw = await model.complete(fitted.payload);
        fs.writeFileSync(path.join(home, name + '.response.json'), JSON.stringify(raw, null, 2));
        const record = { name, inputLength: input.length, finishReason: raw.choices?.[0]?.finish_reason, toolCalls: raw.choices?.[0]?.message?.tool_calls?.length || 0, outputLength: raw.choices?.[0]?.message?.content?.length || 0, messageFields: Object.keys(raw.choices?.[0]?.message || {}), usage: raw.usage };
        try { const draft = validateDraft(raw, input); record.accepted = true; record.preservesInput = draft.includes(input); record.sourceExcerpted = fitted.excerpted; }
        catch (error) { record.accepted = false; record.error = error.message; }
        evidence.push(record);
        console.log(JSON.stringify(record));
    }
    fs.writeFileSync(path.join(home, 'verification.json'), JSON.stringify(evidence, null, 2));
    console.log('Evidence: ' + home);
    if (evidence.some(record => !record.accepted)) process.exitCode = 1;
} finally { await model.stop(); }
