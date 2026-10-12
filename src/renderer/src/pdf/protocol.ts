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

/** Zone (repère affiché de la page, en points) dont le texte d'origine est retiré. */
export type PdfMask = [number, number, number, number]

export interface PdfFontInfo {
  fontSize: number
  fontName: string
  bold: boolean
  italic: boolean
  color: string
}

export interface PdfOutlineItem {
  title: string
  page: number
  children: PdfOutlineItem[]
}

export type PdfRequest =
  | { op: 'open'; doc: string; data: Uint8Array }
  | { op: 'close'; doc: string }
  | { op: 'render'; doc: string; page: number; width: number; height: number; masks?: PdfMask[] }
  | { op: 'fontinfo'; doc: string; page: number; x: number; y: number }
  | { op: 'redacted'; doc: string; pages: { page: number; masks: PdfMask[] }[] }
  | { op: 'text'; doc: string; page: number }
  | { op: 'outline'; doc: string }
  | { op: 'attachment'; doc: string; name: string }

export type PdfResponse =
  | { ok: true; pages?: PdfPageInfo[]; bitmap?: ImageBitmap; words?: PdfWord[]; outline?: PdfOutlineItem[]; file?: Uint8Array | null; font?: PdfFontInfo | null }
  | { ok: false; error: string }
