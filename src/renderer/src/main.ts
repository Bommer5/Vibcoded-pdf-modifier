import { Canvas, Point, Rect, Textbox, util, type FabricObject } from 'fabric'
import { Table } from './objects/table'
import './styles/app.css'
import './core/props'
import { DocumentModel } from './core/document'
import { Editing } from './core/editing'
import type { Editor, NoticeKind } from './core/editor'
import { History } from './core/history'
import { prettyCombo, ShortcutManager, type ActionId } from './core/shortcuts'
import { Viewport } from './core/viewport'
import { ExportDialog } from './ui/export-dialog'
import { EXPORT_FORMATS, Exporter } from './io/exporter'
import { Importer, OPEN_FILTERS } from './io/importer'
import { platform } from './platform'
import { defaultChart } from './charts/chart'
import { editChart } from './charts/chart-dialog'
import { chartObject, isChart } from './charts/chart-object'
import { TableEditor } from './objects/table-editor'
import { ToolManager, type Tool } from './tools/manager'
import { MenuBar, type Menu } from './ui/menubar'
import { Welcome } from './ui/welcome'
import { applyTheme, openPreferences } from './ui/preferences'
import { FileSession } from './core/file-session'
import { PropertiesPanel } from './ui/properties'
import { initOverlay } from './core/overlay'
import { installFonts } from './core/fonts'
import { Layers } from './core/layers'
import { FindBar } from './ui/find-bar'
import { QuickBar } from './ui/quickbar'
import { TextToolbar } from './ui/text-toolbar'
import { Sidebar } from './ui/sidebar'
import { TextSelection } from './ui/text-selection'
import { editTextAt } from './pdf/edit-text'
import { PAPER_STYLES, type PaperStyle } from './core/paper'
import type { Page } from './core/page'
import { settings } from './tools/settings'
import { pageRenderer } from './core/page-renderer'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const workspace = $('workspace')
const zoomLabel = $('zoom-label')
const pointerInfo = $('pointer-info')
const selectionBar = $('selection-bar')

const canvas = new Canvas('stage', {
  width: workspace.clientWidth,
  height: workspace.clientHeight,
  preserveObjectStacking: true,
  enableRetinaScaling: true,
  selectionColor: 'rgba(79,140,255,0.12)',
  selectionBorderColor: '#4f8cff',
  selectionDashArray: [4, 4],
  // Une sélection au cadre prend tout ce qu'elle touche (pas seulement ce qui est entièrement dedans).
  selectionFullyContained: false
})

// --- Notifications -----------------------------------------------------------

function notify(message: string, kind: NoticeKind = 'info', action?: { label: string; run: () => void | Promise<void> }): void {
  const toasts = $('toasts')
  // Un message de progression est remplacé par le suivant (progression ou résultat).
  toasts.querySelectorAll('.toast.info:not(.has-action)').forEach((t) => t.remove())
  const el = document.createElement('div')
  el.className = `toast ${kind}${action ? ' has-action' : ''}`
  el.textContent = message
  if (action) {
    const b = document.createElement('button')
    b.className = 'primary'
    b.textContent = action.label
    b.addEventListener('click', () => {
      el.remove()
      void action.run()
    })
    const close = document.createElement('button')
    close.textContent = 'Ignorer'
    close.addEventListener('click', () => el.remove())
    el.append(b, close)
  }
  toasts.append(el)
  setTimeout(() => el.remove(), action ? 30000 : kind === 'error' ? 8000 : 3500)
}

// --- Contexte d'édition ------------------------------------------------------

const doc = new DocumentModel(canvas)
// 100 % = taille réelle (1 pt = 1/72 pouce affiché à 96 ppp).
const REAL_SIZE = 96 / 72
const viewport = new Viewport(canvas, workspace, (z) => (zoomLabel.textContent = `${Math.round((z / REAL_SIZE) * 100)} %`))
initOverlay(canvas)
installFonts(canvas)
applyTheme()
await doc.addPage()
// Créé plus bas (il a besoin de l'importeur) ; prévenu de chaque modification pour l'état « non enregistré ».
let fileSession: FileSession | undefined
const history = new History(canvas, () => {
  refreshButtons()
  fileSession?.changed()
})

