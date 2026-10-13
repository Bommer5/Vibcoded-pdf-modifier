import { ActiveSelection, Ellipse, Path, Point, Rect, Textbox, Triangle, type FabricObject, type TPointerEventInfo } from 'fabric'
import type { Editor } from '../core/editor'
import { isPageLayer } from '../core/props'
import { ShapedText } from '../objects/shaped-text'
import { Table } from '../objects/table'
import { buildMarkup } from '../pdf/text'
import { editTextAt } from '../pdf/edit-text'
import { hasNative, nativeCountInside, nativeRecognize, type Recognized } from '../native/core'
import type { TextSelection } from '../ui/text-selection'
import { buildInk, eraseInk, nearObject, scenePoints, type InkObject, type InkPoint } from './ink'
import { dashArray, settings, type PenButtonAction, type ShapeKind } from './settings'

export type Tool = 'select' | 'lasso' | 'textselect' | 'edittext' | 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'table' | 'hand'

/** Tenir le stylet immobile ce temps (ms) en fin de trait le transforme en ligne droite. */
const HOLD_TO_STRAIGHTEN_MS = 650
const DRAW_TOOLS: Tool[] = ['pen', 'highlighter', 'eraser', 'shape', 'textselect']
/**
 * Outils qui dessinent mais laissent saisir l'objet sélectionné : appuyer dedans le déplace
 * au lieu de tracer (Ctrl + appui saisit n'importe quel objet). Un simple toucher sur une
 * image, un texte, une forme… la sélectionne (« sélection universelle » de GoodNotes).
 */
const GRAB_TOOLS: Tool[] = ['pen', 'highlighter', 'shape']
/** Un appui plus court et plus immobile que ça est un « toucher » (pas un trait). */
const TAP_MS = 300
const TAP_PX = 4

interface Stroke {
  tool: 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'textselect' | 'lasso'
  /** Forme reconnue en tenant le stylet immobile (rond, rectangle…). */
  recognized?: Recognized | null
  points: InkPoint[]
  start: Point
  straight: boolean
  holdTimer?: number
  lastMove: Point
  /** Début du geste (performance.now), pour reconnaître un simple toucher. */
  t0?: number
  /** Page où le geste a commencé : on n'écrit pas en dehors (rien ne s'y exporte). */
  page?: Rect4
  /** Le pointeur est sorti de la page : le trait est coupé au bord, et reprend en y revenant. */
  outside?: boolean
  lastOutside?: InkPoint
}

interface Rect4 {
  x0: number
  y0: number
  x1: number
  y1: number
}

const inside = (r: Rect4, x: number, y: number): boolean => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
const clampTo = (r: Rect4, x: number, y: number): [number, number] => [Math.min(r.x1, Math.max(r.x0, x)), Math.min(r.y1, Math.max(r.y0, y))]

