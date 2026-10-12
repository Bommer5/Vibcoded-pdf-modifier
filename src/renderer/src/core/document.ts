import { FabricImage, Point, Rect, Shadow, util, type Canvas, type FabricObject } from 'fabric'
import type { Asset } from './assets'
import { isPageLayer, type Obj } from './props'

/** Formats de page en points PDF (1 pt = 1/72 pouce). */
export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 },
  Letter: { width: 612, height: 792 }
} as const

export type PageSize = keyof typeof PAGE_SIZES

export interface Size {
  width: number
  height: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface PageOptions {
  /** PDF d'origine de la page (export vectoriel fidèle). */
  pdfAssetId?: string
  pdfPageIndex?: number
  /** Image de fond (rendu du PDF, motif lignes/carreaux…). */
  background?: Asset
  /** Insère après cette page (sinon en fin de document). */
  after?: Rect
}

const PAGE_GAP = 40

export type Page = Rect & Obj

/**
 * Document = pile verticale de pages. Chaque page est un rectangle blanc
 * verrouillé (role 'page'), éventuellement surmonté d'un fond (role 'page-bg').
 * Le contenu est posé par-dessus et peut déborder d'une page à l'autre.
 */
export class DocumentModel {
  constructor(private canvas: Canvas) {}

  get pages(): Page[] {
    return this.canvas
      .getObjects()
      .filter((o): o is Page => (o as Obj).role === 'page')
      .sort((a, b) => a.top - b.top)
  }

  /** Objets de contenu (hors pages et fonds). */
  get content(): FabricObject[] {
    return this.canvas.getObjects().filter((o) => !isPageLayer(o))
  }

  get isEmpty(): boolean {
    return this.content.length === 0 && this.pages.every((p) => !(p as Obj).pdfAssetId)
  }

  bounds(): Box {
    const pages = this.pages
    if (pages.length === 0) return { left: 0, top: 0, ...PAGE_SIZES.A4 }
    const left = Math.min(...pages.map((p) => p.left))
    const top = Math.min(...pages.map((p) => p.top))
    const right = Math.max(...pages.map((p) => p.left + p.width))
    const bottom = Math.max(...pages.map((p) => p.top + p.height))
    return { left, top, width: right - left, height: bottom - top }
  }

  box(page: Page): Box {
    return { left: page.left, top: page.top, width: page.width, height: page.height }
  }

  /** Page sous un point (coordonnées document), sinon la plus proche verticalement. */
  pageAt(p: Point): Page | undefined {
    const pages = this.pages
    return (
      pages.find((pg) => p.y >= pg.top && p.y <= pg.top + pg.height) ??
      pages.reduce<Page | undefined>((best, pg) => {
        const d = Math.abs(pg.top + pg.height / 2 - p.y)
        return !best || d < Math.abs(best.top + best.height / 2 - p.y) ? pg : best
      }, undefined)
    )
  }

  /** Page affichée au centre de l'écran. */
  currentPage(): Page | undefined {
    const center = new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2)
    return this.pageAt(center.transform(util.invertTransform(this.canvas.viewportTransform)))
  }

  /** Objets de contenu qui touchent une page. */
  contentOn(page: Page): FabricObject[] {
    const b = this.box(page)
    return this.content.filter((o) => {
      const r = o.getBoundingRect()
      return r.left < b.left + b.width && r.left + r.width > b.left && r.top < b.top + b.height && r.top + r.height > b.top
    })
  }

  background(page: Page): FabricObject | undefined {
    return this.canvas.getObjects().find((o) => (o as Obj).role === 'page-bg' && (o as Obj).pageId === page.pageId)
  }

  async addPage(size: Size = PAGE_SIZES.A4, opts: PageOptions = {}): Promise<Page> {
    const pages = this.pages
    const anchor = opts.after ?? pages.at(-1)
    const top = anchor ? anchor.top + anchor.height + PAGE_GAP : 0
    const left = anchor ? anchor.left + (anchor.width - size.width) / 2 : 0

    // Décale les pages (et leur contenu) situées en dessous du point d'insertion.
    if (opts.after) {
      const shift = size.height + PAGE_GAP
      for (const o of this.canvas.getObjects()) {
        if (o.getBoundingRect().top >= top - PAGE_GAP / 2) {
          o.set({ top: o.top + shift })
          o.setCoords()
        }
      }
    }

    const page = new Rect({
      left,
      top,
      width: size.width,
      height: size.height,
      originX: 'left',
      originY: 'top',
      fill: '#ffffff',
      strokeWidth: 0,
      selectable: false,
      evented: false,
      hoverCursor: 'default',
      shadow: new Shadow({ color: 'rgba(0,0,0,0.35)', blur: 12, offsetX: 0, offsetY: 2 })
    }) as Page
    page.set({ role: 'page', pageId: crypto.randomUUID(), pdfAssetId: opts.pdfAssetId, pdfPageIndex: opts.pdfPageIndex })
    this.canvas.insertAt(this.layerCount(), page)

    if (opts.background) await this.setBackground(page, opts.background)
    return page
  }

  async setBackground(page: Page, asset: Asset): Promise<void> {
    const previous = this.background(page)
    if (previous) this.canvas.remove(previous)
    const img = await FabricImage.fromURL(asset.url)
    img.set({
      left: page.left,
      top: page.top,
      originX: 'left',
      originY: 'top',
      scaleX: page.width / img.width,
      scaleY: page.height / img.height,
      selectable: false,
      evented: false,
      hoverCursor: 'default',
      role: 'page-bg',
      pageId: page.pageId,
      assetId: asset.id
    } as Partial<Obj>)
    this.canvas.insertAt(this.layerCount(), img)
  }

  /** Nombre d'objets « structure » (pages + fonds) tout en bas de la pile. */
  layerCount(): number {
    return this.canvas.getObjects().filter(isPageLayer).length
  }

  clear(): void {
    this.canvas.discardActiveObject()
    this.canvas.remove(...this.canvas.getObjects())
  }
}
