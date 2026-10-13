import type { FabricImage, FabricObject, Textbox } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import { pdfEngine } from './engine'
import type { PdfShift } from './protocol'

/** Page PDF en image (rognable), fournie par l'import : `pdfPage` garde le lien vectoriel. */
export type PageImageFactory = (assetId: string, index: number, size: { width: number; height: number }) => Promise<FabricImage>

/** Morceau de PDF repoussé hors de sa page et affiché en haut de la page de suite. */
type Overflow = FabricImage & { flowOverflow?: { from: string; id: string } }
/** Page de suite créée automatiquement pour accueillir ce qui déborde. */
type FlowPage = Page & { flowFrom?: string }

/**
 * Quand un paragraphe modifié d'un PDF gagne ou perd des lignes, la suite de sa colonne suit
 * (comme dans Word) : le contenu d'origine en dessous (texte, traits, images) et ce qu'on a
 * ajouté par-dessus (annotations, autres textes modifiés) descendent ou remontent d'autant.
 * Les autres colonnes et le contenu au-dessus ne bougent pas.
 *
 * Le décalage est décrit sur la page (`page.shifts`, en coordonnées d'origine) : il s'applique
 * au rendu et à l'export, et s'annule avec Ctrl+Z comme le reste.
 */

export interface TextFlowInfo {
  id: string
  pageId: string
  /** Colonne concernée et bas du paragraphe d'origine (coordonnées de la page). */
  x0: number
  x1: number
  y: number
  /** Hauteur de la zone de texte quand le paragraphe a été ouvert. */
  h0: number
}

type FlowBox = Textbox & { pdfFlow?: TextFlowInfo }

/** Décalage affiché d'un point du contenu d'origine (coordonnées de la page). */
export function shiftAt(page: Page, x: number, y: number): number {
  let dy = 0
  for (const s of page.shifts ?? []) if (y >= s.y - 0.5 && x >= s.x0 && x <= s.x1) dy += s.dy
  return dy
}

/** Position d'origine d'un point affiché (inverse de shiftAt). */
export function originalY(page: Page, x: number, y: number): number {
  let guess = y
  for (let k = 0; k < 4; k++) guess = y - shiftAt(page, x, guess)
  return guess
}

export class TextFlow {
  private timer = 0

