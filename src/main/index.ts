import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { convertWithOffice, findSoffice } from './office'

let mainWindow: BrowserWindow | null = null
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
      contextIsolation: true
    }
  })
  mainWindow = win

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
  return Promise.all(paths.map(async (path) => ({ name: basename(path), path, data: await readFile(path) })))
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
