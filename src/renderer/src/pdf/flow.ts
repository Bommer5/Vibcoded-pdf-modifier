import type { FabricObject, Textbox } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import type { PdfShift } from './protocol'

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

  constructor(private ed: Editor) {
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
    this.ed.history.record()
    this.ed.canvas.requestRenderAll()
  }
}
