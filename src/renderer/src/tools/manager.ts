import { Ellipse, Path, Point, Rect, Textbox, Triangle, type FabricObject, type TPointerEventInfo } from 'fabric'
import type { Editor } from '../core/editor'
import { isPageLayer } from '../core/props'
import { ShapedText } from '../objects/shaped-text'
import { Table } from '../objects/table'
import { buildInk, eraseInk, nearObject, type InkObject, type InkPoint } from './ink'
import { dashArray, settings, type ShapeKind } from './settings'

export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'table' | 'hand'

/** Tenir le stylet immobile ce temps (ms) en fin de trait le transforme en ligne droite. */
const HOLD_TO_STRAIGHTEN_MS = 650
const DRAW_TOOLS: Tool[] = ['pen', 'highlighter', 'eraser', 'shape']

interface Stroke {
  tool: 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text'
  points: InkPoint[]
  start: Point
  straight: boolean
  holdTimer?: number
  lastMove: Point
}

/**
 * Outils de dessin. Les gestes sont lus directement depuis les Pointer Events :
 * pression, bouton gomme du stylet, évènements « coalescés » (traits fluides
 * même à 240 Hz), rejet de la paume (le tactile déplace la vue dès qu'un stylet est détecté).
 */
export class ToolManager {
  tool: Tool = 'select'
  private stroke: Stroke | null = null
  private shiftHeld = false
  private penSeen = false
  private listeners = new Set<(t: Tool) => void>()