const editor: Editor = {
  canvas,
  doc,
  history,
  viewport,
  notify,
  add: (obj: FabricObject) => canvas.add(obj),
  pointer: () => viewport.pointerScene()
}
const layers = new Layers(editor)
editor.layers = layers
const importer = new Importer(editor)
const exporter = new Exporter(editor)
const editing = new Editing(editor, importer)
const exportDialog = new ExportDialog(editor, exporter)
const session = new FileSession(editor, importer, exporter)
fileSession = session
const shortcuts = new ShortcutManager()

viewport.fit(doc.bounds())
new ResizeObserver(() => canvas.setDimensions({ width: workspace.clientWidth, height: workspace.clientHeight })).observe(workspace)

// --- Outils --------------------------------------------------------------------

const tools = new ToolManager(editor)
const textSelection = new TextSelection(editor)
tools.textSelection = textSelection
const findBar = new FindBar(editor)
new QuickBar(tools)
new TextToolbar(editor)
const tableEditor = new TableEditor(editor)
const properties = new PropertiesPanel(editor, tools, tableEditor)

function setTool(tool: Tool): void {
  tools.set(tool)
}
tools.onChange((tool) =>
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool))
)
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)))
setTool('select')

// Double-clic sur un graphique : rééditer ses données ; sur le texte d'un PDF : le modifier.
canvas.on('mouse:dblclick', ({ target, scenePoint }) => {
  if (!target && tools.tool === 'select') {
    void editTextAt(editor, scenePoint)
    return
  }
  if (target && isChart(target)) {
    canvas.setActiveObject(target)
    document.querySelector<HTMLButtonElement>('.properties button.primary')?.click()
  }
})

// Périphérique détecté : toute tablette exposant des Pointer Events (Wacom, XP-Pen, Huion, Windows Ink…) fonctionne.
workspace.addEventListener('pointermove', (e) => {
  pointerInfo.textContent =
    e.pointerType === 'pen' ? `Stylet · pression ${Math.round(e.pressure * 100)} %` : e.pointerType === 'touch' ? 'Tactile' : 'Souris'
})

// --- Barre de sélection ---------------------------------------------------------

function refreshButtons(): void {
  const hasSelection = canvas.getActiveObjects().length > 0
  selectionBar.hidden = !hasSelection
  ;($('selection-bar').querySelector('[data-action=ungroup]') as HTMLButtonElement).disabled =
    canvas.getActiveObject()?.type !== 'group'
  ;(document.querySelector('[data-action=undo]') as HTMLButtonElement).disabled = !history.canUndo
  ;(document.querySelector('[data-action=redo]') as HTMLButtonElement).disabled = !history.canRedo
}
canvas.on('selection:created', refreshButtons)
canvas.on('selection:updated', refreshButtons)
canvas.on('selection:cleared', refreshButtons)
refreshButtons()

// --- Actions --------------------------------------------------------------------

const docName = (): string => session.name.replace(/\.[^.]+$/, '') || 'Document'

