import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

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

  win.once('ready-to-show', () => win.show())

  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('file:open', async (_e, filters: Electron.FileFilter[]) => {
  const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters })
  if (res.canceled) return []
  return Promise.all(
    res.filePaths.map(async (path) => ({ name: basename(path), path, data: await readFile(path) }))
  )
})

ipcMain.handle(
  'file:save',
  async (_e, defaultName: string, filters: Electron.FileFilter[], data: Uint8Array) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, data)
    return res.filePath
  }
)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
