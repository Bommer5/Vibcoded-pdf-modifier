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
  officeAvailable: (): Promise<boolean> => ipcRenderer.invoke('office:available'),
  officeConvert: (name: string, data: Uint8Array, target: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('office:convert', name, data, target)
}

export type FeuilletApi = typeof api

contextBridge.exposeInMainWorld('feuillet', api)
