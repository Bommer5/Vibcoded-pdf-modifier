import { Textbox, type Point } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import { pdfEngine } from './engine'
import { nearestWord, pageWords, type DocWord } from './text'

/**
 * Modifier le texte d'origine d'un PDF (ou d'un document Word/ODT importé, converti en PDF).
 * Un clic sur un paragraphe le transforme en zone de texte modifiable, avec sa taille,
 * sa couleur, sa graisse et la police la plus proche disponible. Le texte d'origine est
 * réellement retiré du PDF (à l'écran et à l'export), pas seulement caché.
 */
export async function editTextAt(ed: Editor, p: Point): Promise<Textbox | null> {
  const page = ed.doc.pageAt(p)
  if (!page || page.bg.kind !== 'pdf') return null
  const words = await pageWords(page)
  const hit = nearestWord(words, p.x, p.y)
  if (!hit || p.x < hit.x0 - 4 || p.x > hit.x1 + 4 || p.y < hit.y0 - 4 || p.y > hit.y1 + 4) return null

  const block = paragraphOf(words, hit)
  const lines = groupLines(block)
  const rect = {
    x0: Math.min(...block.map((w) => w.x0)),
    y0: Math.min(...block.map((w) => w.y0)),
    x1: Math.max(...block.map((w) => w.x1)),
    y1: Math.max(...block.map((w) => w.y1))
  }
  const info = await pdfEngine.fontInfo(page.bg.assetId, page.bg.index, (hit.x0 + hit.x1) / 2 - page.left, (hit.y0 + hit.y1) / 2 - page.top)
  const height = hit.y1 - hit.y0
  const fontSize = info?.fontSize && info.fontSize > 1 ? info.fontSize : height / 1.15
  const pitch = lines.length > 1 ? (lines.at(-1)![0].y0 - lines[0][0].y0) / (lines.length - 1) : fontSize * 1.2
  const rights = lines.map((l) => l.at(-1)!.x1)
  const justified = lines.length > 2 && rights.slice(0, -1).every((r) => Math.abs(r - rect.x1) < fontSize * 0.6)

  const box = new Textbox(joinLines(lines), {
    left: rect.x0,
    top: rect.y0 - fontSize * 0.12,
    width: rect.x1 - rect.x0 + fontSize * 0.6,
    fontSize,
    fontFamily: closestFont(info?.fontName ?? ''),
    fontWeight: info?.bold ? 'bold' : 'normal',
    fontStyle: info?.italic ? 'italic' : 'normal',
    fill: info?.color ?? '#000000',
    lineHeight: Math.round(Math.min(3, Math.max(1, pitch / (fontSize * 1.13))) * 20) / 20,
    // Comme Word : justifié sauf la dernière ligne du paragraphe.
    textAlign: justified ? 'justify-left' : 'left',
    splitByGrapheme: false
  })
  box.set({ pdfEdit: true } as never)
  const mask: [number, number, number, number] = [rect.x0 - page.left - 1, rect.y0 - page.top - 1, rect.x1 - page.left + 1, rect.y1 - page.top + 1]
  await ed.history.transaction(() => {
    page.set({ masks: [...(page.masks ?? []), mask] } as never)
    ed.add(box)
  })
  ed.canvas.setActiveObject(box)
  box.enterEditing()
  box.hiddenTextarea?.focus()
  ed.canvas.requestRenderAll()
  return box
}