  constructor(private ed: Editor, private pageImage?: PageImageFactory) {
    const c = ed.canvas
    // Pendant la frappe : mise à jour un instant après la dernière touche ; puis à la sortie.
    c.on('text:changed', ({ target }) => {
      window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.update(target as FlowBox), 350)
    })
    c.on('text:editing:exited', ({ target }) => this.update(target as FlowBox))
    c.on('object:modified', ({ target }) => this.update(target as FlowBox))
  }

  update(box: FlowBox | undefined): void {
    const flow = box?.pdfFlow
    if (!box || !flow || !this.ed.canvas.getObjects().includes(box)) return
    const page = this.ed.doc.pages.find((p) => p.pageId === flow.pageId)
    if (!page) return
    const shifts = page.shifts ?? []
    const current = shifts.find((s) => s.id === flow.id)?.dy ?? 0
    const want = Math.round((box.getScaledHeight() - flow.h0) * 4) / 4
    const delta = want - current
    if (Math.abs(delta) < 0.25) return

    // Ce qui a été ajouté sous le paragraphe, dans sa colonne et sur sa page, suit.
    const bottom = box.top + flow.h0 + current
    const x0 = page.left + flow.x0
    const x1 = page.left + flow.x1
    const moved: FabricObject[] = []
    for (const o of this.ed.doc.content) {
      if (o === box) continue
      const r = o.getBoundingRect()
      if (r.top < bottom - 0.5 || r.left + r.width <= x0 || r.left >= x1) continue
      if (this.ed.doc.pageAt(o.getCenterPoint()) !== page) continue
      moved.push(o)
    }
    for (const o of moved) {
      o.set({ top: o.top + delta })
      o.setCoords()
      this.ed.history.touch(o)
    }
    const next: PdfShift[] = [...shifts.filter((s) => s.id !== flow.id), { id: flow.id, x0: flow.x0, x1: flow.x1, y: flow.y, dy: want }]
    page.set({ shifts: next } as never)
    page.dirty = true
    this.ed.history.touch(page)
    // Ce qui passe sous le bas de la page part en haut de la page suivante.
    void this.overflow(page, flow, want, moved).finally(() => {
      this.ed.history.record()
      this.ed.canvas.requestRenderAll()
    })
    this.ed.canvas.requestRenderAll()
  }

  /**
   * Débordement : le paragraphe agrandi a poussé du contenu sous le bas de la page. Ce morceau
   * du PDF (vectoriel, comme « insérer une partie ») s'affiche en haut d'une page de suite créée
   * juste après ; les objets poussés dehors y vont aussi. Tout se met à jour quand le paragraphe
   * grandit ou rétrécit, et disparaît quand plus rien ne déborde.
   */
  private async overflow(page: Page, flow: TextFlowInfo, dy: number, moved: FabricObject[]): Promise<void> {
    const bg = page.bg
    if (bg.kind !== 'pdf' || !this.pageImage) return
    const H = page.height
    const W = page.width
    const existing = this.ed.doc.content.find((o) => (o as Overflow).flowOverflow?.from === page.pageId && (o as Overflow).flowOverflow?.id === flow.id) as Overflow | undefined
    // Y a-t-il du texte dans la bande qui passe sous le bas de la page ?
    const words = dy > 0.5 ? await pdfEngine.words(bg.assetId, bg.index) : []
    const cut = H - dy
    const pushed = words.filter((w) => w.y1 > cut && w.y0 < H && w.x1 > flow.x0 && w.x0 < flow.x1 && w.y0 >= flow.y - 0.5)
    const objectsOut = moved.filter((o) => o.getBoundingRect().top > page.top + H)
    if (!pushed.length && !objectsOut.length) {
      if (existing) this.removeOverflow(existing)
      return
    }
    // Page de suite (créée une fois, juste après), même format
    let next = this.ed.doc.pages.find((p) => (p as FlowPage).flowFrom === page.pageId) as FlowPage | undefined
    if (!next) {
      next = this.ed.doc.addPage({ width: W, height: H }, { after: page }) as FlowPage
      next.set({ flowFrom: page.pageId } as never)
      this.ed.history.touch(next)
    }
    // Marge du haut de la page d'origine : la suite commence au même endroit qu'une page normale.
    const margin = Math.max(18, Math.min(90, Math.min(...words.map((w) => w.y0).filter((y) => y >= 0), 72)))
    const top = Math.max(cut, Math.min(...pushed.map((w) => w.y0), H)) - 2
    const rect = { x: Math.max(0, flow.x0 - 4) / W, y: top / H, w: Math.min(W, flow.x1 + 4 - Math.max(0, flow.x0 - 4)) / W, h: (H - top) / H }
    if (pushed.length) {
      let img = existing
      if (!img) {
        img = (await this.pageImage(bg.assetId, bg.index, { width: W, height: H })) as Overflow
        img.flowOverflow = { from: page.pageId, id: flow.id }
        img.set({ selectable: true })
        this.ed.add(img)
      }
      const el = img.getElement() as HTMLImageElement
      const nw = el.naturalWidth || el.width
      const nh = el.naturalHeight || el.height
      img.set({ cropX: Math.round(rect.x * nw), cropY: Math.round(rect.y * nh), width: Math.max(1, Math.round(rect.w * nw)), height: Math.max(1, Math.round(rect.h * nh)) })
      img.set({ left: next.left + rect.x * W, top: next.top + margin, scaleX: W / nw, scaleY: H / nh })
      img.setCoords()
      this.ed.history.touch(img)
    } else if (existing) this.removeOverflow(existing)
    // Objets poussés hors de la page : même décalage, sur la page de suite
    for (const o of objectsOut) {
      o.set({ top: next.top + margin + (o.top - (page.top + top)) })
      o.setCoords()
      this.ed.history.touch(o)
    }
  }

  private removeOverflow(o: Overflow): void {
    const from = o.flowOverflow?.from
    this.ed.canvas.remove(o)
    // Page de suite devenue vide : retirée
    const next = this.ed.doc.pages.find((p) => (p as FlowPage).flowFrom === from)
    if (next && !this.ed.doc.ownedBy(next).length) this.ed.doc.removePage(next)
  }
}
