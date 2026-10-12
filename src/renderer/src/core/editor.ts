import type { Canvas, FabricObject, Point } from 'fabric'
import type { DocumentModel } from './document'
import type { History } from './history'
import type { Layers } from './layers'
import type { Viewport } from './viewport'

export type NoticeKind = 'info' | 'success' | 'error'

/** Contexte partagé par les modules (import, export, presse-papiers…). */
export interface Editor {
  canvas: Canvas
  doc: DocumentModel
  history: History
  viewport: Viewport
  layers?: Layers
  notify(message: string, kind?: NoticeKind, action?: { label: string; run: () => void | Promise<void> }): void
  /** Ajoute un objet de contenu au-dessus des pages. */
  add(obj: FabricObject): void
  /** Ressources à conserver en changeant de document (ex. images dans le presse-papiers). */
  keepAssets?: () => Set<string>
  /** Un objet vient d'être inséré et sélectionné (image, PDF…) : on repasse à l'outil Sélection. */
  placed?: () => void
  /** Position du pointeur en coordonnées document, s'il est sur le canevas. */
  pointer(): Point | null
}
