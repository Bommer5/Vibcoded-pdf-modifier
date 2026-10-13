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
  recoveryWrite: (id: string, name: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke('recovery:write', id, name, data),
  hwrInstalled: (): Promise<string[] | null> => ipcRenderer.invoke('hwr:installed'),
  hwrDownload: (): Promise<string[]> => ipcRenderer.invoke('hwr:download'),
  hwrRead: (name: string): Promise<Uint8Array> => ipcRenderer.invoke('hwr:read', name),
  hwrRemove: (): Promise<void> => ipcRenderer.invoke('hwr:remove'),
  onHwrProgress: (cb: (p: { file: string; loaded: number; total: number; step: number; steps: number }) => void): void => void ipcRenderer.on('hwr:progress', (_e, p) => cb(p)),
  recoveryList: (): Promise<{ id: string; name: string; time: number; size: number }[]> => ipcRenderer.invoke('recovery:list'),
  recoveryRead: (id: string): Promise<Uint8Array | null> => ipcRenderer.invoke('recovery:read', id),
  recoveryDelete: (id: string): Promise<void> => ipcRenderer.invoke('recovery:delete', id),
  onAutosaveNow: (cb: () => Promise<void>): void => {
    ipcRenderer.on('app:autosave-now', () => void cb().finally(() => ipcRenderer.send('app:autosaved')))
  },
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
