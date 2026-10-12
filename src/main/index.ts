import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { convertWithOffice, findSoffice } from './office'

let mainWindow: BrowserWindow | null = null
/** Document non enregistré : la fermeture demande confirmation. */
let dirty = false
/**
 * Chemins que l'interface a le droit d'écrire sans boîte de dialogue : uniquement
 * ceux que l'utilisateur a lui-même ouverts ou choisis (Ctrl+S sur le fichier ouvert).
 */
const allowedPaths = new Set<string>()
const userFile = (name: string): string => join(app.getPath('userData'), name)
const RECENT = (): string => userFile('recent.json')
const AUTOSAVE = (): string => userFile(join('recovery', 'autosave.feuillet'))

async function recentList(): Promise<string[]> {
  try {
    return (JSON.parse(await readFile(RECENT(), 'utf8')) as string[]).filter((p) => existsSync(p))
  } catch {
    return []
  }
}

async function addRecent(path: string): Promise<void> {
  allowedPaths.add(path)
  const list = [path, ...(await recentList()).filter((p) => p !== path)].slice(0, 12)
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(RECENT(), JSON.stringify(list))
}
/** Fichiers passés en argument (« Ouvrir avec… ») en attente de l'interface. */
let pendingPaths: string[] = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && extname(a))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1f24',
    title: 'Feuillet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false // pas de dictionnaires chargés en mémoire
    }
  })
  mainWindow = win

  // Document non enregistré : proposer d'enregistrer avant de fermer.
  win.on('close', (e) => {
    if (!dirty) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      title: 'Feuillet',
      message: 'Enregistrer les modifications avant de fermer ?',
      detail: 'Vos modifications seront perdues si vous ne les enregistrez pas.'
    })
    if (choice === 1) {
      dirty = false
      void rm(AUTOSAVE(), { force: true })
      return
    }
    e.preventDefault()
    if (choice === 0) win.webContents.send('app:save-before-close')
  })

  win.once('ready-to-show', () => win.show())

  // Les liens s'ouvrent dans le navigateur système, jamais dans l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function readPaths(paths: string[]): Promise<{ name: string; path: string; data: Uint8Array }[]> {
  const files = await Promise.all(paths.map(async (path) => ({ name: basename(path), path, data: await readFile(path) })))
  for (const f of files) await addRecent(f.path)
  return files
}

ipcMain.handle('file:open', async (_e, filters: Electron.FileFilter[]) => {
  const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters })
  if (res.canceled) return []
  return readPaths(res.filePaths)
})

// Lecture d'un fichier référencé par un document ouvert (ex. le PDF de fond d'un .xopp).
// Seuls les PDF sont autorisés.
ipcMain.handle('file:read-referenced', async (_e, path: string) => {
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('Type de fichier non autorisé')
  return new Uint8Array(await readFile(path))
})

ipcMain.handle('file:pending', async () => {
  const paths = pendingPaths
  pendingPaths = []
  return readPaths(paths)
})

/**
 * Enregistre un ou plusieurs fichiers. Le premier va à l'emplacement choisi
 * par l'utilisateur ; les suivants (pages 2, 3…) à côté, avec un suffixe.
 */
ipcMain.handle(
  'file:save',
  async (_e, defaultName: string, filters: Electron.FileFilter[], parts: Uint8Array[]) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters })
    if (res.canceled || !res.filePath) return null
    let target = res.filePath
    const ext = '.' + (filters[0]?.extensions[0] ?? '')
    if (ext !== '.' && extname(target).toLowerCase() !== ext.toLowerCase()) target += ext
    if (parts.length === 1) {
      await writeFile(target, parts[0])
      await addRecent(target)
      return [target]
    }
    const stem = basename(target, extname(target))
    const written: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const path = join(dirname(target), `${stem}-${i + 1}${extname(target)}`)
      await writeFile(path, parts[i])
      written.push(path)
    }
    return written
  }
)

ipcMain.handle('file:choose-save', async (_e, defaultName: string, filters: Electron.FileFilter[]) => {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters })
  if (res.canceled || !res.filePath) return null
  allowedPaths.add(res.filePath)
  return res.filePath
})

// Enregistrement direct (Ctrl+S) : seulement vers un fichier ouvert ou choisi par l'utilisateur.
ipcMain.handle('file:write', async (_e, path: string, data: Uint8Array) => {
  if (!allowedPaths.has(path)) throw new Error('Emplacement non autorisé')
  await writeFile(path, data)
  await addRecent(path)
})

ipcMain.handle('recent:list', async () => (await recentList()).map((path) => ({ path, name: basename(path) })))
ipcMain.handle('recent:open', async (_e, path: string) => {
  if (!(await recentList()).includes(path)) throw new Error('Fichier récent introuvable')
  return readPaths([path])
})

ipcMain.handle('autosave:write', async (_e, data: Uint8Array) => {
  await mkdir(dirname(AUTOSAVE()), { recursive: true })
  await writeFile(AUTOSAVE(), data)
})
ipcMain.handle('autosave:read', async () => (existsSync(AUTOSAVE()) ? new Uint8Array(await readFile(AUTOSAVE())) : null))
ipcMain.handle('autosave:clear', () => rm(AUTOSAVE(), { force: true }))

ipcMain.on('doc:dirty', (_e, value: boolean) => (dirty = value))
ipcMain.on('app:close-now', () => {
  dirty = false
  mainWindow?.close()
})
ipcMain.on('window:fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()))

/** Impression : une image par page, mise en page exacte dans une fenêtre cachée. */
ipcMain.handle('print:pages', async (_e, pages: { png: Uint8Array; width: number; height: number }[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'feuillet-print-'))
  try {
    // Une « page nommée » CSS par format : chaque page s'imprime à sa taille (A4, paysage…).
    const sizes = [...new Set(pages.map((p) => `${p.width.toFixed(2)}pt ${p.height.toFixed(2)}pt`))]
    const css = sizes.map((s, k) => `@page s${k}{size:${s};margin:0}.s${k}{page:s${k}}`).join('')
    const html = pages
      .map((p, i) => {
        const k = sizes.indexOf(`${p.width.toFixed(2)}pt ${p.height.toFixed(2)}pt`)
        return `<div class="p s${k}" style="width:${p.width}pt;height:${p.height}pt"><img src="p${i}.png"></div>`
      })
      .join('')
    await Promise.all(pages.map((p, i) => writeFile(join(dir, `p${i}.png`), p.png)))
    await writeFile(
      join(dir, 'print.html'),
      `<!doctype html><meta charset="utf-8"><style>@page{margin:0}${css}html,body{margin:0}.p{break-after:page;overflow:hidden}.p:last-child{break-after:auto}.p img{width:100%;height:100%;display:block}</style>${html}`
    )
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } })
    await win.loadFile(join(dir, 'print.html'))
    const ok = await new Promise<boolean>((resolve) =>
      win.webContents.print({ printBackground: true, margins: { marginType: 'none' } }, (success) => resolve(success))
    )
    win.destroy()
    return ok
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

ipcMain.handle('office:available', () => findSoffice() !== null)
ipcMain.handle('office:convert', (_e, name: string, data: Uint8Array, target: string) =>
  convertWithOffice(name, data, target)
)

// Une seule instance : un double-clic sur un fichier l'ouvre dans la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const paths = argv.slice(1).filter((a) => !a.startsWith('-') && extname(a))
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    void readPaths(paths).then((files) => mainWindow?.webContents.send('file:opened', files))
  })

  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
