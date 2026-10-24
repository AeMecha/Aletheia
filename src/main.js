/** Electron entry point: own the window, native dialogs and narrow IPC bridge.
 * Filesystem/model work stays here; the renderer is a sandboxed local page. */
import { app, BrowserWindow, ipcMain, dialog, shell, session, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Application } from './application.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('Aletheia');
if (process.platform === 'win32') app.setAppUserModelId('app.aletheia.library');
const home = process.env.ALETHEIA_HOME ? path.resolve(process.env.ALETHEIA_HOME) : app.getPath('userData');
if (process.env.ALETHEIA_HOME) app.setPath('userData', home);
const resources = app.isPackaged ? path.join(process.resourcesPath, 'aletheia') : path.join(root, 'resources');
const indexUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
let window;
let application;
let quitting = false;

function handle(name, callback) {
    // Validate the sending WebContents and frame before allowing local operations.
    ipcMain.handle('aletheia:' + name, async (event, ...args) => {
        if (event.sender !== window?.webContents || event.senderFrame?.url !== indexUrl) throw new Error('Unknown application window.');
        try { return { ok: true, value: await callback(...args) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
}
function* importPaths(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* importPaths(filename);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) yield filename;
    }
}
function createWindow() {
    nativeTheme.themeSource = application.config.value.theme;
    window = new BrowserWindow({ title: 'Aletheia', width: 1280, height: 880, minWidth: 940, minHeight: 680, backgroundColor: application.config.value.theme === 'dark' ? '#171e1b' : '#f7f5f0', show: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, details) => { console.error('Desktop renderer stopped:', details.reason); });
    window.webContents.on('did-fail-load', (_event, code, description) => { console.error('Desktop page failed to load:', code, description); });
    window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault(); });
    window.once('ready-to-show', () => window.show());
    window.loadFile(path.join(root, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
    app.whenReady().then(async () => {
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        application = new Application({ home, resources, root });
        application.on('state', state => {
            nativeTheme.themeSource = state.settings.theme;
            if (window && !window.isDestroyed()) { window.setBackgroundColor(state.settings.theme === 'dark' ? '#171e1b' : '#f7f5f0'); window.webContents.send('aletheia:state', state); }
        });
        handle('snapshot', () => application.snapshot());
        handle('ask', question => application.ask(question));
        handle('draft', content => application.draft(content));
        handle('save', content => application.save(content));
        handle('renameTitle', (id, title, revision) => application.renameTitle(id, title, revision));
        handle('theme', theme => application.theme(theme));
        handle('newChat', () => application.newChat());
        handle('cancel', () => application.cancel());
        handle('settings', settings => application.settings(settings));
        handle('connect', () => application.model.start());
        handle('downloadModel', () => application.downloadModel());
        handle('document', id => { application.requireArchive(); if (typeof id !== 'string' || id.length > 512) throw new Error('Invalid document ID.'); return application.archive.get(id); });
        handle('refresh', () => { application.requireArchive(); return application.refresh(); });
        handle('chooseModel', async () => {
            const result = await dialog.showOpenDialog(window, { title: 'Choose your Qwen Q4_K_S model', properties: ['openFile'], filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
            return result.canceled ? null : application.selectModel(result.filePaths[0]);
        });
        handle('import', async folder => {
            const result = await dialog.showOpenDialog(window, { title: folder ? 'Import a Markdown archive folder' : 'Import Markdown documents', properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }] });
            if (result.canceled) return null;
            const filenames = folder ? [...importPaths(result.filePaths[0])] : result.filePaths;
            return application.importFiles(filenames);
        });
        handle('openFolder', () => shell.openPath(path.join(home, 'knowledge')));
        handle('export', async id => {
            application.requireArchive();
            const document = application.archive.get(id);
            const result = await dialog.showSaveDialog(window, { title: 'Export archive document', defaultPath: document.id + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
            if (!result.canceled) fs.writeFileSync(result.filePath, document.content, 'utf8');
            return !result.canceled;
        });
        createWindow();
        application.initialize().then(async () => {
            if (process.argv.includes('--verify-installation') || process.argv.includes('--verify-archive')) {
                const { verifyInstallation } = await import('./verify-installation.js');
                await verifyInstallation(window, application, { archiveOnly: process.argv.includes('--verify-archive') });
                app.quit();
                return;
            }
            if (!app.isPackaged && process.env.ALETHEIA_UI_TEST === '1') {
                const { desktopSmoke } = await import('../scripts/desktop-smoke.js');
                await desktopSmoke(window, application);
                app.quit();
            }
        }).catch(error => { console.error('Library initialization:', error.stack || error.message); if (process.env.ALETHEIA_UI_TEST === '1' || process.argv.includes('--verify-installation') || process.argv.includes('--verify-archive')) { application.close().finally(() => app.exit(1)); } });
    }).catch(error => { dialog.showErrorBox('Aletheia could not start', error.message); app.quit(); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && application) createWindow(); });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', event => {
        // Wait for queued writes and the owned inference process before exiting.
        if (quitting || !application) return;
        event.preventDefault();
        quitting = true;
        application.close().finally(() => app.quit());
    });
}
