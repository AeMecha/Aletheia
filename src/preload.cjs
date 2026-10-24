// The isolated renderer receives these named operations, never raw ipcRenderer,
// filesystem access or an arbitrary channel name. Errors cross as plain text.
const { contextBridge, ipcRenderer } = require('electron');
const names = ['snapshot', 'ask', 'draft', 'save', 'renameTitle', 'theme', 'newChat', 'cancel', 'settings', 'connect', 'downloadModel', 'document', 'refresh', 'chooseModel', 'import', 'openFolder', 'export'];
const api = Object.fromEntries(names.map(name => [name, async (...args) => {
    const result = await ipcRenderer.invoke('aletheia:' + name, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
}]));
api.onState = callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('aletheia:state', listener);
    return () => ipcRenderer.removeListener('aletheia:state', listener);
};
contextBridge.exposeInMainWorld('aletheia', api);
