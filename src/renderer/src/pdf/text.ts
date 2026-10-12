import { Group, Rect, type FabricObject } from 'fabric'
import type { Page } from '../core/page'
import { pdfEngine } from './engine'
import type { PdfWord } from './protocol'

/** Mot du PDF en coordonnées document. */
export interface DocWord extends PdfWord {
  page: Page
  /** Position dans l'ordre de lecture de la page. */
  index: number
}

export type MarkupKind = 'highlight' | 'underline' | 'strike'

/** Mots d'une page PDF, placés dans le document (cache côté moteur). */
export async function pageWords(page: Page): Promise<DocWord[]> {
  if (page.bg.kind !== 'pdf') return []
  const words = await pdfEngine.words(page.bg.assetId, page.bg.index)
  // Le texte des zones modifiées n'existe plus dans le PDF : on l'ignore (recherche, sélection…).
  const masks = page.masks ?? []
  const visible = masks.length
    ? words.filter((w) => {
        const cx = (w.x0 + w.x1) / 2
        const cy = (w.y0 + w.y1) / 2
        return !masks.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1)
      })
    : words
  return visible.map((w, index) => ({
    ...w,
    x0: w.x0 + page.left,
    x1: w.x1 + page.left,
    y0: w.y0 + page.top,
    y1: w.y1 + page.top,
    page,
    index
  }))
}

/** Mot le plus proche d'un point (sur la même ligne de préférence). */
export function nearestWord(words: DocWord[], x: number, y: number): DocWord | null {
  let best: DocWord | null = null
  let bestD = Infinity
  for (const w of words) {
    const dx = x < w.x0 ? w.x0 - x : x > w.x1 ? x - w.x1 : 0
    const dy = y < w.y0 ? w.y0 - y : y > w.y1 ? y - w.y1 : 0
    const d = dx + dy * 3 // la distance verticale compte plus : on reste sur la ligne visée
    if (d < bestD) {
      bestD = d
      best = w
    }
  }
  return best
}

/** Mots entre deux points, dans l'ordre de lecture (comme une sélection de texte). */
export function wordsBetween(words: DocWord[], a: { x: number; y: number }, b: { x: number; y: number }): DocWord[] {
  const wa = nearestWord(words, a.x, a.y)
  const wb = nearestWord(words, b.x, b.y)
  if (!wa || !wb) return []
  const [i, j] = wa.index <= wb.index ? [wa.index, wb.index] : [wb.index, wa.index]
  return words.filter((w) => w.index >= i && w.index <= j)
}

/** Regroupe des mots par ligne en rectangles (un par ligne). */
export function lineRects(words: DocWord[]): { x0: number; y0: number; x1: number; y1: number }[] {
  const lines = new Map<string, { x0: number; y0: number; x1: number; y1: number }>()
  for (const w of words) {
    const key = `${w.page.pageId}:${w.line}`
    const r = lines.get(key)
    if (!r) lines.set(key, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })
    else {
      r.x0 = Math.min(r.x0, w.x0)
      r.y0 = Math.min(r.y0, w.y0)
      r.x1 = Math.max(r.x1, w.x1)
      r.y1 = Math.max(r.y1, w.y1)
    }
  }
  return [...lines.values()]
}

export function wordsText(words: DocWord[]): string {
  let out = ''
  let prev: DocWord | null = null
  for (const w of words) {
    if (prev) out += prev.line !== w.line || prev.page !== w.page ? '\n' : ' '
    out += w.text
    prev = w
  }
  return out
}

/**
 * Annotation aimantée au texte (surlignage, soulignement, barré) : un rectangle
 * par ligne, exactement à la hauteur du texte, regroupés en un seul objet.
 */
export function buildMarkup(words: DocWord[], kind: MarkupKind, color: string): FabricObject | null {
  const rects = lineRects(words)
  if (rects.length === 0) return null
  const parts = rects.map((r) => {
    const h = r.y1 - r.y0
    if (kind === 'highlight') return new Rect({ left: r.x0 - 1, top: r.y0 - h * 0.08, width: r.x1 - r.x0 + 2, height: h * 1.16, fill: color, strokeWidth: 0 })
    const thick = Math.max(0.8, h * 0.08)
    const y = kind === 'underline' ? r.y1 - thick * 0.2 : r.y0 + h * 0.52
    return new Rect({ left: r.x0, top: y, width: r.x1 - r.x0, height: thick, fill: color, strokeWidth: 0 })
  })
  const group = new Group(parts, { subTargetCheck: false })
  group.set({
    opacity: kind === 'highlight' ? 0.4 : 1,
    globalCompositeOperation: kind === 'highlight' ? 'multiply' : 'source-over',
    markup: { kind, text: wordsText(words) }
  } as never)
  return group
}

/** Normalise pour la recherche : minuscules, sans accents ni ligatures. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}
