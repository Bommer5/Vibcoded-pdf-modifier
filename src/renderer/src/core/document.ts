import { Rect, Shadow, type Canvas, type FabricObject } from 'fabric'

/** Formats de page en points PDF (1 pt = 1/72 pouce). */
export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 },
  Letter: { width: 612, height: 792 }
} as const

export type PageSize = keyof typeof PAGE_SIZES

const PAGE_GAP = 40

type PageObject = FabricObject & { pageId?: string }

/**
 * Document = pile verticale de pages. Chaque page est un rectangle blanc
 * verrouillé portant un `pageId` ; le contenu est posé par-dessus.
 */
export class DocumentModel {
  constructor(private canvas: Canvas) {}

  get pages(): Rect[] {
    return this.canvas.getObjects().filter((o): o is Rect => !!(o as PageObject).pageId)
  }

  /** Boîte englobante de toutes les pages (pour ajuster la vue). */
  bounds(): { left: number; top: number; width: number; height: number } {
    const pages = this.pages
    if (pages.length === 0) return { left: 0, top: 0, ...PAGE_SIZES.A4 }
    const left = Math.min(...pages.map((p) => p.left))
    const top = Math.min(...pages.map((p) => p.top))
    const right = Math.max(...pages.map((p) => p.left + p.width))
    const bottom = Math.max(...pages.map((p) => p.top + p.height))
    return { left, top, width: right - left, height: bottom - top }
  }

  addPage(size: PageSize = 'A4'): Rect {
    const { width, height } = PAGE_SIZES[size]
    const last = this.pages.at(-1)
    const top = last ? last.top + last.height + PAGE_GAP : 0
    const page = new Rect({
      left: 0,
      top,
      width,
      height,
      originX: 'left',
      originY: 'top',
      fill: '#ffffff',
      strokeWidth: 0,
      selectable: false,
      evented: false,
      hoverCursor: 'default',
      shadow: new Shadow({ color: 'rgba(0,0,0,0.35)', blur: 12, offsetX: 0, offsetY: 2 })
    }) as Rect & { pageId: string }
    page.pageId = crypto.randomUUID()
    // Les pages restent sous le contenu.
    this.canvas.insertAt(this.pages.length, page)
    return page
  }

  clear(): void {
    this.canvas.clear()
  }
}
