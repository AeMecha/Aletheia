// Broad questions must use the complete index, not a semantic top-k search.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/archive.js';
import { Application } from '../src/application.js';
import { isInventoryQuestion, formatInventory } from '../src/inventory.js';
import { runtimeExecutable } from '../src/runtime.js';

function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-inventory-'));
    const archive = new Archive(home, { tokenCount: text => text.length, embed: async () => Array(384).fill(0) });
    t.after(async () => {
        await archive.close();
        assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(home).startsWith('aletheia-inventory-'));
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { archive, home };
}

test('inventory intent recognizes natural broad questions and preserves topical searches', () => {
    for (const question of ['What does my archive contain?', 'What is in my archive?', "What's in the library?", 'Can you tell me what my archive contains?', 'Please show me an overview of my archive.', 'List all my documents', 'What have I saved so far?', 'How many documents do I have?', 'Summarize my archive', 'What topics are covered by the saved documents?']) assert.equal(isInventoryQuestion(question), true, question);
    for (const question of ['What does my archive contain about magic?', 'What is in my archive about gardening?', 'List documents about bicycles', 'What do the saved documents say about projects?', 'What does it say about warlocks?', 'How many documents mention magic?', '', null]) assert.equal(isInventoryQuestion(question), false, String(question));
});

test('existence checks and conversational wrappers are inventory, while filters remain searches', () => {
    for (const question of [
        'Do I have anything in the library?',
        'Can you check if I have anything in the collection?',
        'Could you please check whether I have any saved documents?',
        'Please, tell me if there are any notes in my library.',
        'Can you check to see if the library is empty?',
        'Is my archive empty?', 'Is the collection not empty?',
        'Does my library contain anything?', 'Does this collection have any items?',
        'Are there any documents in our collection?',
        'Is there anything saved in my library?', 'Anything in the library?',
        'Have I saved anything yet?', 'Have we imported any files into the archive?',
        'What do I have in my library?', 'What notes do we have in the collection?',
        'What is stored in the archive?', 'What have I added to my collection?',
        'How many items are in the collection?', "What's in my collection?",
        '  DO   I have anything in the library?!  ',
        'What\u2019s in my library? ', 'Do I have any notes saved, please?',
    ]) assert.equal(isInventoryQuestion(question), true, question);
    for (const question of [
        'Do I have anything about bicycles?',
        'Can you check if I have anything in the library about bicycles?',
        'Do I have any notes on physical limitations?',
        'Is there anything in the collection about memory?',
        'Does my library have any documents mentioning imagination?',
        'Have I saved anything today?', 'What have I added to my collection today?',
        'How many items in the collection mention bicycles?',
        'Is my library empty of references to magic?',
        'Do I have any documents titled Library?',
        'Please check whether the bicycle is in the barn.',
    ]) assert.equal(isInventoryQuestion(question), false, question);
});

test('existence questions refresh real inventory without passage search or generation', async t => {
    const { archive, home } = fixture(t);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    application.archive = archive;
    application.libraryState = { phase: 'ready' };
    application.model.start = async () => { throw new Error('Inventory must not start a model.'); };
    archive.search = async () => { throw new Error('Inventory must not search passages.'); };
    const questions = ['Do I have anything in the library?', 'Can you check if I have anything in the collection?'];
    for (const question of questions) {
        const answer = await application.ask(question);
        assert.match(answer.answer, /archive is empty/);
        assert.equal(answer.search_scope, 'archive_inventory');
        assert.deepEqual(answer.sources, []);
    }
    fs.writeFileSync(path.join(home, 'knowledge', 'external.md'), '# Physical limitations\n\nA reflection on imagination and memory.\n\n## Metadata\nID: existence-note\n');
    for (const question of questions) {
        const answer = await application.ask(question);
        assert.match(answer.answer, /contains 1 document/);
        assert.match(answer.answer, /Physical limitations/);
        assert.equal(answer.search_scope, 'archive_inventory');
        assert.equal(answer.sources[0].id, 'existence-note');
    }
});

test('inventory counts all documents beyond the displayed examples and summarizes real metadata', async t => {
    const { archive, home } = fixture(t);
    for (let index = 0; index < 17; index++) fs.writeFileSync(path.join(home, 'knowledge', `note-${index}.md`), `# Record ${index}\n\nA saved note.\n\n## Metadata\nType: ${index < 10 ? 'Memory' : 'Reference'}\nTopics: Gardening, ${index < 3 ? 'gardening' : 'Bicycles'}\n`);
    await archive.scan();
    const inventory = await archive.inventory();
    assert.equal(inventory.total, 17);
    assert.equal(inventory.documents.length, 12);
    assert.deepEqual(inventory.types.map(row => ({ ...row })), [{ type: 'Memory', count: 10 }, { type: 'Reference', count: 7 }]);
    assert.deepEqual(inventory.topics, [{ topic: 'Gardening', count: 17 }, { topic: 'Bicycles', count: 14 }]);
    const formatted = formatInventory(inventory);
    assert.match(formatted.answer, /17 documents/);
    assert.match(formatted.answer, /12 examples/);
    assert.equal(formatted.sources.length, 12);
    for (const source of formatted.sources) assert.equal(archive.get(source.id).title, source.title);
    // An invalid index must never be represented as a trustworthy empty archive.
    fs.writeFileSync(path.join(home, 'knowledge', 'duplicate.md'), '# Duplicate\n\n## Metadata\nID: note-0\n');
    await assert.rejects(archive.scan(), /Duplicate archive ID/);
    await assert.rejects(archive.inventory(), /Duplicate archive ID/);
});

test('overview is accurate for an empty archive and works with no AI connection', async t => {
    const { archive, home } = fixture(t);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const application = new Application({ home, root, resources: path.join(root, 'resources') });
    application.archive = archive;
    application.libraryState = { phase: 'ready' };
    application.model.start = async () => { throw new Error('Inventory must not start Qwen.'); };
    assert.match((await application.ask('What does my archive contain?')).answer, /archive is empty/);
    const saved = await archive.save('# Blue bicycle\n\nA bicycle note.');
    const answer = await application.ask('What does my archive contain?');
    assert.match(answer.answer, /contains 1 document/);
    assert.match(answer.answer, /Blue bicycle/);
    assert.equal(answer.sources[0].id, saved.id);
    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'conversation.json'), 'utf8'));
    assert.equal(persisted.messages.at(-1).sources[0].id, saved.id);
});

test('runtime selection respects platform, development layout, and backend', t => {
    const { home } = fixture(t);
    assert.equal(runtimeExecutable(home, 'cpu', 'linux', 'x64'), path.join(home, 'runtime/cpu/llama-server'));
    assert.equal(runtimeExecutable(home, 'vulkan', 'win32', 'x64'), path.join(home, 'runtime/vulkan/llama-server.exe'));
    const local = path.join(home, 'runtime/linux-x64/cpu/llama-server');
    fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, 'fixture');
    assert.equal(runtimeExecutable(home, 'cpu', 'linux', 'x64'), local);
    assert.throws(() => runtimeExecutable(home, '../cpu', 'linux', 'x64'), /Unsupported/);
    assert.throws(() => runtimeExecutable(home, 'cpu', 'darwin', 'x64'), /Unsupported/);
});
