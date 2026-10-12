import { classRegistry, FabricObject, Rect, Shadow, type TOptions, type RectProps } from 'fabric'
import './props'
import type { PaperStyle } from './paper'
import { pageRenderer } from './page-renderer'

/** Fond d'une page : une description légère, rendue à la demande. */
export type PageBackground =
  | { kind: 'blank' }
  | { kind: 'pdf'; assetId: string; index: number }
  | { kind: 'image'; assetId: string }
  | { kind: 'paper'; style: PaperStyle; color: string }

/**
 * Feuille du document. Elle dessine elle-même son fond (page PDF, image, papier)
 * via le cache de rendu : seules les pages visibles sont rendues, à la résolution du zoom.
 */
export class Page extends Rect {
  static type = 'Page'
  declare bg: PageBackground
  /** Zones (repère de la page) dont le texte d'origine du PDF est retiré : texte modifié ou supprimé. */
  declare masks: [number, number, number, number][]
  declare pageId: string
  declare role: 'page'

  constructor(options: Partial<TOptions<RectProps>> & { bg?: PageBackground; pageId?: string } = {}) {
    super({
      fill: '#ffffff',
      strokeWidth: 0,
      selectable: false,
      evented: false,
      hoverCursor: 'default',
      objectCaching: false, // le fond est déjà une image en cache : pas de double tampon
      shadow: new Shadow({ color: 'rgba(0,0,0,0.35)', blur: 12, offsetX: 0, offsetY: 2 }),
      ...options
    } as never)
    this.role = 'page'
    this.bg ??= { kind: 'blank' }
    this.masks ??= []
    this.pageId ??= crypto.randomUUID()
  }

  _render(ctx: CanvasRenderingContext2D): void {
    super._render(ctx)
    if (this.bg.kind === 'blank') return
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.translate(-this.width / 2, -this.height / 2)
    pageRenderer.draw(ctx, this)
    ctx.restore()
  }
}

classRegistry.setClass(Page)
FabricObject.customProperties.push('bg')
