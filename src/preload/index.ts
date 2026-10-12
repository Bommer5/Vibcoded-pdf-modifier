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
  saveFile: (defaultName: string, filters: FileFilter[], data: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke('file:save', defaultName, filters, data)
}

export type FeuilletApi = typeof api

contextBridge.exposeInMainWorld('feuillet', api)