const actions: Record<string, () => void | Promise<void>> = {
  new: async () => {
    if (session.dirty && !doc.isEmpty && !confirm('Le document actuel n’est pas enregistré. L’abandonner ?')) return
    doc.clear()
    layers.reset()
    doc.addPage()
    history.reset()
    viewport.fit(doc.bounds())
    session.newDocument()
  },
  open: async () => session.open(await platform.openFiles(OPEN_FILTERS)),
  insert: async () => importer.insert(await platform.openFiles(OPEN_FILTERS), null),
  save: async () => void (await session.save()),
  'save-as': async () => void (await session.saveAs()),
  print: async () => {
    notify('Préparation de l’impression…')
    const total = doc.pages.length
    const pages = []
    for (const page of doc.pages) {
      const canvasEl = await exporter.raster(page, 200) // 200 ppp : texte net à l'impression
      const png = new Uint8Array(await (await new Promise<Blob>((r) => canvasEl.toBlob((b) => r(b!), 'image/png'))).arrayBuffer())
      pages.push({ png, width: page.width, height: page.height })
      if (total > 5) notify(`Préparation de l’impression… ${pages.length} / ${total}`)
    }
    const ok = await platform.print(pages)
    notify(ok ? 'Document envoyé à l’imprimante' : 'Impression annulée', ok ? 'success' : 'info')
  },
  fullscreen: () => platform.toggleFullscreen(),
  preferences: () => openPreferences(shortcuts),
  // Téléphone : photographier un document et l'insérer (appareil photo arrière).
  camera: async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.setAttribute('capture', 'environment')
    input.onchange = async () => {
      const f = input.files?.[0]
      if (f) await importer.insert([{ name: f.name || 'photo.jpg', data: new Uint8Array(await f.arrayBuffer()) }], null)
    }
    input.click()
  },
  export: () => exportDialog.open(docName()),
  undo: () => history.undo(),
  redo: () => history.redo(),
  'add-page': () => addPageAfter(doc.currentPage()),
  'zoom-in': () => viewport.zoomIn(),
  'zoom-out': () => viewport.zoomOut(),
  'zoom-fit': () => viewport.fit(doc.box(doc.currentPage() ?? doc.pages[0])),
  copy: () => void editing.copy(),
  cut: () => editing.cut(),
  paste: () => editing.paste(),
  duplicate: () => editing.duplicate(),
  delete: () => editing.deleteSelection(),
  group: () => editing.group(),
  ungroup: () => editing.ungroup(),
  front: () => editing.arrange('front'),
  back: () => editing.arrange('back'),
  chart: async () => {
    const spec = await editChart(defaultChart())
    if (!spec) return
    const obj = await chartObject(spec)
    const page = doc.currentPage() ?? doc.pages[0]
    obj.setPositionByOrigin(new Point(page.left + page.width / 2, page.top + page.height / 3), 'center', 'center')
    await history.transaction(() => editor.add(obj))
    setTool('select')
    canvas.setActiveObject(obj)
    canvas.requestRenderAll()
  }
}

Object.assign(actions, {
  'select-all': () => editing.selectAll(),
  'toggle-props': () => void $('properties').classList.toggle('open'),
  'mobile-menu': () => menuBar.openSheet(),
  shortcuts: () => {
    const list = $('shortcuts-list')
    const rows: [string, ActionId][] = [
      ['Ouvrir', 'open'], ['Insérer un fichier', 'insert'], ['Enregistrer', 'save'], ['Exporter', 'export'],
      ['Annuler', 'undo'], ['Rétablir', 'redo'], ['Dupliquer', 'duplicate'], ['Tout sélectionner', 'selectAll'],
      ['Grouper', 'group'], ['Dégrouper', 'ungroup'], ['Supprimer', 'delete'],
      ['Zoom avant (sur le pointeur)', 'zoomIn'], ['Zoom arrière', 'zoomOut'], ['Ajuster à la page', 'zoomReset'],
      ['Sélection', 'tool.select'], ['Stylo', 'tool.pen'], ['Surligneur', 'tool.highlighter'], ['Gomme', 'tool.eraser'],
      ['Formes', 'tool.shape'], ['Texte', 'tool.text'], ['Main', 'tool.hand']
    ]
    list.innerHTML = ''
    for (const [label, id] of rows) {
      list.append(Object.assign(document.createElement('span'), { textContent: label }))
      list.append(Object.assign(document.createElement('kbd'), { textContent: shortcuts.get(id).map(prettyCombo).join('  ou  ') }))
    }
    for (const [label, keys] of [
      ['Copier / Couper / Coller', 'Ctrl+C / Ctrl+X / Ctrl+V'],
      ['Déplacer la vue', 'Espace maintenu, clic molette'],
      ['Ligne droite (stylo, surligneur)', 'Maj, ou stylet immobile en fin de trait'],
      ['Carré, cercle, angle aimanté (formes)', 'Maj'],
      ['Gras / Italique / Souligné (en écrivant)', 'Ctrl+B / Ctrl+I / Ctrl+U']
    ]) {
      list.append(Object.assign(document.createElement('span'), { textContent: label }))
      list.append(Object.assign(document.createElement('kbd'), { textContent: keys }))
    }
    ;($('shortcuts-dialog') as HTMLDialogElement).showModal()
  }
})

async function addPageAfter(page: Page | undefined, style: PaperStyle = settings.value.paper): Promise<void> {
  const size = page ? { width: page.width, height: page.height } : undefined
  const bg = style === 'plain' ? undefined : { kind: 'paper' as const, style, color: '#ffffff' }
  const added = await history.transaction(() => doc.addPage(size, { after: page, bg }))
  viewport.showRect(doc.box(added))
}

