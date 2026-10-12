import { contextBridge, ipcRenderer } from 'electron'

export interface OpenedFile {
  name: string
  path: string
  data: Uint8Array
}

export interface FileFilter {
  name: string
  extensions: string[]
}

const api = {
  openFiles: (filters: FileFilter[]): Promise<OpenedFile[]> => ipcRenderer.invoke('file:open', filters),
  readReferencedPdf: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('file:read-referenced', path),
  pendingFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('file:pending'),
  onFilesOpened: (cb: (files: OpenedFile[]) => void): void => {
    ipcRenderer.on('file:opened', (_e, files: OpenedFile[]) => cb(files))
  },
  saveFiles: (defaultName: string, filters: FileFilter[], parts: Uint8Array[]): Promise<string[] | null> =>
    ipcRenderer.invoke('file:save', defaultName, filters, parts),
  chooseSavePath: (defaultName: string, filters: FileFilter[]): Promise<string | null> =>
    ipcRenderer.invoke('file:choose-save', defaultName, filters),
  writeFile: (path: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke('file:write', path, data),
  recentFiles: (): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('recent:list'),
  openRecent: (path: string): Promise<OpenedFile[]> => ipcRenderer.invoke('recent:open', path),
  autosaveWrite: (data: Uint8Array): Promise<void> => ipcRenderer.invoke('autosave:write', data),
  autosaveRead: (): Promise<Uint8Array | null> => ipcRenderer.invoke('autosave:read'),
  autosaveClear: (): Promise<void> => ipcRenderer.invoke('autosave:clear'),
  setDirty: (dirty: boolean): void => ipcRenderer.send('doc:dirty', dirty),
  onSaveBeforeClose: (cb: () => void): void => {
    ipcRenderer.on('app:save-before-close', () => cb())
  },
  closeNow: (): void => ipcRenderer.send('app:close-now'),
  toggleFullscreen: (): void => ipcRenderer.send('window:fullscreen'),
  print: (pages: { png: Uint8Array; width: number; height: number }[]): Promise<boolean> => ipcRenderer.invoke('print:pages', pages),
  officeAvailable: (): Promise<boolean> => ipcRenderer.invoke('office:available'),
  officeConvert: (name: string, data: Uint8Array, target: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('office:convert', name, data, target)
}

export type FeuilletApi = typeof api

contextBridge.exposeInMainWorld('feuillet', api)
