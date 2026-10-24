import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { once } from 'node:events';
import { Config } from '../src/config.js';

// Runs inside Electron against the real preload bridge and renderer, using a
// dedicated test profile. It is not shipped in the installed application.
export async function desktopSmoke(window, application) {
    const output = path.join(application.root, 'test-output', 'desktop');
    fs.mkdirSync(output, { recursive: true });
    const script = source => window.webContents.executeJavaScript(source);
    const errors = [];
    window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(await script('Boolean(window.aletheia && document.getElementById("view-librarian"))'))) await delay(100);
    window.show();
    await delay(300);
    assert.equal(await script('typeof window.aletheia.ask'), 'function');
    assert.equal(await script('typeof require'), 'undefined');
    assert.equal(await script('document.getElementById("setup-banner").hidden'), false);
    const screenshot = async name => { await delay(150); fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
    await screenshot('first-run');
    assert.equal(await script('Boolean(document.querySelector(".sidebar-note"))'), false);
    await script('document.getElementById("theme-toggle").click()');
    for (let attempt = 0; attempt < 100 && application.config.value.theme !== 'dark'; attempt++) await delay(20);
    assert.equal(new Config(application.home).value.theme, 'dark');
    assert.equal(await script('document.documentElement.dataset.theme'), 'dark');
    await screenshot('dark-librarian');
    await window.webContents.reload();
    await delay(350);
    assert.equal(await script('document.documentElement.dataset.theme'), 'dark');
    await script('document.querySelector(".nav-item[data-view=archivist]").click()');
    await script('document.getElementById("archive-input").value = "# Desktop verification\\n\\nThis is an isolated Aletheia interface test. It mentions a green barn."; document.getElementById("archive-input").dispatchEvent(new Event("input"))');
    assert.equal(await script('document.getElementById("save-original").disabled'), false);
    await script('document.getElementById("save-original").click()');
    for (let attempt = 0; attempt < 100; attempt++) {
        if (application.archive.list().length && !application.operation) break;
        await delay(100);
    }
    assert.equal(application.archive.list().length, 1);
    // Inventory works before any model is configured, through the real IPC path.
    await script('document.querySelector(".nav-item[data-view=librarian]").click(); document.getElementById("archive-overview").click()');
    for (let attempt = 0; attempt < 100; attempt++) {
        if (application.chat.messages.length && !application.operation) break;
        await delay(100);
    }
    assert.match(application.chat.messages.at(-1).content, /Your archive contains 1 document\./);
    assert.equal(application.chat.messages.at(-1).sources[0].id, application.archive.list()[0].id);
    assert.ok(['setup', 'stopped'].includes(application.model.state.phase));
    assert.match(await script('document.getElementById("conversation").textContent'), /Desktop verification/);
    await screenshot('archive-overview-no-model');
    await script('document.querySelector(".nav-item[data-view=archivist]").click()');
    await screenshot('archivist');
    await script('document.querySelector(".nav-item[data-view=library]").click()');
    assert.equal(await script('document.querySelectorAll(".document-row").length'), 1);
    await screenshot('library');
    await script('document.querySelector(".document-row").click()');
    await delay(200);
    assert.equal(await script('document.getElementById("document-dialog").open'), true);
    assert.match(await script('document.getElementById("document-content").textContent'), /green barn/);
    await screenshot('original-document');
    const documentId = application.archive.list()[0].id;
    await script('document.getElementById("edit-title").click(); document.getElementById("title-input").value = "Renamed archive document"; document.getElementById("title-input").dispatchEvent(new Event("input")); document.getElementById("title-form").requestSubmit()');
    for (let attempt = 0; attempt < 100; attempt++) { if (application.archive.list()[0].title === 'Renamed archive document' && !application.operation) break; await delay(100); }
    assert.equal(application.archive.get(documentId).title, 'Renamed archive document');
    assert.equal(await script('document.getElementById("document-title").textContent'), 'Renamed archive document');
    assert.match(await script('document.getElementById("document-content").textContent'), /green barn/);
    await screenshot('renamed-document-dark');
    await script('document.getElementById("close-document").click(); document.querySelector(".nav-item[data-view=settings]").click()');
    await script('document.querySelector("input[name=provider][value=api]").click()');
    assert.equal(await script('document.getElementById("api-options").hidden'), false);
    await script('document.getElementById("api-preset").value = "ollama"; document.getElementById("api-preset").dispatchEvent(new Event("change"))');
    assert.equal(await script('document.getElementById("api-url").value'), 'http://localhost:11434/v1');
    assert.equal(await script('document.getElementById("api-model").value'), '');
    await script('document.getElementById("response-mode").value = "prompt"; document.querySelector(".compatibility-options").open = true');
    await screenshot('settings-api');
    await script('document.getElementById("api-url").value = "http://example.test:1234/v1"; document.getElementById("api-model").value = "another-chat-model"');
    await script('document.getElementById("theme-toggle").click()');
    for (let attempt = 0; attempt < 100 && application.config.value.theme !== 'light'; attempt++) await delay(20);
    assert.equal(new Config(application.home).value.theme, 'light');
    assert.equal(await script('document.getElementById("api-url").value'), 'http://example.test:1234/v1');
    assert.equal(await script('document.getElementById("api-model").value'), 'another-chat-model');
    assert.equal(await script('document.getElementById("response-mode").value'), 'prompt');
    await screenshot('settings-light');
    // A local synthetic API exercises discovery, persisted selection, drafting
    // and cited answers through the actual renderer -> IPC -> HTTP path. It has
    // no connection to the user's model server and receives only our fixture.
    const requests = [];
    const server = http.createServer(async (request, reply) => {
        reply.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/models') { reply.end(JSON.stringify({ data: [{ id: 'test/other-instruct' }] })); return; }
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); requests.push(body);
        const input = JSON.parse(body.messages.at(-1).content);
        const content = input.retrieval
            ? { answer: 'The verification document mentions a green barn.', sources: [input.retrieval.documents[0].id] }
            : { title: 'API verification', summary: 'This is a synthetic API document.', keywords: ['verification'], type: 'Observation' };
        reply.end(JSON.stringify({ model: 'test/other-instruct-resolved', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        await script(`document.getElementById('api-url').value = 'http://127.0.0.1:${server.address().port}/v1'; document.getElementById('api-model').value = ''; document.getElementById('fetch-models').click()`);
        for (let attempt = 0; attempt < 100 && await script('document.getElementById("api-model").value') !== 'test/other-instruct'; attempt++) await delay(50);
        assert.equal(await script('document.getElementById("api-model").value'), 'test/other-instruct');
        await script('document.getElementById("output-tokens").value = "4096"; document.getElementById("settings-form").requestSubmit()');
        for (let attempt = 0; attempt < 100 && application.model.state.phase !== 'ready'; attempt++) await delay(50);
        assert.equal(application.config.value.provider, 'api');
        assert.equal(new Config(application.home).value.apiModel, 'test/other-instruct');
        assert.equal(new Config(application.home).value.outputTokens, 4096);
        assert.equal(application.model.state.phase, 'ready');
        await script('document.querySelector(".nav-item[data-view=archivist]").click(); document.getElementById("create-draft").click()');
        for (let attempt = 0; attempt < 100 && !(await script('document.getElementById("draft-input").value')); attempt++) await delay(50);
        assert.match(await script('document.getElementById("draft-input").value'), /API verification/);
        assert.match(await script('document.getElementById("draft-input").value'), /green barn/);
        await script('document.querySelector(".nav-item[data-view=librarian]").click(); document.getElementById("question").value = "What do the notes say about the green barn?"; document.getElementById("question").dispatchEvent(new Event("input")); document.getElementById("ask-form").requestSubmit()');
        for (let attempt = 0; attempt < 100 && application.chat.messages.length < 4; attempt++) await delay(50);
        assert.equal(application.chat.messages.at(-1).sources[0].id, documentId);
        assert.match(application.chat.messages.at(-1).content, /green barn/);
        assert.equal(requests.length, 2);
        assert.ok(requests.every(body => body.model === 'test/other-instruct' && body.max_tokens === 4096 && !('reasoning_effort' in body) && !('tools' in body) && !('response_format' in body)));
        await screenshot('api-librarian');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: true, checks: ['isolated preload', 'no renderer Node access', 'no decorative quotes', 'light and dark themes', 'theme persistence after reload', 'first-run setup', 'save as written', 'library listing', 'archive overview without a configured model', 'title edit with stable document ID', 'original document', 'local GGUF and configurable API settings', 'API presets and model ID edits', 'model discovery through IPC and HTTP', 'API selection and response-budget persistence', 'API drafting with original text preserved', 'API Librarian answer with validated citations'], errors }, null, 2));
    console.log('PASS: desktop renderer and preload bridge. Screenshots: ' + output);
}
