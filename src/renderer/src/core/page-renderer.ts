import type { Page } from './page'
import { assets } from './assets'
import { drawPaper } from './paper'
import { pdfEngine } from '../pdf/engine'

interface Entry {
  bitmap: ImageBitmap
  scale: number
  bytes: number
  used: number
}

const SCALES = [0.5, 1, 1.5, 2, 3, 4]
const MAX_PIXELS = 4096 * 4096
/** Budget mémoire des rendus de pages (Mo), adapté à l'appareil. */
const BUDGET = Math.min(256, ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) * 32) * 1024 * 1024

/**
 * Cache de rendu des fonds de page.
 * - Rendu paresseux : une page n'est rendue que lorsqu'elle est affichée.
 * - Résolution adaptée au zoom (paliers), l'ancienne image reste affichée pendant le rendu de la nouvelle.
 * - File « dernier demandé, premier servi » : en défilement rapide, on rend la page qu'on regarde.
 * - Budget mémoire : les pages les moins récemment vues sont libérées.
 */
class PageRenderer {
  private cache = new Map<string, Entry>()
  private queue = new Map<string, { page: Page; scale: number }>()
  private seen = new Map<string, number>()
  private busy = false
  private total = 0

  key(page: Page): string | null {
    const bg = page.bg
    if (bg.kind === 'pdf') {
      const shifts = page.shifts?.filter((s) => s.dy) ?? []
      return `${bg.assetId}#${bg.index}${page.masks?.length ? '#' + JSON.stringify(page.masks) : ''}${shifts.length ? '#' + JSON.stringify(shifts) : ''}${page.hidden?.length ? '#h' + page.hidden.join(',') : ''}`
    }
    if (bg.kind === 'image') return bg.assetId
    return null
  }

  /** Dessine le fond (repère : coin haut-gauche de la page, en points). */
  draw(ctx: CanvasRenderingContext2D, page: Page): void {
    const bg = page.bg
    if (bg.kind === 'paper') return drawPaper(ctx, page, bg.style, bg.color)
    const key = this.key(page)
    if (!key) return
    const now = performance.now()
    this.seen.set(key, now)
    const entry = this.cache.get(key)
    if (entry) {
      entry.used = now
      ctx.drawImage(entry.bitmap, 0, 0, page.width, page.height)
    }
    const canvas = page.canvas
    const zoom = canvas ? canvas.getZoom() * canvas.getRetinaScaling() : 1
    const want = this.bucket(page, zoom)
    if (!entry || entry.scale < want) this.request(key, page, want)
  }

  private bucket(page: Page, zoom: number): number {
    const fit = Math.sqrt(MAX_PIXELS / (page.width * page.height))
    const s = SCALES.find((x) => x >= zoom) ?? SCALES.at(-1)!
    return Math.min(s, fit)
  }

  private request(key: string, page: Page, scale: number): void {
    const queued = this.queue.get(key)
    if (queued && queued.scale >= scale) return
    this.queue.delete(key) // ré-insertion = passe en tête (dernier demandé)
    this.queue.set(key, { page, scale })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.size) {
        const [key, job] = [...this.queue.entries()].at(-1)!
        this.queue.delete(key)
        // Page sortie de l'écran entre-temps : inutile de la rendre.
        if (performance.now() - (this.seen.get(key) ?? 0) > 1500) continue
        const current = this.cache.get(key)
        if (current && current.scale >= job.scale) continue
        try {
          const bitmap = await this.renderBitmap(job.page, job.scale)
          if (!bitmap) continue
          this.store(key, bitmap, job.scale)
          job.page.canvas?.requestRenderAll()
        } catch (e) {
          console.warn('Rendu de page impossible', e)
        }
      }
    } finally {
      this.busy = false
    }
  }

  private store(key: string, bitmap: ImageBitmap, scale: number): void {
    const old = this.cache.get(key)
    if (old) {
      old.bitmap.close()
      this.total -= old.bytes
    }
    const bytes = bitmap.width * bitmap.height * 4
    this.cache.set(key, { bitmap, scale, bytes, used: performance.now() })
    this.total += bytes
    if (this.total <= BUDGET) return
    const now = performance.now()
    const victims = [...this.cache.entries()].filter(([, e]) => now - e.used > 500).sort((a, b) => a[1].used - b[1].used)
    for (const [k, e] of victims) {
      if (this.total <= BUDGET * 0.8) break
      e.bitmap.close()
      this.total -= e.bytes
      this.cache.delete(k)
    }
  }

  /** Rendu du fond à une échelle donnée (aussi utilisé par l'export, hors cache). */
  async renderBitmap(page: Page, scale: number): Promise<ImageBitmap | null> {
    const bg = page.bg
    const w = Math.max(1, Math.round(page.width * scale))
    const h = Math.max(1, Math.round(page.height * scale))
    if (bg.kind === 'pdf') {
      const asset = assets.get(bg.assetId)
      if (!asset) return null
      await pdfEngine.open(bg.assetId, asset.bytes)
      return pdfEngine.render(bg.assetId, bg.index, w, h, page.masks, page.shifts?.filter((s) => s.dy), page.hidden)
    }
    if (bg.kind === 'image') {
      const asset = assets.get(bg.assetId)
      if (!asset) return null
      return createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }), {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high'
      })
    }
    return null
  }

  /** Peint le fond complet d'une page dans un contexte (export image), à l'échelle `scale`. */
  async paint(ctx: CanvasRenderingContext2D, page: Page, scale: number): Promise<void> {
    ctx.save()
    ctx.scale(scale, scale)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, page.width, page.height)
    if (page.bg.kind === 'paper') drawPaper(ctx, page, page.bg.style, page.bg.color)
    ctx.restore()
    const bitmap = await this.renderBitmap(page, scale)
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, ctx.canvas.width, ctx.canvas.height)
      bitmap.close()
    }
  }

  /** Libère tout (nouveau document). */
  clear(): void {
    for (const e of this.cache.values()) e.bitmap.close()
    this.cache.clear()
    this.queue.clear()
    this.seen.clear()
    this.total = 0
  }

  get memoryBytes(): number {
    return this.total
  }
}

export const pageRenderer = new PageRenderer()
