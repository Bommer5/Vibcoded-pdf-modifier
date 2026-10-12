import { Canvas, PencilBrush } from 'fabric'
import './styles/app.css'
import { DocumentModel } from './core/document'
import { History } from './core/history'
import { prettyCombo, ShortcutManager } from './core/shortcuts'
import { Viewport } from './core/viewport'

type Tool = 'select' | 'pen' | 'hand'

const workspace = document.getElementById('workspace') as HTMLElement
const zoomLabel = document.getElementById('zoom-label') as HTMLElement
const pointerInfo = document.getElementById('pointer-info') as HTMLElement

const canvas = new Canvas('stage', {
  width: workspace.clientWidth,
  height: workspace.clientHeight,
  backgroundColor: '#3a3b42',
  preserveObjectStacking: true,
  enableRetinaScaling: true,
  selectionColor: 'rgba(79,140,255,0.12)',
  selectionBorderColor: '#4f8cff',
  selectionDashArray: [4, 4]
})

const doc = new DocumentModel(canvas)
const viewport = new Viewport(canvas, workspace, (z) => (zoomLabel.textContent = `${Math.round(z * 100)} %`))
const shortcuts = new ShortcutManager()

doc.addPage('A4')
const history = new History(canvas)
viewport.fit(doc.bounds())

new ResizeObserver(() => {
  canvas.setDimensions({ width: workspace.clientWidth, height: workspace.clientHeight })
}).observe(workspace)

// --- Outils ---------------------------------------------------------------

const brush = new PencilBrush(canvas)
brush.color = '#1b1b1f'
brush.width = 2
canvas.freeDrawingBrush = brush

function setTool(tool: Tool): void {
  canvas.isDrawingMode = tool === 'pen'
  canvas.selection = tool === 'select'
  viewport.setHandTool(tool === 'hand')
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool)
  })
}

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool))
})
setTool('select')

// Affiche le périphérique détecté (souris / stylet / tactile) et la pression :
// toute tablette exposant des Pointer Events (Wacom, XP-Pen, Huion, Windows Ink…) est prise en charge.
workspace.addEventListener('pointermove', (e) => {
  pointerInfo.textContent =
    e.pointerType === 'pen' ? `Stylet · pression ${Math.round(e.pressure * 100)} %` : e.pointerType === 'touch' ? 'Tactile' : 'Souris'
})

// --- Actions --------------------------------------------------------------

function deleteSelection(): void {
  const active = canvas.getActiveObjects()
  if (active.length === 0) return
  canvas.discardActiveObject()
  active.forEach((o) => canvas.remove(o))
  canvas.requestRenderAll()
}

const actions: Record<string, () => void> = {
  undo: () => void history.undo(),
  redo: () => void history.redo(),
  'new-a4': () => {
    doc.addPage('A4')
    viewport.fit(doc.bounds())
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
  b.addEventListener('click', () => actions[b.dataset.action!]?.())
})

shortcuts.on('zoomIn', () => viewport.zoomIn())
shortcuts.on('zoomOut', () => viewport.zoomOut())
shortcuts.on('zoomReset', () => viewport.fit(doc.bounds()))
shortcuts.on('undo', actions.undo)
shortcuts.on('redo', actions.redo)
shortcuts.on('newPage', actions['new-a4'])
shortcuts.on('delete', deleteSelection)
shortcuts.on('tool.select', () => setTool('select'))
shortcuts.on('tool.pen', () => setTool('pen'))
shortcuts.on('tool.hand', () => setTool('hand'))

;(document.getElementById('key-zoom-in') as HTMLElement).textContent = prettyCombo(shortcuts.get('zoomIn')[0])
;(document.getElementById('key-zoom-out') as HTMLElement).textContent = prettyCombo(shortcuts.get('zoomOut')[0])
