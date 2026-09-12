const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('carryClient', {
  invoke: (action, input = {}) => ipcRenderer.invoke('carry:command', action, input),
  subscribe: callback => {
    const listener = () => callback();
    ipcRenderer.on('carry:changed', listener);
    return () => ipcRenderer.removeListener('carry:changed', listener);
  },
});
