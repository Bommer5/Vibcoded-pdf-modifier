import { Capacitor } from '@capacitor/core'

/**
 * Couche plateforme : tout ce qui touche au système (fichiers, conversions)
 * passe par ici. L'interface reste identique sur PC (Electron) et sur
 * mobile / navigateur (Capacitor, PWA).
 */
export interface OpenedFile {
  name: string
  /** Chemin système, quand la plateforme en fournit un (PC). */
  path?: string
  data: Uint8Array
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface Platform {
  readonly kind: 'desktop' | 'mobile' | 'web'
  openFiles(filters: FileFilter[]): Promise<OpenedFile[]>
  /** Enregistre un ou plusieurs fichiers ; renvoie les noms/chemins écrits, ou null si annulé. */
  saveFiles(defaultName: string, filter: FileFilter, mime: string, parts: Uint8Array[]): Promise<string[] | null>
  /** Lit le PDF de fond référencé par un fichier Xournal++ (PC uniquement). */
  readReferencedPdf(path: string): Promise<Uint8Array | null>
  officeAvailable(): Promise<boolean>
  officeConvert(name: string, data: Uint8Array, target: string): Promise<Uint8Array>
  pendingFiles(): Promise<OpenedFile[]>
  onFilesOpened(cb: (files: OpenedFile[]) => void): void
  /** Choisit un emplacement d'enregistrement (PC) ; null = pas de boîte de dialogue sur cette plateforme. */
  chooseSavePath(defaultName: string, filters: FileFilter[]): Promise<string | null | undefined>
  /** Écrit directement dans un fichier déjà ouvert ou choisi (Ctrl+S). */
  writeFile(path: string, data: Uint8Array): Promise<void>
  recentFiles(): Promise<{ path: string; name: string }[]>
  openRecent(path: string): Promise<OpenedFile[]>
  autosaveWrite(data: Uint8Array): Promise<void>
  autosaveRead(): Promise<Uint8Array | null>
  autosaveClear(): Promise<void>
  setDirty(dirty: boolean): void
  onSaveBeforeClose(cb: () => void): void
  closeNow(): void
  toggleFullscreen(): void
  print(pages: { png: Uint8Array; width: number; height: number }[]): Promise<boolean>
}

const desktop = (): Platform => {
  const api = window.feuillet
  return {
    kind: 'desktop',
    openFiles: (filters) => api.openFiles(filters),
    saveFiles: (name, filter, _mime, parts) => api.saveFiles(name, [filter], parts),
    readReferencedPdf: (path) => api.readReferencedPdf(path).catch(() => null),
    officeAvailable: () => api.officeAvailable(),
    officeConvert: (name, data, target) => api.officeConvert(name, data, target),
    pendingFiles: () => api.pendingFiles(),
    onFilesOpened: (cb) => api.onFilesOpened(cb),
    chooseSavePath: (name, filters) => api.chooseSavePath(name, filters),
    writeFile: (path, data) => api.writeFile(path, data),
    recentFiles: () => api.recentFiles(),
    openRecent: (path) => api.openRecent(path),
    autosaveWrite: (data) => api.autosaveWrite(data),
    autosaveRead: () => api.autosaveRead(),
    autosaveClear: () => api.autosaveClear(),
    setDirty: (d) => api.setDirty(d),
    onSaveBeforeClose: (cb) => api.onSaveBeforeClose(cb),
    closeNow: () => api.closeNow(),
    toggleFullscreen: () => api.toggleFullscreen(),
    print: (pages) => api.print(pages)
  }
}

const web = (): Platform => ({
  kind: 'web',
  openFiles: (filters) =>
    new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = filters
        .flatMap((f) => f.extensions)
        .filter((e) => e !== '*')
        .map((e) => '.' + e)
        .join(',')
      input.onchange = async () => {
        const files = [...(input.files ?? [])]
        resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))))
      }
      input.oncancel = () => resolve([])
      input.click()
    }),
  saveFiles: async (name, filter, mime, parts) => {
    const ext = filter.extensions[0]
    const stem = name.replace(/\.[^.]+$/, '')
    const names = parts.length === 1 ? [`${stem}.${ext}`] : parts.map((_, i) => `${stem}-${i + 1}.${ext}`)
    const files = parts.map((p, i) => new File([p as BlobPart], names[i], { type: mime }))
    // Mobile : feuille de partage native (Enregistrer dans Fichiers, Drive, e-mail…).
    if (navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files })
        return names
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return null
      }
    }
    for (const f of files) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(f)
      a.download = f.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }
    return names
  },
  readReferencedPdf: async () => null,
  officeAvailable: async () => false,
  officeConvert: async () => {
    throw new Error('Conversion bureautique indisponible sur cette plateforme')
  },
  pendingFiles: async () => [],
  onFilesOpened: () => {},
  chooseSavePath: async () => undefined,
  writeFile: async () => {
    throw new Error('Écriture directe indisponible sur cette plateforme')
  },
  recentFiles: async () => [],
  openRecent: async () => [],
  // Navigateur / mobile : sauvegarde automatique dans IndexedDB (survit à la fermeture de l'application).
  autosaveWrite: (data) => idb('put', data).then(() => undefined),
  autosaveRead: () => idb('get').then((v) => (v as Uint8Array | undefined) ?? null),
  autosaveClear: () => idb('delete').then(() => undefined),
  setDirty: (d) => {
    window.onbeforeunload = d ? (e) => e.preventDefault() : null
  },
  onSaveBeforeClose: () => {},
  closeNow: () => {},
  toggleFullscreen: () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.()
  },
  print: async (pages) => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0'
    document.body.append(frame)
    const urls = pages.map((p) => URL.createObjectURL(new Blob([p.png as BlobPart], { type: 'image/png' })))
    const first = pages[0]
    frame.srcdoc = `<style>@page{size:${first.width}pt ${first.height}pt;margin:0}body{margin:0}img{width:100%;page-break-after:always;display:block}</style>${urls.map((u) => `<img src="${u}">`).join('')}`
    await new Promise((r) => (frame.onload = r))
    frame.contentWindow?.print()
    setTimeout(() => {
      frame.remove()
      urls.forEach((u) => URL.revokeObjectURL(u))
    }, 60_000)
    return true
  }
})

/** Mini-accès IndexedDB (une seule clé : la sauvegarde automatique). */
function idb(op: 'get' | 'put' | 'delete', value?: Uint8Array): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('feuillet', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite')
      const store = tx.objectStore('kv')
      const req = op === 'get' ? store.get('autosave') : op === 'put' ? store.put(value, 'autosave') : store.delete('autosave')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Android (et iOS) : fichiers écrits dans le cache puis proposés via la feuille de partage native. */
const mobile = (): Platform => ({
  ...web(),
  kind: 'mobile',
  saveFiles: async (name, filter, _mime, parts) => {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const ext = filter.extensions[0]
    const stem = name.replace(/\.[^.]+$/, '')
    const names = parts.length === 1 ? [`${stem}.${ext}`] : parts.map((_, i) => `${stem}-${i + 1}.${ext}`)
    const files: string[] = []
    for (const [i, part] of parts.entries()) {
      const { uri } = await Filesystem.writeFile({ path: names[i], data: toBase64(part), directory: Directory.Cache })
      files.push(uri)
    }
    try {
      await Share.share({ title: names[0], files })
    } catch {
      return null // partage annulé
    }
    return names
  }
})

export const platform: Platform = 'feuillet' in window ? desktop() : Capacitor.isNativePlatform() ? mobile() : web()
