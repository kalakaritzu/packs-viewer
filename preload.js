const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getRoot: () => ipcRenderer.invoke('get-root'),
  scan: (force) => ipcRenderer.invoke('scan', force),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  dragStart: (p) => ipcRenderer.send('drag-start', p),
  closeWin: () => ipcRenderer.send('win-close'),
  minWin: () => ipcRenderer.send('win-min'),
  reveal: (p) => ipcRenderer.send('reveal', p),
  copyPath: (p) => ipcRenderer.send('copy-path', p),
  onProgress: (cb) => ipcRenderer.on('scan-progress', (_e, d) => cb(d)),
});
