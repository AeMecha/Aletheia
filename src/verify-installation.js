// Opt-in packaged-app verification. A dedicated profile is mandatory. Archive
// mode checks native search and real IPC without downloading the 5.5 GB GGUF.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MODEL_ID } from './config.js';

export async function verifyInstallation(window, application, { archiveOnly = false } = {}) {
    if (!process.env.ALETHEIA_HOME) throw new Error('Installation verification requires an isolated ALETHEIA_HOME.');
    const embedding = await application.embedder.embed('Aletheia installation verification.');
    if (embedding.length !== 384) throw new Error('The packaged search model did not return 384 dimensions.');
    let inventory;
    if (archiveOnly) {
        if (application.archive.list().length) throw new Error('Archive verification requires a new empty test profile.');
        const saved = await application.archive.save('# Packaged archive verification\n\nThis synthetic document records a blue bicycle.\n\n## Metadata\nType: Observation\nTopics: Bicycles\n');
        await delay(300);
        inventory = await window.webContents.executeJavaScript('window.aletheia.ask("What does my archive contain?")');
        if (!inventory.answer.includes('contains 1 document.') || inventory.sources[0]?.id !== saved.id) throw new Error('Packaged archive inventory or IPC failed.');
    } else {
        await application.model.start();
        if (application.model.state.phase !== 'ready') throw new Error('Configure the Qwen model in the isolated test profile.');
        const raw = await application.model.complete({ messages: [{ role: 'system', content: 'Reply with exactly one JSON object: {"ready":true}.' }, { role: 'user', content: 'Verify the local installation.' }], max_tokens: 64, temperature: 0, reasoning_effort: 'none', tools: [], tool_choice: 'none', response_format: { type: 'json_schema', json_schema: { name: 'installation', strict: true, schema: { type: 'object', properties: { ready: { type: 'boolean', const: true } }, required: ['ready'], additionalProperties: false } } } });
        if (raw.model !== MODEL_ID || JSON.parse(raw.choices?.[0]?.message?.content).ready !== true) throw new Error('The packaged Qwen engine did not answer correctly.');
    }
    await delay(300);
    const renderer = await window.webContents.executeJavaScript('({title:document.title, bridge:typeof window.aletheia.ask, node:typeof require})');
    if (renderer.title !== 'Aletheia' || renderer.bridge !== 'function' || renderer.node !== 'undefined') throw new Error('The packaged renderer or preload bridge did not initialize.');
    fs.writeFileSync(path.join(application.home, 'packaged-verification.json'), JSON.stringify({ passed: true, model: archiveOnly ? 'not tested in archive-only mode' : MODEL_ID, engine: application.model.state, embeddings: embedding.length, renderer, inventory }, null, 2));
    fs.writeFileSync(path.join(application.home, 'packaged-window.png'), (await window.webContents.capturePage()).toPNG());
    console.log(archiveOnly ? 'PASS: packaged archive inventory, native search model, SQLite library and isolated renderer.' : 'PASS: packaged executable, local Qwen engine, native search model, SQLite library and isolated renderer.');
}
