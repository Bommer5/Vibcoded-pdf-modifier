import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { download as hwrDownload, installed as hwrInstalled, readModelFile, remove as hwrRemove } from './hwr-models'
import { integrateAppImage } from './linux-integration'
import { convertWithOffice, findSoffice } from './office'

let mainWindow: BrowserWindow | null = null
/** Document non enregistré : la fermeture demande confirmation. */
let dirty = false
/** Dernière sauvegarde de secours faite juste avant la question de fermeture. */
let finalSaved = false
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
/** Arguments de la ligne de commande qui sont des fichiers existants (chemins relatifs compris). */
function filesIn(args: string[], cwd: string): string[] {
  return args
    .filter((a) => !a.startsWith('-'))
    .map((a) => (a.startsWith('file://') ? fileURLToPath(a) : resolve(cwd, a)))
    .filter((p) => extname(p) && existsSync(p) && statSync(p).isFile())
}
/** Fichiers passés en argument (« Ouvrir avec… ») en attente de l'interface. */
let pendingPaths: string[] = filesIn(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd())

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
    // D'abord une dernière sauvegarde de secours (quoi qu'on réponde ensuite, rien n'est perdu)
    if (!finalSaved) {
      e.preventDefault()
      const done = (): void => {
        finalSaved = true
        win.close()
      }
      ipcMain.once('app:autosaved', done)
      win.webContents.send('app:autosave-now')
      setTimeout(() => {
        ipcMain.removeListener('app:autosaved', done)
        if (!finalSaved) done()
      }, 4000)
      return
    }
    finalSaved = false
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
      // Ne pas enregistrer : la sauvegarde de secours reste (Fichier > Récupérer, 14 jours)
      dirty = false
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

// Sauvegardes de secours : une par session de travail (jamais écrasée par une autre), gardées
// 14 jours (10 au plus). « Ne pas enregistrer » ne les supprime pas : Fichier > Récupérer.
const RECOVERY = (): string => userFile('recovery')
const slot = (id: string): string => join(RECOVERY(), `${id.replace(/[^\w-]/g, '')}.feuillet`)
interface RecoveryMeta { id: string; name: string; time: number; size: number }
async function recoveryList(): Promise<RecoveryMeta[]> {
  const dir = RECOVERY()
  if (!existsSync(dir)) return []
  const out: RecoveryMeta[] = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, f), 'utf8')) as RecoveryMeta
      if (existsSync(slot(meta.id))) out.push(meta)
    } catch {
      // méta illisible : ignorée
    }
  }
  return out.sort((a, b) => b.time - a.time)
}
async function recoveryPrune(): Promise<void> {
  const list = await recoveryList()
  const old = list.filter((m, i) => i >= 10 || Date.now() - m.time > 14 * 86_400_000)
  for (const m of old) {
    await rm(slot(m.id), { force: true })
    await rm(join(RECOVERY(), `${m.id}.json`), { force: true })
  }
}
ipcMain.handle('recovery:write', async (_e, id: string, name: string, data: Uint8Array) => {
  await mkdir(RECOVERY(), { recursive: true })
  // Écriture sûre : fichier temporaire puis renommage (jamais de sauvegarde à moitié écrite)
  const tmp = slot(id) + '.tmp'
  await writeFile(tmp, data)
  await rename(tmp, slot(id))
  await writeFile(join(RECOVERY(), `${id}.json`), JSON.stringify({ id, name, time: Date.now(), size: data.length }))
})
ipcMain.handle('recovery:list', async () => {
  // Ancienne sauvegarde unique (versions précédentes) : reprise dans l'historique
  if (existsSync(AUTOSAVE())) {
    const id = `ancienne-${Date.now()}`
    await mkdir(RECOVERY(), { recursive: true })
    await rename(AUTOSAVE(), slot(id))
    await writeFile(join(RECOVERY(), `${id}.json`), JSON.stringify({ id, name: 'Document', time: Date.now(), size: 0 }))
  }
  await recoveryPrune()
  return recoveryList()
})
ipcMain.handle('recovery:read', async (_e, id: string) => (existsSync(slot(id)) ? new Uint8Array(await readFile(slot(id))) : null))
ipcMain.handle('recovery:delete', async (_e, id: string) => {
  await rm(slot(id), { force: true })
  await rm(join(RECOVERY(), `${id}.json`), { force: true })
})

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

// Moteur d'écriture précis (téléchargé une fois)
ipcMain.handle('hwr:installed', () => hwrInstalled())
ipcMain.handle('hwr:download', (e) => hwrDownload(e.sender))
ipcMain.handle('hwr:read', (_e, name: string) => readModelFile(name))
ipcMain.handle('hwr:remove', () => hwrRemove())

ipcMain.handle('office:available', () => findSoffice() !== null)
ipcMain.handle('office:convert', (_e, name: string, data: Uint8Array, target: string) =>
  convertWithOffice(name, data, target)
)

// Linux : sous Wayland, le pavé tactile envoie ses gestes (pincer pour zoomer) ; sous X11,
// Chromium ne les reçoit pas. On laisse donc l'application choisir Wayland quand il est là.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

// Une seule instance : un double-clic sur un fichier l'ouvre dans la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const paths = filesIn(argv.slice(1), cwd)
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    void readPaths(paths).then((files) => mainWindow?.webContents.send('file:opened', files))
  })

  app.whenReady().then(() => {
    createWindow()
    void integrateAppImage(process.resourcesPath).catch((e) => console.warn('Intégration au bureau impossible', e))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
