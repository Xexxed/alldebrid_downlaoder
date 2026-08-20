const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  
  // Native Folder Picker
  selectFolder: (defaultPath) => ipcRenderer.invoke('dialog:selectFolder', defaultPath),
  
  // Shell Integration (Explorer / Finder)
  openFolder: (dirPath) => ipcRenderer.invoke('shell:openPath', dirPath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  
  // Desktop Notifications
  showNotification: (options) => ipcRenderer.invoke('app:showNotification', options),
  
  // Window Management
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  
  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
});
