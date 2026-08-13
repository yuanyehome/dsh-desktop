'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  retry: () => ipcRenderer.send('retry'),
  openLogs: () => ipcRenderer.send('open-logs'),
})