const sidebar = new Sidebar(editor, exporter, layers, (p) => addPageAfter(p))

// --- Navigation entre les pages -----------------------------------------------------

const pageInput = $<HTMLInputElement>('page-input')
const pageCount = $('page-count')
let navTimer = 0
canvas.on('after:render', () => {
  window.clearTimeout(navTimer)
  navTimer = window.setTimeout(() => {
    const pages = doc.pages
    pageCount.textContent = String(pages.length)
    pageInput.max = String(pages.length)
    if (document.activeElement !== pageInput) pageInput.value = String(Math.max(1, pages.indexOf(doc.currentPage()!) + 1))
  }, 120)
})
function goToPage(n: number): void {
  const pages = doc.pages
  const page = pages[Math.min(pages.length, Math.max(1, n)) - 1]
  if (page) viewport.showRect(doc.box(page))
}
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    goToPage(Number(pageInput.value))
    pageInput.blur()
  } else if (e.key === 'Escape') pageInput.blur()
})
const pageIndex = (): number => doc.pages.indexOf(doc.currentPage()!) + 1

Object.assign(actions, {
  find: () => findBar.open(),
  goto: () => {
    pageInput.focus()
    pageInput.select()
  },
  'toggle-sidebar': () => sidebar.toggle(),
  'page-next': () => goToPage(pageIndex() + 1),
  'page-prev': () => goToPage(pageIndex() - 1),
  'zoom-width': () => {
    const page = doc.currentPage() ?? doc.pages[0]
    const center = canvas.getVpCenter()
    viewport.fitWidth(doc.box(page))
    viewport.centerOn(new Point(page.left + page.width / 2, center.y))
  },
  'zoom-actual': () => viewport.zoomAt(REAL_SIZE, null)
})
for (const p of PAPER_STYLES) actions[`add-page:${p.id}`] = () => addPageAfter(doc.currentPage(), p.id)

const run = (name: string) => (): void => {
  if (name.startsWith('tool:')) return setTool(name.slice(5) as Tool)
  if (name.startsWith('recent:')) return void session.openRecent(name.slice(7))
  void Promise.resolve(actions[name]?.()).then(refreshButtons)
}

