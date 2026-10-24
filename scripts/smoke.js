// Real-model integration check: isolated synthetic archive, retrieval and drafting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Application } from '../src/application.js';
import { Config } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, 'test-output', 'smoke-' + randomUUID());
const config = new Config(home);
const localSettings = new Config(path.join(root, '.local')).value;
const lmStudioFlag = process.argv.indexOf('--lmstudio');
config.save({ ...localSettings, ...(lmStudioFlag >= 0 ? { provider: 'lmstudio', lmStudioUrl: process.argv[lmStudioFlag + 1] } : {}), autoStart: false });
const application = new Application({ home, root, resources: path.join(root, 'resources') });
application.on('state', state => {
    const status = state.progress?.message || state.model.message;
    if (status !== application.lastLog) { console.log(status); application.lastLog = status; }
});
const evidence = {};
try {
    await application.initialize();
    const saved = await application.save('# Glossary of magic\n\nA warlock is a practitioner of magic. This glossary describes warlocks, witches, sorcerers, cantrips and incantations.\n\n## Metadata\n\nType: Reference\n');
    const hit = await application.archive.search('Do you have any entries on warlocks?');
    assert.equal(hit.results[0]?.id, saved.id);
    evidence.search = { foundWarlock: true, search_scope: hit.search_scope };
    await application.model.start();
    assert.equal(application.model.state.phase, 'ready');
    evidence.model = application.model.state;
    evidence.magic = await application.ask('Do you have any documents on magic?');
    assert.ok(evidence.magic.sources.some(source => source.id === saved.id));
    evidence.followup = await application.ask('What does it say about warlocks?');
    assert.ok(evidence.followup.sources.some(source => source.id === saved.id));
    evidence.gardening = await application.ask('Do you have any documents about growing tomatoes in a garden?');
    assert.deepEqual(evidence.gardening.sources, []);
    evidence.draft = await application.draft('My library project is named Aletheia. I want my notes to stay on my own computer.');
    assert.match(evidence.draft.markdown, /Aletheia/);
    const draftSaved = await application.save(evidence.draft.markdown);
    assert.ok(draftSaved.id);
    evidence.draftSaved = draftSaved.id;
    fs.writeFileSync(path.join(home, 'verification.json'), JSON.stringify(evidence, null, 2));
    console.log('PASS: local model, hybrid retrieval, cited answer, follow-up, unrelated query, Archivist draft and save.');
    console.log('Evidence: ' + path.join(home, 'verification.json'));
} catch (error) {
    console.error(error);
    console.error(application.model.log);
    process.exitCode = 1;
} finally { await application.close(); }
