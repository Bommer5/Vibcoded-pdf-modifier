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
  /** Un doigt déplace la vue (activé quand un stylet est utilisé : rejet de la paume). */
  private touchPan = false
  private drag: { id: number; last: Point } | null = null
  /** Doigts posés (écrans tactiles) : deux doigts = pincer pour zoomer + déplacer. */
  private touches = new Map<number, Point>()
  private pinch: { distance: number; center: Point } | null = null
  /** Derniers mouvements (pour l'élan au lâcher) et animation d'élan en cours. */
  private samples: { t: number; x: number; y: number }[] = []
  private glide = 0

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

  setTouchPan(active: boolean): void {
    this.touchPan = active
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

  /** Centre la vue sur un point du document (zoom inchangé). */
  centerOn(p: Point): void {
    const z = this.zoom
    const v = this.canvas.viewportTransform
    this.canvas.setViewportTransform([v[0], v[1], v[2], v[3], this.canvas.getWidth() / 2 - p.x * z, this.canvas.getHeight() / 2 - p.y * z])
  }

  /** Affiche le haut d'une page (zoom inchangé, centrée horizontalement). */
  showRect(rect: { left: number; top: number; width: number; height: number }, margin = 20): void {
    const z = this.zoom
    const v = this.canvas.viewportTransform
    this.canvas.setViewportTransform([v[0], v[1], v[2], v[3], this.canvas.getWidth() / 2 - (rect.left + rect.width / 2) * z, margin - rect.top * z])
    this.onZoom(z)
  }

  /** Ajuste la largeur d'une zone à l'écran. */
  fitWidth(rect: { left: number; top: number; width: number; height: number }, margin = 24): void {
    const zoom = (this.canvas.getWidth() - margin * 2) / rect.width
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, margin - rect.left * zoom, this.canvas.viewportTransform[5]])
    this.onZoom(zoom)
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

  /**
   * Pavé tactile et molette :
   * - glisser à deux doigts : déplace la vue dans tous les sens (comme dans un navigateur) ;
   * - pincer à deux doigts (ou Ctrl+molette) : zoom sur le pointeur, qui suit les doigts ;
   * - Maj+molette : défilement horizontal (souris sans molette horizontale).
   * Les évènements sont regroupés par image (60 Hz) : défilement fluide même quand le
   * pavé en envoie des centaines par seconde, et la vue ne peut pas « perdre » le document.
   */
  private wheel = { dx: 0, dy: 0, zoom: 1, at: null as Point | null, frame: 0 }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    this.stopGlide()
    // Unités : pixels (pavé tactile), lignes (certaines souris sous Linux / Firefox), pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.getHeight() : 1
    const dx = e.deltaX * unit
    const dy = e.deltaY * unit
    const w = this.wheel
    if (e.ctrlKey || e.metaKey) {
      // Pincement à deux doigts sur le pavé tactile : le navigateur l'envoie comme Ctrl+molette,
      // avec deltaY = -100 × ln(écartement) ; le zoom suit alors exactement les doigts.
      // Molette crantée (Ctrl+molette, pas de 100 ou 120) : ~10 % par cran.
      const notch = e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)
      w.zoom *= notch ? Math.pow(1.1, -Math.sign(dy) * Math.min(3, Math.round(Math.abs(dy) / 100) || 1)) : Math.exp(-Math.max(-50, Math.min(50, dy)) / 100)
      w.at = this.local(e)
    } else if (e.shiftKey && !dx) {
      w.dx -= dy
    } else {
      w.dx -= dx
      w.dy -= dy
    }
    if (!w.frame) w.frame = requestAnimationFrame(() => this.flushWheel())
  }

  private flushWheel(): void {
    const w = this.wheel
    w.frame = 0
    if (w.zoom !== 1) this.zoomAt(this.zoom * w.zoom, w.at)
    if (w.dx || w.dy) this.panBy(w.dx, w.dy)
    w.dx = w.dy = 0
    w.zoom = 1
  }

  /** Document visible (coordonnées document), pour ne jamais le perdre de vue. */
  bounds: (() => { left: number; top: number; width: number; height: number }) | null = null

  /** Déplace la vue de (dx, dy) pixels écran, en gardant une partie du document à l'écran. */
  panBy(dx: number, dy: number): void {
    const v = [...this.canvas.viewportTransform] as typeof this.canvas.viewportTransform
    let x = v[4] + dx
    let y = v[5] + dy
    const b = this.bounds?.()
    if (b) {
      const z = v[0]
      const W = this.canvas.getWidth()
      const H = this.canvas.getHeight()
      const keep = 120 // pixels du document toujours visibles
      x = Math.min(W - keep - b.left * z, Math.max(keep - (b.left + b.width) * z, x))
      y = Math.min(H - keep - b.top * z, Math.max(keep - (b.top + b.height) * z, y))
    }
    v[4] = x
    v[5] = y
    this.canvas.setViewportTransform(v)
  }

  private onPointerDown(e: PointerEvent): void {
    this.stopGlide()
    this.samples = []
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.local(e))
      if (this.touches.size === 2) {
        e.stopPropagation()
        this.pinch = this.pinchState()
        return
      }
    }
    const middle = e.button === 1
    const finger = e.pointerType === 'touch' && this.touchPan
    if (!this.panning && !middle && !finger) return
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
        const d = next.center.subtract(this.pinch.center)
        this.panBy(d.x, d.y)
        this.track(d.x, d.y)
        this.zoomAt(this.zoom * (next.distance / this.pinch.distance), next.center)
        this.pinch = next
        return
      }
    }
    if (!this.drag || e.pointerId !== this.drag.id) return
    e.stopPropagation()
    const now = new Point(e.clientX, e.clientY)
    const d = now.subtract(this.drag.last)
    this.panBy(d.x, d.y)
    this.track(d.x, d.y)
    this.drag.last = now
  }

  private endDrag(e: PointerEvent): void {
    if (this.touches.delete(e.pointerId) && this.pinch) {
      e.stopPropagation()
      if (this.touches.size < 2) {
        this.pinch = null
        this.startGlide()
      }
      return
    }
    if (!this.drag || e.pointerId !== this.drag.id) return
    e.stopPropagation()
    this.host.releasePointerCapture(e.pointerId)
    this.drag = null
    this.host.classList.remove('dragging')
    if (e.type === 'pointerup') this.startGlide()
  }

  /** Mouvement de la main enregistré (on garde les 100 dernières millisecondes). */
  private track(dx: number, dy: number): void {
    const t = performance.now()
    this.samples.push({ t, x: dx, y: dy })
    while (this.samples.length && t - this.samples[0].t > 100) this.samples.shift()
  }

  /**
   * Élan : au lâcher, la vue continue sur sa lancée et ralentit doucement (comme sur un
   * téléphone), au lieu de s'arrêter net. Un nouveau contact ou la molette l'arrête.
   */
  private startGlide(): void {
    const now = performance.now()
    const recent = this.samples.filter((s) => now - s.t <= 100)
    this.samples = []
    // Main immobile avant le lâcher : pas d'élan.
    if (recent.length < 2 || now - recent[recent.length - 1].t > 50) return
    const span = Math.max(16, now - recent[0].t)
    let vx = recent.reduce((a, s) => a + s.x, 0) / span // pixels par milliseconde
    let vy = recent.reduce((a, s) => a + s.y, 0) / span
    const max = 6
    const speed = Math.hypot(vx, vy)
    if (speed < 0.15) return
    if (speed > max) {
      vx *= max / speed
      vy *= max / speed
    }
    let last = now
    const step = (t: number): void => {
      const dt = Math.min(48, t - last)
      last = t
      const before = [this.canvas.viewportTransform[4], this.canvas.viewportTransform[5]]
      this.panBy(vx * dt, vy * dt)
      const v = this.canvas.viewportTransform
      // Freinage (≈ 0,3 s pour perdre l'essentiel de la vitesse) ; bord du document : arrêt.
      const k = Math.pow(0.996, dt)
      vx = v[4] === before[0] ? 0 : vx * k
      vy = v[5] === before[1] ? 0 : vy * k
      if (Math.hypot(vx, vy) < 0.02) {
        this.glide = 0
        return
      }
      this.glide = requestAnimationFrame(step)
    }
    this.glide = requestAnimationFrame(step)
  }

  stopGlide(): void {
    if (this.glide) cancelAnimationFrame(this.glide)
    this.glide = 0
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
