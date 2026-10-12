import { Canvas, PencilBrush, Point, util, type FabricObject } from 'fabric'
import './styles/app.css'
import './core/props'
import { DocumentModel } from './core/document'
import { Editing } from './core/editing'
import type { Editor, NoticeKind } from './core/editor'
import { History } from './core/history'
import { prettyCombo, ShortcutManager } from './core/shortcuts'
import { Viewport } from './core/viewport'
import { ExportDialog } from './ui/export-dialog'
import { EXPORT_FORMATS, Exporter } from './io/exporter'
import { Importer, OPEN_FILTERS } from './io/importer'
import { platform } from './platform'

type Tool = 'select' | 'pen' | 'hand'

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

function notify(message: string, kind: NoticeKind = 'info'): void {
  const toasts = $('toasts')
  // Un message de progression est remplacé par le suivant (progression ou résultat).
  toasts.querySelectorAll('.toast.info').forEach((t) => t.remove())
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  toasts.append(el)
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500)
}

// --- Contexte d'édition ------------------------------------------------------

const doc = new DocumentModel(canvas)
const viewport = new Viewport(canvas, workspace, (z) => (zoomLabel.textContent = `${Math.round(z * 100)} %`))
await doc.addPage()
const history = new History(canvas, () => refreshButtons())

const editor: Editor = {
  canvas,
  doc,
  history,
  viewport,
  notify,
  add: (obj: FabricObject) => canvas.add(obj),
  pointer: () => viewport.pointerScene()
}
const importer = new Importer(editor)
const exporter = new Exporter(editor)
const editing = new Editing(editor, importer)
const exportDialog = new ExportDialog(editor, exporter)
const shortcuts = new ShortcutManager()

viewport.fit(doc.bounds())
new ResizeObserver(() => canvas.setDimensions({ width: workspace.clientWidth, height: workspace.clientHeight })).observe(workspace)

// --- Outils --------------------------------------------------------------------

const brush = new PencilBrush(canvas)
brush.color = '#1b1b1f'
brush.width = 2
canvas.freeDrawingBrush = brush

function setTool(tool: Tool): void {
  canvas.isDrawingMode = tool === 'pen'
  canvas.selection = tool === 'select'
  viewport.setHandTool(tool === 'hand')
  if (tool !== 'select') {
    canvas.discardActiveObject()
    canvas.requestRenderAll()
  }
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool))
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)))
setTool('select')

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

const docName = (): string => document.title.replace(/ — Feuillet$/, '').replace(/\.[^.]+$/, '') || 'Document'

const actions: Record<string, () => void | Promise<void>> = {
  new: async () => {
    if (!doc.isEmpty && history.canUndo && !confirm('Le document actuel sera fermé. Continuer ?')) return
    doc.clear()
    await doc.addPage()
    history.reset()
    viewport.fit(doc.bounds())
    document.title = 'Feuillet'
  },
  open: async () => importer.open(await platform.openFiles(OPEN_FILTERS)),
  insert: async () => importer.insert(await platform.openFiles(OPEN_FILTERS), null),
  save: async () => {
    const format = EXPORT_FORMATS.find((f) => f.id === 'feuillet')!
    try {
      const saved = await exporter.run({ format, pages: doc.pages, dpi: 150, name: docName() })
      if (saved) notify('Projet enregistré', 'success')
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  },
  export: () => exportDialog.open(docName()),
  undo: () => history.undo(),
  redo: () => history.redo(),
  'add-page': async () => {
    await history.transaction(() => doc.addPage(undefined, { after: doc.currentPage() }))
  },
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
  back: () => editing.arrange('back')
}

const run = (name: string) => (): void => {
  void Promise.resolve(actions[name]?.()).then(refreshButtons)
}
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
shortcuts.on('tool.select', () => setTool('select'))
shortcuts.on('tool.pen', () => setTool('pen'))
shortcuts.on('tool.hand', () => setTool('hand'))

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

platform.onFilesOpened((files) => void importer.open(files))
const pending = await platform.pendingFiles()
if (pending.length > 0) await importer.open(pending)

// Accès pour les tests automatisés de bout en bout.
Object.assign(window, { __feuillet: { editor, importer, exporter, editing, formats: EXPORT_FORMATS } })