const menus: Menu[] = [
  {
    label: 'Fichier',
    items: [
      { label: 'Nouveau document A4', action: 'new', shortcut: 'new' },
      { label: 'Ouvrir…', action: 'open', shortcut: 'open', hint: 'PDF, images, Word, Excel, PowerPoint, Xournal…' },
      '-',
      () =>
        session.recent.length
          ? [{ label: 'Récents :', action: 'noop' }, ...session.recent.slice(0, 8).map((r) => ({ label: `   ${r.name}`, action: `recent:${r.path}`, hint: r.path })), '-' as const]
          : [],
      { label: 'Enregistrer', action: 'save', shortcut: 'save', hint: 'Dans le fichier ouvert (projet ou PDF)' },
      { label: 'Enregistrer sous…', action: 'save-as', shortcut: 'saveAs', hint: 'Projet Feuillet ou PDF modifiable' },
      { label: 'Exporter…', action: 'export', shortcut: 'export', hint: 'PDF, PNG, JPEG, SVG, Word, OpenDocument…' },
      '-',
      { label: 'Imprimer…', action: 'print', shortcut: 'print' },
      '-',
      { label: 'Préférences…', action: 'preferences', shortcut: 'preferences', hint: 'Raccourcis (touches de zoom…), thème, papier, stylet' }
    ]
  },
  {
    label: 'Édition',
    items: [
      { label: 'Annuler', action: 'undo', shortcut: 'undo' },
      { label: 'Rétablir', action: 'redo', shortcut: 'redo' },
      '-',
      { label: 'Couper', action: 'cut' },
      { label: 'Copier', action: 'copy' },
      { label: 'Coller', action: 'paste' },
      { label: 'Dupliquer', action: 'duplicate', shortcut: 'duplicate' },
      { label: 'Supprimer', action: 'delete', shortcut: 'delete' },
      '-',
      { label: 'Tout sélectionner', action: 'select-all', shortcut: 'selectAll' },
      { label: 'Grouper', action: 'group', shortcut: 'group' },
      { label: 'Dégrouper', action: 'ungroup', shortcut: 'ungroup' },
      { label: 'Premier plan', action: 'front', shortcut: 'front' },
      { label: 'Arrière-plan', action: 'back', shortcut: 'back' }
    ]
  },
  {
    label: 'Insertion',
    items: [
      { label: 'Image, PDF ou document…', action: 'insert', shortcut: 'insert' },
      ...(matchMedia('(pointer: coarse)').matches ? [{ label: 'Prendre une photo…', action: 'camera' }] : []),
      { label: 'Page (style par défaut)', action: 'add-page' },
      ...PAPER_STYLES.map((p) => ({ label: `Page — ${p.label}`, action: `add-page:${p.id}` })),
      '-',
      { label: 'Zone de texte', action: 'tool:text', shortcut: 'tool.text', hint: 'Cliquez, glissez, ou entourez une zone à main levée' },
      { label: 'Tableau', action: 'tool:table' },
      { label: 'Graphique…', action: 'chart' },
      { label: 'Forme', action: 'tool:shape', shortcut: 'tool.shape' }
    ]
  },
  {
    label: 'Outils',
    items: [
      { label: 'Sélection', action: 'tool:select', shortcut: 'tool.select' },
      { label: 'Lasso', action: 'tool:lasso', shortcut: 'tool.lasso' },
      { label: 'Sélectionner le texte du PDF', action: 'tool:textselect', shortcut: 'tool.textselect' },
      { label: 'Modifier le texte du PDF', action: 'tool:edittext', shortcut: 'tool.edittext', hint: 'Ou double-clic sur un texte du PDF' },
      { label: 'Stylo', action: 'tool:pen', shortcut: 'tool.pen' },
      { label: 'Surligneur', action: 'tool:highlighter', shortcut: 'tool.highlighter' },
      { label: 'Gomme', action: 'tool:eraser', shortcut: 'tool.eraser' },
      { label: 'Formes', action: 'tool:shape', shortcut: 'tool.shape' },
      { label: 'Texte', action: 'tool:text', shortcut: 'tool.text' },
      { label: 'Main', action: 'tool:hand', shortcut: 'tool.hand' }
    ]
  },
  {
    label: 'Affichage',
    items: [
      { label: 'Zoom avant', action: 'zoom-in', shortcut: 'zoomIn' },
      { label: 'Zoom arrière', action: 'zoom-out', shortcut: 'zoomOut' },
      { label: 'Ajuster à la page', action: 'zoom-fit', shortcut: 'zoomReset' },
      { label: 'Ajuster à la largeur', action: 'zoom-width', shortcut: 'zoomWidth' },
      { label: 'Taille réelle (100 %)', action: 'zoom-actual', shortcut: 'zoomActual' },
      '-',
      { label: 'Pages, sommaire et calques', action: 'toggle-sidebar', shortcut: 'sidebar' },
      { label: 'Plein écran', action: 'fullscreen', shortcut: 'fullscreen' },
      { label: 'Rechercher…', action: 'find', shortcut: 'find' },
      { label: 'Aller à la page…', action: 'goto', shortcut: 'goto' },
      { label: 'Page suivante', action: 'page-next', shortcut: 'pageNext' },
      { label: 'Page précédente', action: 'page-prev', shortcut: 'pagePrev' }
    ]
  },
  { label: 'Aide', items: [{ label: 'Raccourcis clavier', action: 'shortcuts' }] }
]

const needsSelection = new Set(['cut', 'copy', 'duplicate', 'delete', 'group', 'ungroup', 'front', 'back'])
const menuBar = new MenuBar($('menubar'), menus, (a) => run(a)(), shortcuts, (a) => {
  if (a === 'noop') return false
  if (a === 'undo') return history.canUndo
  if (a === 'redo') return history.canRedo
  if (a === 'ungroup') return canvas.getActiveObject()?.type === 'group'
  if (a === 'group') return canvas.getActiveObjects().length > 1
  if (needsSelection.has(a)) return canvas.getActiveObjects().length > 0
  return true
})
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => b.addEventListener('click', run(b.dataset.action!)))