  constructor(private ed: Editor) {
    const c = ed.canvas
    c.on('mouse:down', (o) => this.down(o))
    c.on('mouse:move', (o) => this.move(o))
    c.on('mouse:up', () => this.up())
    c.on('mouse:out', () => this.tool === 'eraser' && !this.stroke && this.clearTop())
    c.on('text:editing:exited', ({ target }) => {
      if (target && !(target as Textbox).text?.trim()) c.remove(target)
    })
    c.on('object:modified', ({ target }) => {
      if (target instanceof Table) target.bakeScale()
    })
    window.addEventListener('keydown', (e) => (this.shiftHeld = e.shiftKey))
    window.addEventListener('keyup', (e) => (this.shiftHeld = e.shiftKey))
    // Un stylet a été vu : le doigt ne dessine plus, il déplace la vue (rejet de la paume).
    ed.canvas.upperCanvasEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen' && !this.penSeen) {
        this.penSeen = true
        ed.viewport.setTouchPan(true)
      }
    }, { capture: true })
    settings.onChange(() => this.applyCursor())
  }

  onChange(fn: (t: Tool) => void): void {
    this.listeners.add(fn)
  }

  set(tool: Tool): void {
    const c = this.ed.canvas
    this.tool = tool
    c.isDrawingMode = false
    c.selection = tool === 'select'
    c.skipTargetFind = DRAW_TOOLS.includes(tool) || tool === 'table'
    this.ed.viewport.setHandTool(tool === 'hand')
    if (tool !== 'select' && tool !== 'text') c.discardActiveObject()
    // Les objets restent sélectionnables avec l'outil Sélection, et les textes avec l'outil Texte.
    this.clearTop()
    this.applyCursor()
    c.requestRenderAll()
    this.listeners.forEach((l) => l(tool))
  }

  private applyCursor(): void {
    const c = this.ed.canvas
    const cursor =
      this.tool === 'text' ? 'text' : DRAW_TOOLS.includes(this.tool) || this.tool === 'table' ? 'crosshair' : 'default'
    c.defaultCursor = cursor
    if (this.tool !== 'select') c.hoverCursor = this.tool === 'text' ? 'text' : cursor
    else c.hoverCursor = 'move'
  }

  // --- Gestes --------------------------------------------------------------------

  private down(o: TPointerEventInfo): void {
    const e = o.e as PointerEvent
    if (e.pointerType === 'touch' && this.penSeen) return
    if ('button' in e && e.button !== 0 && e.button !== 5) return
    const p = o.scenePoint

    if (this.tool === 'text') {
      if (o.target && 'text' in o.target) return // clic dans un texte existant : édition normale
      this.stroke = { tool: 'text', points: [[p.x, p.y, 0.5]], start: p, straight: false, lastMove: p }
      return
    }
    if (this.tool === 'table') return this.createTable(p)

    // Bout gomme du stylet (ou bouton 5) : gomme le temps du geste, quel que soit l'outil.
    const eraserTip = e.button === 5 || ((e.buttons ?? 0) & 32) !== 0
    const tool = eraserTip && this.tool !== 'select' && this.tool !== 'hand' ? 'eraser' : this.tool
    if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'eraser' && tool !== 'shape') return

    this.stroke = { tool, points: [[p.x, p.y, pressureOf(e)]], start: p, straight: false, lastMove: p }
    if (tool === 'eraser') {
      this.ed.history.begin()
      this.erase(p)
    }
    this.armHold()
    this.preview()
  }

  private move(o: TPointerEventInfo): void {
    const e = o.e as PointerEvent
    if (!this.stroke) {
      if (this.tool === 'eraser') this.drawEraserCursor(o.scenePoint)
      return
    }
    const s = this.stroke
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const samples = events.length ? events : [e]
    for (const ev of samples) {
      const p = this.ed.canvas.getScenePoint(ev)
      if (s.tool === 'eraser') this.erase(p)
      else s.points.push([p.x, p.y, pressureOf(ev)])
    }
    const last = this.ed.canvas.getScenePoint(e)
    if (last.distanceFrom(s.lastMove) * this.ed.viewport.zoom > 3) {
      s.lastMove = last
      this.armHold()
    }
    this.preview()
    if (s.tool === 'eraser') this.drawEraserCursor(last)
  }

  private up(): void {
    const s = this.stroke
    if (!s) return
    window.clearTimeout(s.holdTimer)
    this.stroke = null
    this.clearTop()
    if (s.tool === 'eraser') {
      this.ed.history.end()
      return
    }
    if (s.tool === 'text') return this.createText(s)
    const pts = this.finalPoints(s)
    if (s.tool === 'shape') {
      const obj = this.buildShape(settings.value.shape, s.start, new Point(pts.at(-1)![0], pts.at(-1)![1]))
      if (obj) this.ed.add(obj)
      return
    }
    const v = settings.value
    const ink = buildInk({
      tool: s.tool,
      points: pts,
      size: s.tool === 'pen' ? v.penWidth : v.highlighterWidth,
      color: s.tool === 'pen' ? v.penColor : v.highlighterColor,
      style: s.tool === 'pen' ? v.penStyle : 'solid',
      pressure: s.tool === 'pen' && v.pressure
    })
    this.ed.add(ink)
  }

  /** Maintenir Maj, ou garder le stylet immobile en fin de trait = ligne droite. */
  private finalPoints(s: Stroke): InkPoint[] {
    const straight = this.shiftHeld || s.straight || s.tool === 'shape'
    if (!straight || s.points.length < 2) return s.points
    const first = s.points[0]
    const last = s.points.at(-1)!
    const end = s.tool === 'shape' ? new Point(last[0], last[1]) : snapAngle(new Point(first[0], first[1]), new Point(last[0], last[1]))
    const p = Math.max(...s.points.map((q) => q[2]))
    return [[first[0], first[1], p], [end.x, end.y, p]]
  }

  private armHold(): void {
    const s = this.stroke
    if (!s || s.tool === 'eraser' || s.tool === 'shape' || s.tool === 'text') return
    window.clearTimeout(s.holdTimer)
    s.holdTimer = window.setTimeout(() => {
      if (this.stroke !== s || s.points.length < 4) return
      const [x0, y0] = s.points[0]
      const [x1, y1] = s.points.at(-1)!
      if (Math.hypot(x1 - x0, y1 - y0) * this.ed.viewport.zoom < 30) return
      s.straight = true
      this.preview()
    }, HOLD_TO_STRAIGHTEN_MS)
  }

  // --- Aperçu (calque supérieur, sans redessiner le document) -----------------------

  private clearTop(): void {
    const c = this.ed.canvas
    c.clearContext(c.contextTop)
  }

  private withTop(draw: (ctx: CanvasRenderingContext2D) => void): void {
    const c = this.ed.canvas
    const ctx = c.contextTop
    c.clearContext(ctx)
    ctx.save()
    const v = c.viewportTransform
    const r = c.getRetinaScaling()
    ctx.setTransform(v[0] * r, v[1] * r, v[2] * r, v[3] * r, v[4] * r, v[5] * r)
    draw(ctx)
    ctx.restore()
  }

  private preview(): void {
    const s = this.stroke
    if (!s || s.tool === 'eraser') return
    if (s.tool === 'text') return this.previewText(s)
    const v = settings.value
    const pts = this.finalPoints(s)
    if (s.tool === 'shape') {
      const obj = this.buildShape(v.shape, s.start, new Point(pts.at(-1)![0], pts.at(-1)![1]))
      this.withTop((ctx) => obj?.render(ctx))
      return
    }
    const ink = buildInk({
      tool: s.tool,
      points: pts,
      size: s.tool === 'pen' ? v.penWidth : v.highlighterWidth,
      color: s.tool === 'pen' ? v.penColor : v.highlighterColor,
      style: s.tool === 'pen' ? v.penStyle : 'solid',
      pressure: s.tool === 'pen' && v.pressure
    })
    ink.set({ globalCompositeOperation: 'source-over' })
    this.withTop((ctx) => ink.render(ctx))
  }

  private drawEraserCursor(at: Point): void {
    const r = settings.value.eraserSize / 2 / this.ed.viewport.zoom
    this.withTop((ctx) => {
      ctx.beginPath()
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
      ctx.lineWidth = 1 / this.ed.viewport.zoom
      ctx.strokeStyle = '#4f8cff'
      ctx.fillStyle = 'rgba(79,140,255,0.12)'
      ctx.fill()
      ctx.stroke()
    })
  }

  // --- Gomme ---------------------------------------------------------------------------

  private erase(at: Point): void {
    const c = this.ed.canvas
    const radius = settings.value.eraserSize / 2 / this.ed.viewport.zoom
    const partial = settings.value.eraserMode === 'partial'
    for (const obj of c.getObjects()) {
      if (isPageLayer(obj) || !obj.visible) continue
      const ink = (obj as InkObject).ink
      const shape = (obj as FabricObject & { shape?: string }).shape
      if (!ink && !shape) continue // images, textes, tableaux, graphiques : jamais effacés par mégarde
      if (ink && partial) {
        const pieces = eraseInk(obj as InkObject, at, radius)
        if (!pieces) continue
        const index = c.getObjects().indexOf(obj)
        c.remove(obj)
        pieces.forEach((piece, i) => c.insertAt(index + i, piece))
      } else if (nearObject(obj, at, radius)) {
        c.remove(obj)
      }
    }
    c.requestRenderAll()
  }

  // --- Formes ------------------------------------------------------------------------

  private buildShape(kind: ShapeKind, a: Point, b: Point): FabricObject | null {
    const v = settings.value
    const zoom = this.ed.viewport.zoom
    let end = b
    if (this.shiftHeld) {
      if (kind === 'line' || kind === 'arrow') end = snapAngle(a, b, true)
      else {
        const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        end = new Point(a.x + Math.sign(b.x - a.x || 1) * d, a.y + Math.sign(b.y - a.y || 1) * d)
      }
    }
    // Simple clic : forme de taille par défaut.
    if (a.distanceFrom(end) * zoom < 4) end = new Point(a.x + 100, a.y + (kind === 'line' || kind === 'arrow' ? 0 : 70))
    const common = {
      stroke: v.shapeStroke,
      strokeWidth: v.shapeWidth,
      strokeDashArray: dashArray(v.shapeStyle, v.shapeWidth),
      strokeLineCap: 'round' as const,
      strokeLineJoin: 'round' as const,
      strokeUniform: true,
      fill: kind === 'line' || kind === 'arrow' || v.shapeFill === 'transparent' ? '' : v.shapeFill
    }
    const left = Math.min(a.x, end.x)
    const top = Math.min(a.y, end.y)
    const width = Math.abs(end.x - a.x)
    const height = Math.abs(end.y - a.y)
    let obj: FabricObject
    switch (kind) {
      case 'rect':
        obj = new Rect({ left, top, width, height, ...common })
        break
      case 'ellipse':
        obj = new Ellipse({ left, top, rx: width / 2, ry: height / 2, ...common })
        break
      case 'triangle':
        obj = new Triangle({ left, top, width, height, ...common })
        break
      case 'line':
        obj = new Path(`M ${a.x} ${a.y} L ${end.x} ${end.y}`, common)
        break
      case 'arrow': {
        const ang = Math.atan2(end.y - a.y, end.x - a.x)
        const head = Math.max(10, v.shapeWidth * 4)
        const h1 = new Point(end.x - head * Math.cos(ang - 0.45), end.y - head * Math.sin(ang - 0.45))
        const h2 = new Point(end.x - head * Math.cos(ang + 0.45), end.y - head * Math.sin(ang + 0.45))
        obj = new Path(`M ${a.x} ${a.y} L ${end.x} ${end.y} M ${h1.x} ${h1.y} L ${end.x} ${end.y} L ${h2.x} ${h2.y}`, {
          ...common,
          strokeDashArray: null
        })
        break
      }
    }
    obj.set({ shape: kind } as never)
    obj.setCoords()
    return obj
  }

  // --- Texte et tableau ----------------------------------------------------------------

  /**
   * Geste de l'outil Texte :
   *  - clic : texte qui s'élargit en tapant ;
   *  - glisser en diagonale : zone rectangulaire de cette taille ;
   *  - entourer une zone (rond, forme libre…) : le texte s'écoule dans la forme dessinée.
   */
  private textGesture(s: Stroke): 'click' | 'rect' | 'free' {
    const pts = s.points
    const zoom = this.ed.viewport.zoom
    const end = pts.at(-1)!
    const diag = Math.hypot(end[0] - s.start.x, end[1] - s.start.y)
    if (diag * zoom < 6 && pathLength(pts) * zoom < 12) return 'click'
    return pathLength(pts) > diag * 1.6 ? 'free' : 'rect'
  }

  private previewText(s: Stroke): void {
    const kind = this.textGesture(s)
    const zoom = this.ed.viewport.zoom
    this.withTop((ctx) => {
      ctx.setLineDash([5 / zoom, 4 / zoom])
      ctx.lineWidth = 1.5 / zoom
      ctx.strokeStyle = '#4f8cff'
      ctx.fillStyle = 'rgba(79,140,255,0.08)'
      ctx.beginPath()
      if (kind === 'rect') {
        const [x, y] = s.points.at(-1)!
        ctx.rect(s.start.x, s.start.y, x - s.start.x, y - s.start.y)
      } else {
        s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.closePath()
      }
      ctx.fill()
      ctx.stroke()
    })
  }

  private createText(s: Stroke): void {
    const v = settings.value
    const style = { fontFamily: v.fontFamily, fontSize: v.fontSize, fill: v.textColor, lineHeight: 1.25 }
    const kind = this.textGesture(s)
    const end = s.points.at(-1)!
    let box: Textbox
    if (kind === 'free') {
      box = ShapedText.fromOutline(s.points.map(([x, y]) => [x, y]), style)
    } else if (kind === 'rect') {
      box = new Textbox('', {
        ...style,
        left: Math.min(s.start.x, end[0]),
        top: Math.min(s.start.y, end[1]),
        width: Math.max(40, Math.abs(end[0] - s.start.x)),
        splitByGrapheme: false
      })
    } else {
      box = new Textbox('', { ...style, left: s.start.x, top: s.start.y - v.fontSize * 0.6, width: 240, splitByGrapheme: false })
    }
    this.ed.add(box)
    this.set('select')
    this.ed.canvas.setActiveObject(box)
    box.enterEditing()
    box.hiddenTextarea?.focus()
    this.ed.canvas.requestRenderAll()
  }

  private createTable(at: Point): void {
    const table = Table.create(settings.value.tableRows, settings.value.tableCols)
    table.set({ left: at.x, top: at.y })
    table.setCoords()
    this.ed.add(table)
    this.set('select')
    this.ed.canvas.setActiveObject(table)
    this.ed.canvas.requestRenderAll()
  }
}

function pathLength(pts: InkPoint[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return len
}

function pressureOf(e: PointerEvent | MouseEvent | TouchEvent): number {
  const p = (e as PointerEvent).pressure
  // Souris : 0.5 constant ; stylet : pression réelle ; certains pilotes envoient 0 au contact.
  return (e as PointerEvent).pointerType === 'pen' ? Math.max(0.05, p || 0.5) : 0.5
}

/** Aimante l'angle à 45° près (à ±7°), ou à 15° si `strict`. */
function snapAngle(a: Point, b: Point, strict = false): Point {
  const len = a.distanceFrom(b)
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const step = strict ? Math.PI / 12 : Math.PI / 4
  const snapped = Math.round(ang / step) * step
  if (!strict && Math.abs(snapped - ang) > (7 * Math.PI) / 180) return b
  return new Point(a.x + len * Math.cos(snapped), a.y + len * Math.sin(snapped))
}

