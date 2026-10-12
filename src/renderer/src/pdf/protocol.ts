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

/**
 * Décalage vertical du contenu d'origine (repère affiché, points) : tout ce qui commence sous
 * `y` entre `x0` et `x1` descend de `dy` (ou remonte si négatif). Sert quand un paragraphe
 * modifié gagne ou perd des lignes : la suite de la colonne suit, comme dans Word.
 */
export interface PdfShift {
  id: string
  x0: number
  x1: number
  y: number
  dy: number
}

export interface PdfFontInfo {
  fontSize: number
  fontName: string
  bold: boolean
  italic: boolean
  color: string
}

/** Caractère du PDF avec sa position exacte (repère affiché de la page, points, y vers le bas). */
export interface PdfChar {
  /** Caractère (espace et retours compris). */
  c: string
  /** Origine du glyphe : x et ligne de base. */
  x: number
  y: number
  /** Boîte du caractère. */
  x0: number
  y0: number
  x1: number
  y1: number
  size: number
  /** Police (index dans `fonts`). */
  f: number
  color: string
  /** Index du caractère dans la page (pour retrouver sa police). */
  i: number
  /** Texte reconnu par OCR : couleur du fond autour (pour recouvrir l'original). */
  bg?: string
}

export interface PdfCharFont {
  name: string
  family: string
  bold: boolean
  italic: boolean
  embedded: boolean
  /** Premier caractère qui l'utilise (pour en extraire le fichier de police). */
  sample: number
}

/** Contours des glyphes d'une police du PDF (unités : 1000 par em, y vers le haut). */
export interface PdfGlyphFont {
  ascent: number
  descent: number
  glyphs: { u: number; w: number; d: number[] }[]
}

export interface PdfOutlineItem {
  title: string
  page: number
  children: PdfOutlineItem[]
}

export type PdfRequest =
  | { op: 'open'; doc: string; data: Uint8Array; password?: string }
  | { op: 'close'; doc: string }
  | { op: 'render'; doc: string; page: number; width: number; height: number; masks?: PdfMask[]; shifts?: PdfShift[] }
  | { op: 'fontinfo'; doc: string; page: number; x: number; y: number }
  | { op: 'redacted'; doc: string; pages: { page: number; masks: PdfMask[]; shifts?: PdfShift[] }[] }
  | { op: 'text'; doc: string; page: number }
  | { op: 'outline'; doc: string }
  | { op: 'attachment'; doc: string; name: string }
  | { op: 'chars'; doc: string; page: number }
  | { op: 'fontdata'; doc: string; page: number; char: number }
  | { op: 'glyphs'; doc: string; page: number; char: number; codepoints: number[]; strict: number[] }

export type PdfResponse =
  | { ok: true; pages?: PdfPageInfo[]; bitmap?: ImageBitmap; words?: PdfWord[]; outline?: PdfOutlineItem[]; file?: Uint8Array | null; font?: PdfFontInfo | null; decrypted?: Uint8Array; chars?: PdfChar[]; fonts?: PdfCharFont[]; glyphFont?: PdfGlyphFont | null }
  | { ok: false; error: string }
