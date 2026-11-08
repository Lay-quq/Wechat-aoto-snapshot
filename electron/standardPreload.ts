import { contextBridge, ipcRenderer } from 'electron'
import type { StandardAPI } from '../shared/standardExport'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke('standard:' + name, ...args)
const api: StandardAPI = {
  diagnostics: {
    recordError: (error: import('../shared/errorDiagnostics').ErrorDiagnosticEntry) => ipcRenderer.invoke('diagnostics:recordError', error),
    exportErrorLog: (error: import('../shared/errorDiagnostics').ErrorDiagnosticInput) => ipcRenderer.invoke('diagnostics:exportErrorLog', error),
  },
  snapshot: () => invoke('snapshot'), connect: () => invoke('connect'), cancelConnection: () => invoke('cancel'),
  unlock: password => invoke('unlock', password), hello: () => invoke('hello'), lock: () => invoke('lock'), sessions: () => invoke('sessions'),
  messages: (id, offset) => invoke('messages', id, offset), export: (ids, options) => invoke('export', ids, options), cancelExport: () => invoke('cancelExport'),
  avatar: id => invoke('avatar', id), image: (id, message) => invoke('image', id, message), media: (id, message) => invoke('media', id, message), groupInfo: () => invoke('groupInfo'), openGroup: channel => invoke('openGroup', channel), copyGroupNumber: () => invoke('copyGroupNumber'),
  openExportDirectory: () => invoke('openExportDirectory'), window: action => ipcRenderer.send('standard:window', action),
  onChanged: listener => { const handler = (_event: unknown, value: any) => listener(value); ipcRenderer.on('standard:changed', handler); return () => ipcRenderer.removeListener('standard:changed', handler) },
}
contextBridge.exposeInMainWorld('standardAPI', api)