shortcuts.on('zoomIn', () => viewport.zoomIn())
shortcuts.on('zoomOut', () => viewport.zoomOut())
shortcuts.on('zoomReset', run('zoom-fit'))
for (const name of ['undo', 'redo', 'new', 'open', 'insert', 'save', 'export', 'duplicate', 'delete', 'group', 'ungroup', 'front', 'back'] as const) {
  shortcuts.on(name, run(name))
}
shortcuts.on('selectAll', () => editing.selectAll())
shortcuts.on('deselect', () => {
  canvas.discardActiveObject()
  canvas.requestRenderAll()
})
for (const [dir, dx, dy] of [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]] as const) {
  shortcuts.on(`nudge.${dir}`, () => editing.nudge(dx, dy))
  shortcuts.on(`nudge.${dir}.big`, () => editing.nudge(dx * 10, dy * 10))
}
shortcuts.on('find', run('find'))
shortcuts.on('saveAs', run('save-as'))
shortcuts.on('print', run('print'))
shortcuts.on('fullscreen', run('fullscreen'))
shortcuts.on('preferences', run('preferences'))
shortcuts.on('goto', run('goto'))
shortcuts.on('sidebar', run('toggle-sidebar'))
shortcuts.on('pageNext', run('page-next'))
shortcuts.on('pagePrev', run('page-prev'))
shortcuts.on('pageFirst', () => goToPage(1))
shortcuts.on('pageLast', () => goToPage(doc.pages.length))
shortcuts.on('zoomWidth', run('zoom-width'))
shortcuts.on('zoomActual', run('zoom-actual'))
for (const tool of ['select', 'lasso', 'textselect', 'edittext', 'pen', 'highlighter', 'eraser', 'shape', 'text', 'hand'] as const) {
  shortcuts.on(`tool.${tool}`, () => setTool(tool))
}

$('key-zoom-in').textContent = prettyCombo(shortcuts.get('zoomIn')[0])
$('key-zoom-out').textContent = prettyCombo(shortcuts.get('zoomOut')[0])

// --- Glisser-déposer et « Ouvrir avec » ------------------------------------------

const dropOverlay = $('drop-overlay')
let dragDepth = 0
workspace.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  dropOverlay.hidden = false
})
workspace.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) dropOverlay.hidden = true
})
workspace.addEventListener('dragover', (e) => e.preventDefault())
workspace.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  dropOverlay.hidden = true
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  const opened = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))
  const rect = canvas.upperCanvasEl.getBoundingClientRect()
  const at = new Point(e.clientX - rect.left, e.clientY - rect.top).transform(util.invertTransform(canvas.viewportTransform))
  await importer.insert(opened, at)
  refreshButtons()
})

platform.onFilesOpened((files) => void session.open(files))
// Accueil au démarrage (sauf si un fichier a été ouvert avec Feuillet).
const welcome = new Welcome(session, {
  newDoc: (paper) => {
    if (paper !== 'plain') {
      settings.set('paper', paper)
      doc.pages[0].set({ bg: { kind: 'paper', style: paper, color: '#ffffff' } } as never)
      history.reset()
      canvas.requestRenderAll()
    }
  },
  open: () => void actions.open(),
  openRecent: (path) => void session.openRecent(path)
})
const pending = await platform.pendingFiles()
if (pending.length > 0) await session.open(pending)
else {
  void welcome.show()
  await session.offerRecovery()
}
// Choisir un outil ou ouvrir / déposer un fichier ferme l'accueil.
tools.onChange(() => welcome.hide())
canvas.on('object:added', () => welcome.visible && !doc.isEmpty && welcome.hide())

// Accès pour les tests automatisés de bout en bout.
// Fabriques d'objets pour les tests automatisés (mêmes classes que l'interface).
const make = {
  textbox: (text: string, o: object) => new Textbox(text, o),
  rect: (o: object) => new Rect(o),
  table: (rows: number, cols: number) => Table.create(rows, cols)
}
Object.assign(window, { __feuillet: { make, editor, importer, exporter, editing, tools, properties, tableEditor, settings, pageRenderer, formats: EXPORT_FORMATS, welcome, fileSession: session, layers, sidebar, findBar, textSelection, goToPage } })