/** Point du bord de la page entre un point dedans `a` et un point dehors `b` (dichotomie). */
function edgePoint(r: Rect4, a: InkPoint, b: InkPoint): InkPoint {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 14; i++) {
    const t = (lo + hi) / 2
    if (inside(r, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) lo = t
    else hi = t
  }
  const [x, y] = clampTo(r, a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo)
  return [x, y, (a[2] + b[2]) / 2]
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

  /** Branché par l'application : sélection du texte des PDF et aimantation du surligneur. */
  textSelection: TextSelection | null = null

  constructor(private ed: Editor) {
    const c = ed.canvas
    // Avec un outil de dessin, seul l'objet sélectionné peut être saisi (ou tout objet avec Ctrl).
    const find = c.findTarget.bind(c)
    c.findTarget = ((e: PointerEvent) => {
      const info = find(e)
      if (!GRAB_TOOLS.includes(this.tool) || !info.target) return info
      const t = info.target
      const grab = !isPageLayer(t) && (t === c.getActiveObject() || e.ctrlKey || e.metaKey)
      return grab ? info : { ...info, target: undefined, subTargets: [] }
    }) as typeof c.findTarget
    c.on('mouse:down', (o) => this.down(o))
    c.on('mouse:move', (o) => this.move(o))
    // Clic droit (bouton du stylet) : Fabric transmet l'évènement souris, sans « stylet ».
    // On garde l'évènement pointeur d'origine pour reconnaître le stylet et ses boutons.
    c.upperCanvasEl.addEventListener('pointerdown', (e) => (this.lastDown = e), { capture: true })
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

  /** Dernier outil d'écriture (stylo ou surligneur) : la gomme y revient d'un geste. */
  lastInk: 'pen' | 'highlighter' = 'pen'

  /** Gomme ↔ stylo (ou surligneur) : un seul bouton, une seule touche. */
  toggleEraser(): void {
    this.set(this.tool === 'eraser' ? this.lastInk : 'eraser')
  }

  set(tool: Tool): void {
    const c = this.ed.canvas
    if (tool === 'pen' || tool === 'highlighter') this.lastInk = tool
    this.tool = tool
    c.isDrawingMode = false
    c.selection = tool === 'select'
    c.skipTargetFind = (DRAW_TOOLS.includes(tool) && !GRAB_TOOLS.includes(tool)) || tool === 'table' || tool === 'edittext'
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
    // Stylo, surligneur, gomme : le point (ou cercle) dessiné suffit, sans croix par-dessus.
    const drawn = settings.value.cursor !== 'cross' && (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'eraser')
    const cursor = drawn
      ? 'none'
      : this.tool === 'text' || this.tool === 'textselect' || this.tool === 'edittext' ? 'text' : DRAW_TOOLS.includes(this.tool) || this.tool === 'lasso' || this.tool === 'table' ? 'crosshair' : 'default'
    c.defaultCursor = cursor
    if (this.tool !== 'select') c.hoverCursor = this.tool === 'text' ? 'text' : cursor
    else c.hoverCursor = 'move'
  }

  // --- Gestes --------------------------------------------------------------------

  private lastDown: PointerEvent | null = null

  private down(o: TPointerEventInfo): void {
    const raw = o.e as PointerEvent
    const e = !raw.pointerType && this.lastDown && raw.timeStamp - this.lastDown.timeStamp < 100 ? this.lastDown : raw
    if (e.pointerType === 'touch' && this.penSeen) return
    const p = o.scenePoint
    // Boutons du stylet (réglables dans Préférences > Stylet et tablette), le temps du geste :
    // lasso, gomme, déplacer la vue (géré par la vue), menu (clic droit) ou rien.
    const penAction = e.pointerType === 'pen' ? penActionOf(e) : null
    if (penAction) {
      if (penAction !== 'menu') penGesture.until = performance.now() + 800 // pas de menu après le geste
      if (penAction === 'lasso' && this.tool !== 'hand') {
        this.ed.canvas.discardActiveObject()
        this.stroke = { tool: 'lasso', points: [[p.x, p.y, 0.5]], start: p, straight: false, lastMove: p }
        return
      }
      if (penAction !== 'eraser') return
    } else if ('button' in e && e.button !== 0) return
    // Gomme du stylet : elle passe avant l'outil choisi (texte, tableau…), sauf Sélection et Main.
    const erasing = penAction === 'eraser' && this.tool !== 'select' && this.tool !== 'hand'

    if (!erasing && this.tool === 'text') {
      if (o.target && 'text' in o.target) return // clic dans un texte existant : édition normale
      const page = this.pageRect(p)
      if (!page) return this.offPage()
      this.stroke = { tool: 'text', points: [[p.x, p.y, 0.5]], start: p, straight: false, lastMove: p, page }
      return
    }
    if (!erasing && this.tool === 'table') {
      const page = this.pageRect(p)
      return page ? this.createTable(p, page) : this.offPage()
    }
    if (!erasing && this.tool === 'edittext') {
      void editTextAt(this.ed, p).then((box) => {
        if (box) this.set('select')
        else this.ed.notify('Cliquez sur un texte du PDF pour le modifier', 'info')
      })
      return
    }
    if (!erasing && this.tool === 'lasso') {
      // Appui dans la sélection en cours : on la déplace (comportement normal de Fabric).
      if (o.target && this.ed.canvas.getActiveObjects().includes(o.target)) return
      if (o.target && this.ed.canvas.getActiveObject() === o.target) return
      this.ed.canvas.discardActiveObject()
      this.stroke = { tool: 'lasso', points: [[p.x, p.y, 0.5]], start: p, straight: false, lastMove: p }
      return
    }
    if (!erasing && this.tool === 'textselect') {
      this.stroke = { tool: 'textselect', points: [[p.x, p.y, 0.5]], start: p, straight: false, lastMove: p }
      void this.textSelection?.begin(p)
      return
    }

    // Bout gomme du stylet (ou bouton réglé sur « Gomme ») : gomme le temps du geste.
    const tool = erasing ? 'eraser' : this.tool
    if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'eraser' && tool !== 'shape') return
    // Appui sur l'objet sélectionné (ou Ctrl + appui) : Fabric le déplace, on ne trace rien.
    if (o.target && tool !== 'eraser') return

    // On écrit sur les pages, pas dans le vide autour (la gomme, elle, marche partout).
    const page = tool === 'eraser' ? undefined : this.pageRect(p)
    if (tool !== 'eraser' && !page) return this.offPage()

    this.stroke = { tool, points: [[p.x, p.y, pressureOf(e)]], start: p, straight: false, lastMove: p, t0: performance.now(), page: page ?? undefined }
    if (tool === 'pen' || tool === 'highlighter') this.ed.history.begin() // un geste = une étape, même coupé au bord
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
      // Hors des pages, les outils d'écriture montrent un curseur « interdit ».
      if (['pen', 'highlighter', 'shape', 'text', 'table'].includes(this.tool) && !o.target) {
        const off = !this.ed.doc.pageUnder(o.scenePoint)
        this.ed.canvas.setCursor(off ? 'not-allowed' : this.ed.canvas.defaultCursor)
        if (off) return this.clearTop()
      }
      if (this.tool === 'eraser') this.drawEraserCursor(o.scenePoint)
      else if ((this.tool === 'pen' || this.tool === 'highlighter') && (e as PointerEvent).pointerType !== 'touch') this.drawSizeCursor(o.scenePoint)
      return
    }
    const s = this.stroke
    if (s.tool === 'textselect') {
      this.textSelection?.update(o.scenePoint)
      return
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const samples = events.length ? events : [e]
    for (const ev of samples) {
      const p = this.ed.canvas.getScenePoint(ev)
      if (s.tool === 'eraser') this.erase(p)
      else this.addPoint(s, [p.x, p.y, pressureOf(ev)])
    }
    const last = this.ed.canvas.getScenePoint(e)
    if (last.distanceFrom(s.lastMove) * this.ed.viewport.zoom > 3) {
      s.lastMove = last
      this.armHold()
    }
    this.preview()
    if (s.tool === 'eraser') this.drawEraserCursor(last)
  }

  /**
   * Ajoute un point au geste en restant sur la page de départ : les formes et les zones de
   * texte s'arrêtent au bord ; un trait libre est coupé au bord et reprend s'il y revient.
   */
  private addPoint(s: Stroke, pt: InkPoint): void {
    const r = s.page
    if (!r || s.tool === 'lasso' || s.tool === 'textselect') return void s.points.push(pt)
    const free = (s.tool === 'pen' || s.tool === 'highlighter') && !this.shiftHeld && !s.straight
    if (!free) {
      const [x, y] = clampTo(r, pt[0], pt[1])
      s.points.push([x, y, pt[2]])
      return
    }
    const isIn = inside(r, pt[0], pt[1])
    if (!s.outside && !isIn) {
      // Sortie : on finit le morceau au bord de la page.
      const last = s.points.at(-1)
      if (last) {
        s.points.push(edgePoint(r, last, pt))
        if (s.points.length > 1) this.ed.add(this.inkFor(s.tool as 'pen' | 'highlighter', s.points))
      }
      s.points = []
      s.outside = true
      s.recognized = null
    } else if (s.outside && isIn) {
      // Retour sur la page : nouveau morceau depuis le bord.
      s.points = [edgePoint(r, pt, s.lastOutside ?? pt), pt]
      s.outside = false
    } else if (isIn) s.points.push(pt)
    if (!isIn) s.lastOutside = pt
  }

  private up(): void {
    const s = this.stroke
    if (!s) return
    window.clearTimeout(s.holdTimer)
    this.stroke = null
    this.clearTop()
    if (s.tool === 'pen' || s.tool === 'highlighter') {
      try {
        this.finishStroke(s)
      } finally {
        this.ed.history.end()
      }
      return
    }
    this.finishStroke(s)
  }

  private finishStroke(s: Stroke): void {
    if (s.tool === 'eraser') {
      this.ed.history.end()
      return
    }
    if (s.tool === 'text') return this.createText(s)
    if (s.tool === 'lasso') return this.finishLasso(s)
    if (s.tool === 'textselect') return this.textSelection?.end()
    // Simple toucher sur une image, un texte, une forme, un tableau… : on le sélectionne.
    if (this.isTap(s)) {
      const hit = this.objectAt(s.start)
      if (hit) {
        this.ed.canvas.setActiveObject(hit)
        this.ed.canvas.requestRenderAll()
        return
      }
    }
    if (!s.points.length) return // geste terminé hors de la page
    let pts = this.finalPoints(s)
    // Trait droit (Maj ou stylet immobile) : son extrémité reste sur la page.
    if (s.page && pts.length === 2) pts = pts.map(([x, y, p]) => [...clampTo(s.page!, x, y), p] as InkPoint)
    if (s.recognized && s.tool === 'pen') {
      const shape = this.shapeFromRecognized(s.recognized)
      if (shape) {
        this.ed.add(shape)
        return
      }
    }
    if (s.tool === 'shape') {
      const obj = this.buildShape(settings.value.shape, s.start, new Point(pts.at(-1)![0], pts.at(-1)![1]))
      if (obj) {
        this.ed.add(obj)
        // La forme reste sélectionnée : on peut tout de suite la déplacer ou la redimensionner.
        this.ed.canvas.setActiveObject(obj)
        this.ed.canvas.requestRenderAll()
      }
      return
    }
    const v = settings.value
    // Surligneur sur le texte d'un PDF : aimanté aux lignes de texte (si activé).
    if (s.tool === 'highlighter' && v.highlightSnap && this.textSelection && !this.shiftHeld) {
      const page = this.ed.doc.pageAt(s.start)
      void this.textSelection.snapStroke(pts.map(([x, y]) => [x, y]), page).then((words) => {
        const snapped = words?.length ? buildMarkup(words, 'highlight', v.highlighterColor) : null
        this.ed.add(snapped ?? this.inkFor(s.tool as 'highlighter', pts))
      })
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
    this.ed.add(ink)
  }

  private inkFor(tool: 'pen' | 'highlighter', pts: InkPoint[]): InkObject {
    const v = settings.value
    return buildInk({
      tool,
      points: pts,
      size: tool === 'pen' ? v.penWidth : v.highlighterWidth,
      color: tool === 'pen' ? v.penColor : v.highlighterColor,
      style: tool === 'pen' ? v.penStyle : 'solid',
      pressure: tool === 'pen' && v.pressure
    })
  }

  /** Rectangle de la page sous un point (coordonnées document), ou null hors des pages. */
  private pageRect(p: Point): Rect4 | null {
    const page = this.ed.doc.pageUnder(p)
    return page ? { x0: page.left, y0: page.top, x1: page.left + page.width, y1: page.top + page.height } : null
  }

  private lastOffPage = 0
  /** Appui hors des pages avec un outil d'écriture : on le dit (sans insister). */
  private offPage(): void {
    const now = performance.now()
    if (now - this.lastOffPage > 4000) this.ed.notify('Écrivez sur une page : en dehors, rien ne serait enregistré ni exporté.', 'info')
    this.lastOffPage = now
  }

  private isTap(s: Stroke): boolean {
    if (s.t0 === undefined || performance.now() - s.t0 > TAP_MS) return false
    const z = this.ed.viewport.zoom
    return s.points.every(([x, y]) => Math.hypot(x - s.start.x, y - s.start.y) * z <= TAP_PX)
  }

  /** Objet (hors traits à main levée et fonds de page) sous un point, du dessus vers le dessous. */
  private objectAt(p: Point): FabricObject | null {
    const objects = this.ed.canvas.getObjects()
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i]
      if (isPageLayer(o) || (o as InkObject).ink || !o.visible || !o.selectable || !o.evented) continue
      if (o.containsPoint(p)) return o
    }
    return null
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
    if (!s || s.tool === 'eraser' || s.tool === 'shape' || s.tool === 'text' || s.tool === 'textselect' || s.tool === 'lasso') return
    window.clearTimeout(s.holdTimer)
    s.holdTimer = window.setTimeout(() => {
      if (this.stroke !== s || s.points.length < 4) return
      const [x0, y0] = s.points[0]
      const [x1, y1] = s.points.at(-1)!
      // Forme fermée (rond, rectangle, triangle) : reconnue par le noyau natif.
      if (s.tool === 'pen' && settings.value.shapeRecognition && hasNative()) {
        const r = nativeRecognize(new Float32Array(s.points.flat()), 3)
        if (r && r.kind !== 'line') {
          s.recognized = r
          this.preview()
          return
        }
      }
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
    if (!s || s.tool === 'eraser' || s.tool === 'textselect') return
    if (s.tool === 'text') return this.previewText(s)
    if (s.tool === 'lasso') return this.previewLasso(s)
    if (s.recognized) {
      const shape = this.shapeFromRecognized(s.recognized)
      if (shape) return this.withTop((ctx) => shape.set({ objectCaching: false }).render(ctx))
    }
    const v = settings.value
    if (!s.points.length) return this.clearTop()
    const pts = this.finalPoints(s)
    if (s.recognized && s.tool === 'pen') {
      const shape = this.shapeFromRecognized(s.recognized)
      if (shape) {
        this.ed.add(shape)
        return
      }
    }
    if (s.tool === 'shape') {
      const obj = this.buildShape(v.shape, s.start, new Point(pts.at(-1)![0], pts.at(-1)![1]))
      this.withTop((ctx) => obj?.set({ objectCaching: false }).render(ctx))
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
    // Pas d'image en cache pour l'aperçu : hors du canevas, Fabric la calculerait au zoom 1
    // puis l'agrandirait (trait flou pendant l'écriture, net seulement au lâcher).
    ink.set({ globalCompositeOperation: 'source-over', objectCaching: false })
    this.withTop((ctx) => ink.render(ctx))
  }

  private drawEraserCursor(at: Point): void {
    if (settings.value.cursor === 'cross') return this.clearTop()
    const z = this.ed.viewport.zoom
    const r = settings.value.eraserSize / 2 / z
    this.withTop((ctx) => {
      ctx.beginPath()
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
      if (settings.value.cursor === 'dot') {
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fill()
      }
      ctx.lineWidth = 1.5 / z
      ctx.strokeStyle = '#4b4d57'
      ctx.stroke()
    })
  }

  /** Curseur du stylo / surligneur : la taille et la couleur du trait, comme un vrai feutre. */
  private drawSizeCursor(at: Point): void {
    const v = settings.value
    if (v.cursor === 'cross') return this.clearTop()
    const z = this.ed.viewport.zoom
    const size = this.tool === 'pen' ? v.penWidth : v.highlighterWidth
    const color = this.tool === 'pen' ? v.penColor : v.highlighterColor
    // Jamais plus petit que 3 px à l'écran : on le voit toujours.
    const r = Math.max(size / 2, 1.5 / z)
    this.withTop((ctx) => {
      ctx.beginPath()
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
      if (v.cursor === 'dot') {
        ctx.fillStyle = color
        ctx.fill()
        // Liseré fin de contraste : visible sur fond clair comme sur fond sombre.
        ctx.lineWidth = 1 / z
        ctx.strokeStyle = isLight(color) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)'
        ctx.beginPath()
        ctx.arc(at.x, at.y, r + 0.5 / z, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.lineWidth = 1.5 / z
        ctx.strokeStyle = color
        ctx.stroke()
        ctx.lineWidth = 0.75 / z
        ctx.strokeStyle = isLight(color) ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)'
        ctx.beginPath()
        ctx.arc(at.x, at.y, r + 1 / z, 0, Math.PI * 2)
        ctx.stroke()
      }
    })
  }

  // --- Lasso -----------------------------------------------------------------------

  private previewLasso(s: Stroke): void {
    const zoom = this.ed.viewport.zoom
    this.withTop((ctx) => {
      ctx.setLineDash([5 / zoom, 4 / zoom])
      ctx.lineWidth = 1.5 / zoom
      ctx.strokeStyle = '#4f8cff'
      ctx.fillStyle = 'rgba(79,140,255,0.08)'
      ctx.beginPath()
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    })
  }

  /** Sélectionne les objets entourés (au moins la moitié de leurs points dans la boucle). */
  private finishLasso(s: Stroke): void {
    if (s.points.length < 3) return
    const poly = new Float32Array(s.points.flatMap(([x, y]) => [x, y]))
    const inside = (pts: number[][]): number => {
      if (hasNative()) return nativeCountInside(poly, new Float32Array(pts.flatMap(([x, y]) => [x, y])), 2)
      return pts.filter(([x, y]) => pointInPolygon(x, y, s.points)).length
    }
    const picked = this.ed.doc.content.filter((o) => {
      if (!o.selectable || !o.visible) return false
      const ink = (o as InkObject).ink
      let samples: number[][]
      if (ink) {
        const all = scenePoints(o as InkObject)
        const step = Math.max(1, Math.floor(all.length / 64))
        samples = all.filter((_, i) => i % step === 0)
      } else {
        const r = o.getBoundingRect()
        samples = [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height], [r.left + r.width / 2, r.top + r.height / 2]]
      }
      return inside(samples) >= samples.length * 0.5
    })
    if (!picked.length) return
    this.ed.canvas.setActiveObject(picked.length === 1 ? picked[0] : new ActiveSelection(picked, { canvas: this.ed.canvas }))
    this.ed.canvas.requestRenderAll()
  }

  private shapeFromRecognized(r: Recognized): FabricObject | null {
    const v = settings.value
    const common = { stroke: v.penColor, strokeWidth: v.penWidth, fill: '', strokeUniform: true, strokeLineJoin: 'round' as const, strokeDashArray: dashArray(v.penStyle, v.penWidth) }
    let obj: FabricObject
    if (r.kind === 'ellipse') obj = new Ellipse({ left: r.cx - r.rx, top: r.cy - r.ry, rx: r.rx, ry: r.ry, ...common })
    else if (r.kind === 'rect') obj = new Rect({ left: r.left, top: r.top, width: r.width, height: r.height, ...common })
    else if (r.kind === 'polygon') obj = new Path(`M ${r.points.map((p) => p.join(' ')).join(' L ')} Z`, common)
    else return null
    obj.set({ shape: r.kind } as never)
    return obj
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
      // Clic simple : la zone ne dépasse pas le bord droit de la page.
      const room = s.page ? s.page.x1 - s.start.x - 8 : 240
      box = new Textbox('', { ...style, left: s.start.x, top: s.start.y - v.fontSize * 0.6, width: Math.max(60, Math.min(240, room)), splitByGrapheme: false })
    }
    this.ed.add(box)
    this.set('select')
    this.ed.canvas.setActiveObject(box)
    box.enterEditing()
    box.hiddenTextarea?.focus()
    this.ed.canvas.requestRenderAll()
  }

  private createTable(at: Point, page: Rect4): void {
    const table = Table.create(settings.value.tableRows, settings.value.tableCols)
    // Le tableau tient dans la page : on le décale vers l'intérieur si besoin.
    const w = table.getScaledWidth()
    const h = table.getScaledHeight()
    table.set({ left: Math.max(page.x0, Math.min(at.x, page.x1 - w)), top: Math.max(page.y0, Math.min(at.y, page.y1 - h)) })
    table.setCoords()
    this.ed.add(table)
    this.set('select')
    this.ed.canvas.setActiveObject(table)
    this.ed.canvas.requestRenderAll()
  }
}

function pointInPolygon(x: number, y: number, poly: InkPoint[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
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

/** Couleur claire (jaune, blanc…) : son liseré de contraste sera sombre. */
function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})/i.exec(color)
  if (!m) return false
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170
}

/** Moment jusqu'auquel un geste de bouton du stylet empêche le menu du clic droit de s'ouvrir. */
export const penGesture = { until: 0 }

/**
 * Bouton du stylet appuyé pendant le geste, et ce qu'il doit faire (null : la pointe seule).
 * Bout gomme : bouton 5 / buttons & 32 ; bouton le plus proche de la pointe : clic droit
 * (buttons & 2) ; second bouton : clic du milieu (buttons & 4).
 */
export function penActionOf(e: PointerEvent): PenButtonAction | null {
  const b = e.buttons ?? 0
  const v = settings.value
  if (e.button === 5 || (b & 32) !== 0) return v.penEraserEnd
  if ((b & 2) !== 0 || e.button === 2) return v.penButton1
  if ((b & 4) !== 0 || e.button === 1) return v.penButton2
  return null
}
