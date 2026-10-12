import { Point, util, type Canvas } from 'fabric'

const MIN_ZOOM = 0.05
const MAX_ZOOM = 32
const ZOOM_STEP = 1.2

/**
 * Gère le zoom (toujours centré sur le pointeur) et le déplacement de la vue :
 * Espace maintenu, outil Main, ou clic molette.
 */
export class Viewport {
  /** Dernière position connue du pointeur, en pixels écran relatifs au canevas. */
  private pointer: Point | null = null
  private spaceHeld = false
  private handTool = false
  private drag: { id: number; last: Point } | null = null
  /** Doigts posés (écrans tactiles) : deux doigts = pincer pour zoomer + déplacer. */
  private touches = new Map<number, Point>()
  private pinch: { distance: number; center: Point } | null = null

  constructor(
    private canvas: Canvas,
    private host: HTMLElement,
    private onZoom: (zoom: number) => void
  ) {
    host.addEventListener('pointermove', (e) => (this.pointer = this.local(e)), { capture: true })
    host.addEventListener('pointerleave', () => (this.pointer = null))
    host.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true })
    host.addEventListener('pointermove', (e) => this.onPointerMove(e), { capture: true })
    host.addEventListener('pointerup', (e) => this.endDrag(e), { capture: true })
    host.addEventListener('pointercancel', (e) => this.endDrag(e), { capture: true })
    host.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    window.addEventListener('keydown', (e) => this.onSpace(e, true))
    window.addEventListener('keyup', (e) => this.onSpace(e, false))
    window.addEventListener('blur', () => this.setSpace(false))
  }

  /** Position du pointeur en coordonnées document, s'il est au-dessus du canevas. */
  pointerScene(): Point | null {
    return this.pointer ? this.pointer.transform(util.invertTransform(this.canvas.viewportTransform)) : null
  }

  get zoom(): number {
    return this.canvas.getZoom()
  }

  setHandTool(active: boolean): void {
    this.handTool = active
    this.refreshCursor()
  }

  zoomIn(): void {
    this.zoomAt(this.zoom * ZOOM_STEP)
  }

  zoomOut(): void {
    this.zoomAt(this.zoom / ZOOM_STEP)
  }

  /** Zoome vers `zoom` autour du pointeur (ou du centre si le pointeur est hors du canevas). */
  zoomAt(zoom: number, at: Point | null = this.pointer): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    const anchor = at ?? new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2)
    this.canvas.zoomToPoint(anchor, clamped)
    this.onZoom(clamped)
  }

  /** Ajuste la vue pour que le rectangle (coordonnées document) tienne dans l'écran. */
  fit(rect: { left: number; top: number; width: number; height: number }, margin = 40): void {
    const w = this.canvas.getWidth()
    const h = this.canvas.getHeight()
    const zoom = Math.min((w - margin * 2) / rect.width, (h - margin * 2) / rect.height)
    this.canvas.setViewportTransform([
      zoom,
      0,
      0,
      zoom,
      (w - rect.width * zoom) / 2 - rect.left * zoom,
      margin - rect.top * zoom
    ])
    this.onZoom(zoom)
  }

  private get panning(): boolean {
    return this.spaceHeld || this.handTool
  }

  private local(e: PointerEvent | WheelEvent): Point {
    const r = this.canvas.upperCanvasEl.getBoundingClientRect()
    return new Point(e.clientX - r.left, e.clientY - r.top)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+molette (et pincement sur pavé tactile) : zoom sur le pointeur.
      this.zoomAt(this.zoom * Math.pow(1.0015, -e.deltaY), this.local(e))
    } else {
      // Molette seule : défilement ; Maj+molette : défilement horizontal.
      const dx = e.shiftKey ? -e.deltaY : -e.deltaX
      const dy = e.shiftKey ? 0 : -e.deltaY
      this.canvas.relativePan(new Point(dx, dy))
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.local(e))
      if (this.touches.size === 2) {
        e.stopPropagation()
        this.pinch = this.pinchState()
        return
      }
    }
    const middle = e.button === 1
    if (!this.panning && !middle) return
    e.preventDefault()
    e.stopPropagation() // le canevas ne doit ni dessiner ni sélectionner pendant le déplacement
    this.host.setPointerCapture(e.pointerId)
    this.drag = { id: e.pointerId, last: new Point(e.clientX, e.clientY) }
    this.host.classList.add('dragging')
  }

  private pinchState(): { distance: number; center: Point } {
    const [a, b] = [...this.touches.values()]
    return { distance: a.distanceFrom(b), center: a.midPointFrom(b) }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.local(e))
      if (this.pinch && this.touches.size === 2) {
        e.stopPropagation()
        const next = this.pinchState()
        this.canvas.relativePan(next.center.subtract(this.pinch.center))
        this.zoomAt(this.zoom * (next.distance / this.pinch.distance), next.center)
        this.pinch = next
        return
      }
    }
    if (!this.drag || e.pointerId !== this.drag.id) return
    e.stopPropagation()
    const now = new Point(e.clientX, e.clientY)
    this.canvas.relativePan(now.subtract(this.drag.last))
    this.drag.last = now
  }

  private endDrag(e: PointerEvent): void {
    if (this.touches.delete(e.pointerId) && this.pinch) {
      e.stopPropagation()
      if (this.touches.size < 2) this.pinch = null
      return
    }
    if (!this.drag || e.pointerId !== this.drag.id) return
    e.stopPropagation()
    this.host.releasePointerCapture(e.pointerId)
    this.drag = null
    this.host.classList.remove('dragging')
  }

  private onSpace(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space') return
    const target = e.target as HTMLElement | null
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return
    e.preventDefault()
    this.setSpace(down)
  }

  private setSpace(held: boolean): void {
    if (this.spaceHeld === held) return
    this.spaceHeld = held
    this.refreshCursor()
  }

  private refreshCursor(): void {
    this.host.classList.toggle('panning', this.panning)
    this.canvas.skipTargetFind = this.panning
    this.canvas.defaultCursor = this.panning ? 'grab' : 'default'
    this.canvas.hoverCursor = this.panning ? 'grab' : 'move'
  }
}
