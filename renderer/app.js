/* The renderer receives only the narrow desktop API exposed by preload.cjs. */
// Renderer: DOM and interaction only. Privileged operations use the narrow preload API.
const api = window.aletheia;
const $ = id => document.getElementById(id);
let state;
let lastChat = '';
let lastDocuments = '';
let lastSettings = '';
let uiBusy = false;
let activeDocument;
let activeView = 'librarian';
let changingTheme = false;

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('aletheia.theme', theme); } catch { /* Settings still persist in the application. */ }
    const dark = theme === 'dark';
    $('theme-icon').textContent = dark ? '☀' : '☾';
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    $('theme-toggle').setAttribute('aria-pressed', String(dark));
    $('theme-toggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

function notice(message) { $('notice-text').textContent = message; $('notice').hidden = false; }
function showView(name) {
    activeView = name;
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-' + name));
    document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === name));
    $('view-label').textContent = { librarian: 'Librarian', archivist: 'Archivist', library: 'Your library', settings: 'Settings' }[name];
    if (state) $('setup-banner').hidden = state.settings.provider !== 'embedded' || Boolean(state.settings.modelPath) || ['library', 'settings'].includes(activeView);
}
async function run(action) {
    if (uiBusy) return;
    uiBusy = true;
    updateControls();
    try { return await action(); }
    catch (error) { notice(error.message || String(error)); }
    finally { uiBusy = false; updateControls(); }
}
function updateControls() {
    // Inventory and original-text saving need the library; generation also needs AI.
    const busy = uiBusy || state?.busy;
    const ready = state?.model.phase === 'ready';
    const libraryReady = state?.library.phase === 'ready';
    for (const id of ['new-chat', 'save-settings', 'reconnect', 'fetch-models', 'import-files', 'import-folder', 'refresh-library']) $(id).disabled = Boolean(busy);
    for (const button of document.querySelectorAll('.choose-model,.download-model')) button.disabled = Boolean(busy);
    $('ask-button').disabled = Boolean(busy || !ready || !libraryReady || !$('question').value.trim());
    $('create-draft').disabled = Boolean(busy || !ready || !$('archive-input').value.trim());
    $('save-original').disabled = Boolean(busy || !libraryReady || !$('archive-input').value.trim());
    $('save-draft').disabled = Boolean(busy || !libraryReady || !$('draft-input').value.trim());
    $('archive-overview').disabled = Boolean(busy || !libraryReady);
    $('theme-toggle').disabled = Boolean(!state || changingTheme);
    $('edit-title').disabled = Boolean(busy);
    $('save-title').disabled = Boolean(busy || !$('title-input').value.trim());
    $('cancel-title').disabled = Boolean(busy);
}
function renderChat() {
    // textContent treats model/source text as data; no generated HTML is executed.
    const serialized = JSON.stringify(state.chat);
    if (serialized === lastChat) return;
    lastChat = serialized;
    const messages = state.chat.messages;
    $('librarian-empty').hidden = Boolean(messages.length);
    $('conversation').hidden = !messages.length;
    $('conversation').replaceChildren();
    for (const message of messages) {
        const row = document.createElement('article');
        row.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');
        const label = document.createElement('div'); label.className = 'message-label'; label.textContent = message.role === 'user' ? 'YOU' : 'LIBRARIAN';
        const body = document.createElement('div'); body.className = 'message-content'; body.textContent = message.content;
        row.append(label, body);
        if (message.sources?.length) {
            const sources = document.createElement('div'); sources.className = 'sources';
            for (const source of message.sources) {
                const button = document.createElement('button'); button.className = 'source-button'; button.textContent = '▤ ' + source.title + (source.is_excerpt ? ' · excerpt' : '');
                button.addEventListener('click', () => run(() => openDocument(source.id))); sources.append(button);
            }
            row.append(sources);
        }
        $('conversation').append(row);
    }
    $('conversation').scrollTop = $('conversation').scrollHeight;
}
function renderDocuments(force = false) {
    const filter = $('library-filter').value.trim().toLowerCase();
    const serialized = JSON.stringify(state.documents) + filter;
    if (!force && serialized === lastDocuments) return;
    lastDocuments = serialized;
    $('documents').replaceChildren();
    const matches = state.documents.filter(document => document.title.toLowerCase().includes(filter));
    $('library-empty').hidden = state.documents.length > 0;
    if (!matches.length && state.documents.length) { const empty = document.createElement('p'); empty.className = 'subtle'; empty.textContent = 'No titles match this filter.'; $('documents').append(empty); }
    for (const document of matches) {
        const row = window.document.createElement('button'); row.className = 'document-row';
        const icon = window.document.createElement('span'); icon.className = 'document-icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
        const info = window.document.createElement('span'); info.className = 'document-info';
        const title = window.document.createElement('strong'); title.textContent = document.title;
        const subtitle = window.document.createElement('small'); subtitle.textContent = [document.metadata.type || 'DOCUMENT', document.metadata.created?.slice(0, 10) || '', document.metadata.source || ''].filter(Boolean).join('  ·  ');
        info.append(title, subtitle);
        const arrow = window.document.createElement('span'); arrow.className = 'document-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
        row.append(icon, info, arrow); row.addEventListener('click', () => run(() => openDocument(document.id))); $('documents').append(row);
    }
}
function providerFields() {
    const embedded = document.querySelector('input[name=provider]:checked')?.value !== 'api';
    $('embedded-options').hidden = !embedded;
    $('api-options').hidden = embedded;
    $('api-token-options').hidden = embedded;
}
function renderSettings() {
    // State events must not overwrite connection fields the user is still editing.
    const { theme, ...connection } = state.settings;
    const serialized = JSON.stringify(connection);
    if (serialized === lastSettings) return;
    lastSettings = serialized;
    document.querySelector(`input[name=provider][value=${state.settings.provider}]`).checked = true;
    $('gpu').value = state.settings.gpu;
    $('context-size').value = state.settings.contextSize;
    $('api-url').value = state.settings.apiUrl;
    $('api-model').value = state.settings.apiModel;
    $('response-mode').value = state.settings.responseMode;
    $('token-limit-field').value = state.settings.tokenLimitField;
    $('output-tokens').value = state.settings.outputTokens;
    $('api-preset').value = state.settings.apiUrl === 'http://127.0.0.1:1234/v1' ? 'lmstudio' : state.settings.apiUrl === 'http://localhost:11434/v1' ? 'ollama' : 'custom';
    $('api-key').value = state.settings.apiKey;
    $('auto-start').checked = state.settings.autoStart;
    $('model-path').textContent = state.settings.modelPath || 'No model selected';
    $('storage-path').textContent = state.home;
    providerFields();
}
function render(value) {
    state = value;
    applyTheme(state.settings.theme);
    const model = state.model;
    const setup = state.settings.provider === 'embedded' && !state.settings.modelPath;
    document.body.classList.toggle('needs-setup', setup);
    $('setup-banner').hidden = !setup || ['library', 'settings'].includes(activeView);
    $('engine-label').textContent = model.phase === 'ready' ? (model.model || 'Your AI') + (state.settings.provider === 'embedded' ? ' · local' : ' · API') : ({ loading: 'Connecting to your AI…', error: 'Connection needs attention', setup: 'Set up your AI', stopped: 'AI not loaded' }[model.phase] || 'Getting ready');
    $('engine-chip').title = model.message;
    for (const id of ['engine-dot', 'sidebar-dot']) $(id).className = 'status-dot ' + model.phase;
    $('sidebar-status').textContent = state.library.phase === 'error' ? 'Library needs attention' : model.phase === 'ready' ? 'Your AI is ready' : model.phase === 'loading' ? 'Loading your AI' : 'Your library stays local';
    $('nav-count').textContent = state.library.count ?? state.documents.length;
    $('library-description').textContent = state.library.message;
    const progress = state.progress || (model.phase === 'loading' ? { message: model.message } : state.library.phase === 'loading' || state.library.phase === 'indexing' ? { message: state.library.message } : null);
    $('progress-banner').hidden = !progress;
    $('progress-text').textContent = progress?.message || '';
    $('cancel-operation').hidden = !state.busy;
    $('download-progress').hidden = !(progress?.total && progress.phase === 'downloading');
    if (progress?.total) $('download-progress').value = Math.round(progress.received / progress.total * 100);
    if (model.phase === 'error' && render.lastModelError !== model.message) { notice(model.message); render.lastModelError = model.message; }
    if (state.library.phase === 'error' && render.lastLibraryError !== state.library.message) { notice(state.library.message); render.lastLibraryError = state.library.message; }
    renderChat(); renderDocuments(); renderSettings(); updateControls();
}
async function openDocument(id) {
    // Keep the returned revision for optimistic concurrency when editing the title.
    activeDocument = await api.document(id);
    displayDocument();
    $('title-form').hidden = true;
    $('edit-title').hidden = false;
    $('title-error').textContent = '';
    $('document-dialog').showModal();
}
function displayDocument() {
    $('document-title').textContent = activeDocument.title;
    $('document-id').textContent = activeDocument.id;
    $('document-content').textContent = activeDocument.content;
}
async function importDocuments(folder) {
    const result = await api.import(folder);
    if (result) notice(`Imported ${result.imported} document${result.imported === 1 ? '' : 's'}. ${result.duplicates ? `${result.duplicates} already in your library. ` : ''}${result.errors.length ? '\n' + result.errors.join('\n') : ''}`);
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('engine-chip').addEventListener('click', () => showView('settings'));
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('ask-form').addEventListener('submit', event => { event.preventDefault(); if (!$('ask-button').disabled) run(async () => { await api.ask($('question').value); $('question').value = ''; }); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!$('ask-button').disabled) $('ask-form').requestSubmit(); } });
for (const id of ['question', 'archive-input', 'draft-input']) $(id).addEventListener('input', updateControls);
document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { $('question').value = button.dataset.question; $('question').focus(); updateControls(); }));
$('new-chat').addEventListener('click', () => run(async () => render(await api.newChat())));
$('archive-overview').addEventListener('click', () => run(() => api.ask('What does my archive contain?')));
$('cancel-operation').addEventListener('click', () => api.cancel().catch(error => notice(error.message)));
$('create-draft').addEventListener('click', () => run(async () => { const draft = await api.draft($('archive-input').value); $('draft-input').value = draft.markdown; $('save-status').textContent = draft.source_excerpted ? 'Review before saving · summary uses selected excerpts' : 'Review before saving'; }));
$('save-draft').addEventListener('click', () => run(async () => { const saved = await api.save($('draft-input').value); $('save-status').textContent = 'Saved to your library'; notice(`Saved “${saved.title}”.`); }));
$('save-original').addEventListener('click', () => run(async () => { const saved = await api.save($('archive-input').value); notice(`Saved “${saved.title}” as written.`); }));
$('import-files').addEventListener('click', () => run(() => importDocuments(false)));
$('import-folder').addEventListener('click', () => run(() => importDocuments(true)));
$('refresh-library').addEventListener('click', () => run(async () => render(await api.refresh())));
for (const id of ['open-folder', 'settings-open-folder']) $(id).addEventListener('click', () => run(() => api.openFolder()));
$('library-filter').addEventListener('input', () => renderDocuments(true));
document.querySelectorAll('.choose-model').forEach(button => button.addEventListener('click', () => run(async () => { const result = await api.chooseModel(); if (result) render(result); })));
document.querySelectorAll('.download-model').forEach(button => button.addEventListener('click', () => run(async () => render(await api.downloadModel()))));
document.querySelectorAll('input[name=provider]').forEach(input => input.addEventListener('change', providerFields));
$('api-preset').addEventListener('change', () => {
    const address = { lmstudio: 'http://127.0.0.1:1234/v1', ollama: 'http://localhost:11434/v1' }[$('api-preset').value];
    if (address) $('api-url').value = address;
    // Credentials and model catalogs belong to one server, not the next preset.
    $('api-key').value = ''; $('api-model').value = ''; clearModelSuggestions();
});
function clearModelSuggestions() { $('available-models').replaceChildren(); $('models-status').textContent = ''; }
$('api-url').addEventListener('input', () => { $('api-preset').value = 'custom'; clearModelSuggestions(); });
$('api-key').addEventListener('input', clearModelSuggestions);
$('fetch-models').addEventListener('click', () => run(async () => {
    clearModelSuggestions();
    const connection = { apiUrl: $('api-url').value, apiKey: $('api-key').value };
    $('models-status').textContent = 'Fetching models…';
    try {
        const models = await api.models(connection);
        // Ignore a list if the user edited its server while the request ran.
        if (connection.apiUrl !== $('api-url').value || connection.apiKey !== $('api-key').value) return;
        for (const id of models) { const option = document.createElement('option'); option.value = id; $('available-models').append(option); }
        if (models.length === 1 && !$('api-model').value.trim()) $('api-model').value = models[0];
        $('models-status').textContent = models.length ? `${models.length} model${models.length === 1 ? '' : 's'} available. Choose or enter an ID.` : 'No models listed. Enter an ID manually.';
    } catch (error) { $('models-status').textContent = 'Enter the model ID manually if discovery is unavailable.'; throw error; }
}));
$('settings-form').addEventListener('submit', event => { event.preventDefault(); run(async () => render(await api.settings({ ...state.settings, provider: document.querySelector('input[name=provider]:checked').value, contextSize: Number($('context-size').value), gpu: $('gpu').value, outputTokens: Number($('output-tokens').value), apiUrl: $('api-url').value, apiModel: $('api-model').value, apiKey: $('api-key').value, responseMode: $('response-mode').value, tokenLimitField: $('token-limit-field').value, autoStart: $('auto-start').checked }))); });
$('reconnect').addEventListener('click', () => run(() => api.connect()));
$('close-document').addEventListener('click', () => $('document-dialog').close());
$('document-dialog').addEventListener('click', event => { if (event.target === $('document-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
$('export-document').addEventListener('click', () => run(() => api.export(activeDocument.id)));
$('edit-title').addEventListener('click', () => {
    $('title-input').value = activeDocument.title;
    $('title-error').textContent = '';
    $('title-form').hidden = false;
    $('edit-title').hidden = true;
    $('title-input').focus(); $('title-input').select(); updateControls();
});
$('title-input').addEventListener('input', updateControls);
$('cancel-title').addEventListener('click', () => { $('title-form').hidden = true; $('edit-title').hidden = false; $('edit-title').focus(); });
$('title-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
        try {
            activeDocument = await api.renameTitle(activeDocument.id, $('title-input').value, activeDocument.revision);
            displayDocument(); $('title-form').hidden = true; $('edit-title').hidden = false; $('edit-title').focus();
        } catch (error) { $('title-error').textContent = error.message; }
    });
});
$('theme-toggle').addEventListener('click', async () => {
    if (!state || changingTheme) return;
    const previous = state.settings.theme;
    changingTheme = true; applyTheme(previous === 'dark' ? 'light' : 'dark'); updateControls();
    try { const result = await api.theme(previous === 'dark' ? 'light' : 'dark'); state.settings.theme = result.theme; applyTheme(result.theme); }
    catch (error) { applyTheme(previous); notice(error.message); }
    finally { changingTheme = false; updateControls(); }
});
api.onState(render);
api.snapshot().then(render).catch(error => notice(error.message));
