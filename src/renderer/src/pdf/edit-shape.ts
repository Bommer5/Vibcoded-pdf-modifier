import { Path, type Point } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import { pdfEngine } from './engine'
import { originalY, shiftAt } from './flow'
import type { PdfShape } from './protocol'

/** Forme reprise d'un PDF : la page et le rang de l'objet retiré (pour l'annulation et l'export). */
export type LiftedShape = Path & { pdfShape?: { pageId: string; index: number } }

/** Trait ou forme du PDF sous un point (coordonnées document) : page, forme et décalage. */
export async function shapeAt(ed: Editor, p: Point): Promise<{ page: Page; shape: PdfShape; dy: number } | null> {
  const page = ed.doc.pageUnder(p)
  if (!page || page.bg.kind !== 'pdf') return null
  const x = p.x - page.left
  const y = originalY(page, x, p.y - page.top)
  const tol = Math.max(2, 5 / ed.viewport.zoom)
  const shape = await pdfEngine.shapeAt(page.bg.assetId, page.bg.index, x, y, tol, page.hidden)
  if (!shape) return null
  return { page, shape, dy: shiftAt(page, x, y) }
}

/**
 * « Modifier PDF » sur un trait, un cadre, une flèche, une forme : l'objet est retiré du PDF
 * (à l'écran et à l'export) et devient une forme du document, à la même place, avec la même
 * couleur, la même épaisseur et les mêmes tirets — on peut la déplacer, la recolorer, la
 * redimensionner ou la supprimer. Ctrl+Z la remet dans le PDF.
 */
export async function editShapeAt(ed: Editor, p: Point): Promise<LiftedShape | null> {
  const found = await shapeAt(ed, p)
  if (!found) return null
  const { page, shape, dy } = found
  const path = new Path(shape.d, {
    stroke: shape.stroke ?? undefined,
    strokeWidth: shape.stroke ? shape.width : 0,
    fill: shape.fill ?? '',
    fillRule: shape.fillRule,
    strokeDashArray: shape.dash,
    strokeLineCap: shape.cap,
    strokeLineJoin: shape.join,
    opacity: shape.opacity,
    strokeUniform: true
  }) as LiftedShape
  // Le chemin est en coordonnées de la page : on le place sur la page (et son décalage éventuel).
  path.set({ left: path.left + page.left, top: path.top + page.top + dy })
  path.setCoords()
  path.pdfShape = { pageId: page.pageId, index: shape.index }
  await ed.history.transaction(() => {
    page.set({ hidden: [...(page.hidden ?? []), shape.index] } as never)
    page.dirty = true
    ed.history.touch(page)
    ed.add(path)
  })
  ed.canvas.setActiveObject(path)
  ed.canvas.requestRenderAll()
  return path
}
