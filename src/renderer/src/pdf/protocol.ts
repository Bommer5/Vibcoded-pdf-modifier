/** Messages échangés avec le moteur PDF (worker). Coordonnées en points, origine en haut à gauche. */

export interface PdfPageInfo {
  width: number
  height: number
}

export interface PdfWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** Numéro de ligne dans la page (pour la sélection multi-lignes et l'aimantation). */
  line: number
}

export interface PdfOutlineItem {
  title: string
  page: number
  children: PdfOutlineItem[]
}

export type PdfRequest =
  | { op: 'open'; doc: string; data: Uint8Array }
  | { op: 'close'; doc: string }
  | { op: 'render'; doc: string; page: number; width: number; height: number }
  | { op: 'text'; doc: string; page: number }
  | { op: 'outline'; doc: string }

export type PdfResponse =
  | { ok: true; pages?: PdfPageInfo[]; bitmap?: ImageBitmap; words?: PdfWord[]; outline?: PdfOutlineItem[] }
  | { ok: false; error: string }