export interface Box4 {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Paragraphe du PDF sous un point (pour l'encadrer au survol), ou null. */
export async function paragraphAt(ed: Editor, p: Point): Promise<Box4 | null> {
  const page = ed.doc.pageAt(p)
  if (!page || page.bg.kind !== 'pdf') return null
  const words = await pageWords(page)
  const hit = nearestWord(words, p.x, p.y)
  if (!hit || p.x < hit.x0 - 4 || p.x > hit.x1 + 4 || p.y < hit.y0 - 4 || p.y > hit.y1 + 4) return null
  const block = paragraphOf(words, hit)
  return {
    x0: Math.min(...block.map((w) => w.x0)),
    y0: Math.min(...block.map((w) => w.y0)),
    x1: Math.max(...block.map((w) => w.x1)),
    y1: Math.max(...block.map((w) => w.y1))
  }
}

/** Mot du PDF sous un point, ou null. */
export async function wordAt(ed: Editor, p: Point): Promise<Box4 | null> {
  const page = ed.doc.pageAt(p)
  if (!page || page.bg.kind !== 'pdf') return null
  const hit = nearestWord(await pageWords(page), p.x, p.y)
  if (!hit || p.x < hit.x0 - 2 || p.x > hit.x1 + 2 || p.y < hit.y0 - 2 || p.y > hit.y1 + 2) return null
  return hit
}

function groupLines(words: DocWord[]): DocWord[][] {
  const map = new Map<number, DocWord[]>()
  for (const w of words) map.set(w.line, [...(map.get(w.line) ?? []), w])
  return [...map.values()].map((l) => l.sort((a, b) => a.x0 - b.x0)).sort((a, b) => a[0].y0 - b[0].y0)
}

/** Paragraphe autour d'un mot : lignes voisines proches, de même taille, qui se chevauchent horizontalement. */
function paragraphOf(words: DocWord[], hit: DocWord): DocWord[] {
  const lines = groupLines(words.filter((w) => w.page === hit.page))
  const box = (l: DocWord[]) => ({ x0: Math.min(...l.map((w) => w.x0)), x1: Math.max(...l.map((w) => w.x1)), y0: Math.min(...l.map((w) => w.y0)), y1: Math.max(...l.map((w) => w.y1)) })
  const start = lines.findIndex((l) => l.includes(hit))
  const fits = (a: DocWord[], b: DocWord[]): boolean => {
    const A = box(a)
    const B = box(b)
    const ha = A.y1 - A.y0
    const hb = B.y1 - B.y0
    const gap = Math.max(B.y0 - A.y1, A.y0 - B.y1)
    const overlap = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)
    return Math.abs(ha - hb) < Math.max(ha, hb) * 0.3 && gap < Math.max(ha, hb) * 0.9 && overlap > Math.min(A.x1 - A.x0, B.x1 - B.x0) * 0.4
  }
  let lo = start
  let hi = start
  while (lo > 0 && fits(lines[lo - 1], lines[lo])) lo--
  while (hi < lines.length - 1 && fits(lines[hi], lines[hi + 1])) hi++
  return lines.slice(lo, hi + 1).flat()
}

/** Recompose le paragraphe (les césures de fin de ligne sont recollées). */
function joinLines(lines: DocWord[][]): string {
  let out = ''
  for (const line of lines) {
    const text = line.map((w) => w.text).join(' ')
    if (!out) out = text
    else if (/[a-zà-ÿ]-$/i.test(out)) out = out.slice(0, -1) + text
    else out += ' ' + text
  }
  return out
}

const installed = new Map<string, boolean>()

/** Police installée sur l'appareil ? (comparaison de largeurs avec les polices génériques) */
function isInstalled(family: string): boolean {
  if (installed.has(family)) return installed.get(family)!
  const ctx = document.createElement('canvas').getContext('2d')!
  const sample = 'mmmmmmmmmmlli1WQ@#'
  const widths = ['monospace', 'serif', 'sans-serif'].map((generic) => {
    ctx.font = `72px ${generic}`
    const base = ctx.measureText(sample).width
    ctx.font = `72px "${family}", ${generic}`
    return ctx.measureText(sample).width !== base
  })
  const ok = widths.every(Boolean)
  installed.set(family, ok)
  return ok
}

/** Nom de police PDF (« ABCDEF+Calibri-Bold », « TimesNewRomanPSMT »…) → police affichable la plus proche. */
export function closestFont(pdfName: string): string {
  const base = pdfName.replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '').replace(/(PS)?MT$/, '')
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2')
  for (const candidate of [base, spaced]) if (candidate && isInstalled(candidate)) return candidate
  const n = pdfName.toLowerCase()
  if (/courier|mono|consol|menlo/.test(n)) return 'Courier New'
  if (/times|roman|georgia|garamond|cambria|book|minion|palatino|serif/.test(n) && !/sans/.test(n)) return 'Times New Roman'
  if (/calibri|carlito/.test(n)) return isInstalled('Carlito') ? 'Carlito' : 'Arial'
  return 'Arial'
}

export type { Page }
