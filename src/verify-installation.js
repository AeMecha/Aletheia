// Opt-in packaged-app verification. A dedicated profile is mandatory. Archive
// mode checks native search and real IPC without downloading the 5.5 GB GGUF.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyInstallation(window, application, { archiveOnly = false } = {}) {
    if (!process.env.ALETHEIA_HOME) throw new Error('Installation verification requires an isolated ALETHEIA_HOME.');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const originalLicense = fs.readFileSync(path.join(root, 'LICENSES', 'LicenseRef-AdeptTel1-Aletheia.txt'));
    if (createHash('sha256').update(originalLicense).digest('hex') !== '4499fd097ee95e3b0cfdd5cd852156f2ab57fcb2fb9824453729884d2d4e7416') throw new Error('The packaged original-author license is missing or altered.');
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
        if (application.model.state.phase !== 'ready') throw new Error('Configure an AI model in the isolated test profile.');
        const raw = await application.model.complete({ messages: [{ role: 'system', content: 'Reply with exactly one JSON object: {"ready":true}.' }, { role: 'user', content: 'Verify the local installation.' }], max_tokens: 64, temperature: 0, reasoning_effort: 'none', tools: [], tool_choice: 'none', response_format: { type: 'json_schema', json_schema: { name: 'installation', strict: true, schema: { type: 'object', properties: { ready: { type: 'boolean', const: true } }, required: ['ready'], additionalProperties: false } } } });
        if (JSON.parse(raw.choices?.[0]?.message?.content).ready !== true) throw new Error('The configured model did not answer correctly.');
    }
    await delay(300);
    const renderer = await window.webContents.executeJavaScript('({title:document.title, bridge:typeof window.aletheia.ask, node:typeof require})');
    if (renderer.title !== 'Aletheia Scriptorium' || renderer.bridge !== 'function' || renderer.node !== 'undefined') throw new Error('The packaged renderer or preload bridge did not initialize.');
    fs.writeFileSync(path.join(application.home, 'packaged-verification.json'), JSON.stringify({ passed: true, model: archiveOnly ? 'not tested in archive-only mode' : application.model.state.model, engine: application.model.state, embeddings: embedding.length, renderer, inventory }, null, 2));
    // Virtual displays can need a few frames before Chromium's compositor has a
    // capturable surface. Require an actual image while allowing that short delay.
    window.show();
    let screenshot;
    for (let attempt = 0; attempt < 5; attempt++) {
        await delay(500);
        try {
            screenshot = await window.webContents.capturePage(undefined, { stayAwake: true });
            if (screenshot.isEmpty()) throw new Error('The packaged window capture is empty.');
            break;
        } catch (error) { if (attempt === 4) throw error; }
    }
    fs.writeFileSync(path.join(application.home, 'packaged-window.png'), screenshot.toPNG());
    console.log(archiveOnly ? 'PASS: packaged archive inventory, native search model, SQLite library and isolated renderer.' : 'PASS: packaged executable, configured AI model, native search model, SQLite library and isolated renderer.');
}
