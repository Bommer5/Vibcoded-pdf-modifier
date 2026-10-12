import type { Canvas } from 'fabric'

/**
 * Calque d'affichage temporaire dessiné après le document (résultats de recherche,
 * sélection de texte…). Rien n'est ajouté au document ni à l'historique.
 */
type Painter = (ctx: CanvasRenderingContext2D, zoom: number) => void

const painters = new Map<string, Painter>()
let target: Canvas | null = null

export function initOverlay(canvas: Canvas): void {
  target = canvas
  canvas.on('after:render', ({ ctx }) => {
    if (painters.size === 0 || !ctx) return
    const c = ctx as CanvasRenderingContext2D
    const v = canvas.viewportTransform
    const r = canvas.getRetinaScaling()
    c.save()
    c.setTransform(v[0] * r, v[1] * r, v[2] * r, v[3] * r, v[4] * r, v[5] * r)
    for (const paint of painters.values()) paint(c, canvas.getZoom())
    c.restore()
  })
}

export function setOverlay(key: string, paint: Painter | null): void {
  if (paint) painters.set(key, paint)
  else painters.delete(key)
  target?.requestRenderAll()
}
