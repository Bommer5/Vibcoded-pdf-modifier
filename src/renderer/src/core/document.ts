import { Point, util, type Canvas, type FabricObject } from 'fabric'
import { Page, type PageBackground } from './page'
import { isPageLayer } from './props'

export { Page }
export type { PageBackground }

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
  bg?: PageBackground
  /** Insère après cette page (sinon en fin de document). */
  after?: Page
}

export const PAGE_GAP = 40

/**
 * Document = pile verticale de pages. Le contenu est posé par-dessus et peut
 * déborder d'une page à l'autre. Les pages sont toujours en bas de la pile d'objets.
 */
export class DocumentModel {
  constructor(private canvas: Canvas) {}

  get pages(): Page[] {
    return this.canvas
      .getObjects()
      .filter((o): o is Page => o instanceof Page)
      .sort((a, b) => a.top - b.top)
  }

  /** Objets de contenu (hors pages). */
  get content(): FabricObject[] {
    return this.canvas.getObjects().filter((o) => !isPageLayer(o))
  }

  get isEmpty(): boolean {
    return this.content.length === 0 && this.pages.every((p) => p.bg.kind === 'blank' || p.bg.kind === 'paper')
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

  /** Objets « appartenant » à une page (leur centre est dessus) : ils la suivent quand on la déplace. */
  ownedBy(page: Page): FabricObject[] {
    const pages = this.pages
    return this.content.filter((o) => this.pageAt(o.getCenterPoint()) === page && pages.includes(page))
  }

  addPage(size: Size = PAGE_SIZES.A4, opts: PageOptions = {}): Page {
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

    const page = new Page({ left, top, width: size.width, height: size.height, bg: opts.bg })
    this.canvas.insertAt(this.layerCount(), page)
    return page
  }

  /**
   * Réordonne les pages (nouvel ordre = liste des pages) : chaque page garde son contenu,
   * puis tout est réempilé verticalement.
   */
  reorder(order: Page[], owned = new Map(order.map((p) => [p, this.ownedBy(p)]))): void {
    let top = 0
    for (const page of order) {
      const dy = top - page.top
      if (dy) {
        page.set({ top: page.top + dy })
        page.setCoords()
        for (const o of owned.get(page) ?? []) {
          o.set({ top: o.top + dy })
          o.setCoords()
        }
      }
      top += page.height + PAGE_GAP
    }
  }

  /**
   * Change le format d'une page (A4, paysage…) : la page reste centrée, son contenu garde
   * sa place par rapport au coin haut-gauche, les pages suivantes se décalent.
   */
  resizePage(page: Page, size: Size): void {
    const owned = new Map(this.pages.map((p) => [p, this.ownedBy(p)]))
    const dx = (page.width - size.width) / 2
    page.set({ width: size.width, height: size.height, left: page.left + dx })
    page.setCoords()
    for (const o of owned.get(page) ?? []) {
      o.set({ left: o.left + dx })
      o.setCoords()
    }
    page.dirty = true
    this.reorder(this.pages, owned)
  }

  removePage(page: Page): void {
    const owned = this.ownedBy(page)
    this.canvas.remove(page, ...owned)
    this.reorder(this.pages)
  }

  /** Nombre d'objets « structure » (pages) tout en bas de la pile. */
  layerCount(): number {
    return this.canvas.getObjects().filter(isPageLayer).length
  }

  clear(): void {
    this.canvas.discardActiveObject()
    this.canvas.remove(...this.canvas.getObjects())
  }
}
