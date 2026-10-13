import { cache, Textbox, type Point } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import { pdfEngine } from './engine'
import { originalY, shiftAt } from './flow'
import { embeddedFace, type EmbeddedFace } from './pdf-fonts'
import { matchFont } from './ocr'
import type { PdfChar, PdfCharFont } from './protocol'
import { nearestWord, pageWords } from './text'

/**
 * Modifier le texte d'origine d'un PDF (ou d'un document Word/ODT converti en PDF), sans
 * qu'il change d'aspect : un clic sur un paragraphe le remplace par une zone de texte
 * identique — même police (celle du PDF, reconstruite), même taille, même couleur, mots en
 * gras ou en italique gardés, mêmes retours à la ligne, même retrait de première ligne,
 * même alignement (justifié compris) et même interligne. On ne modifie que ce qu'on tape.
 * Le texte d'origine est réellement retiré du PDF (à l'écran et à l'export).
 */

export interface Box4 {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Ligne (ou morceau de ligne, si colonnes) de texte du PDF, en coordonnées de la page. */
interface Line {
  chars: PdfChar[]
  /** Origine (point de départ du dessin) du premier caractère : là où le texte commence vraiment. */
  start: number
  x0: number
  x1: number
  y0: number
  y1: number
  baseline: number
  size: number
  font: number
}

const isSpace = (c: PdfChar): boolean => /\s/.test(c.c)

function mode<T>(values: T[]): T {
  const count = new Map<T, number>()
  let best = values[0]
  for (const v of values) {
    const n = (count.get(v) ?? 0) + 1
    count.set(v, n)
    if (n > (count.get(best) ?? 0)) best = v
  }
  return best
}

/**
 * Ligatures (ﬁ, ﬂ, ﬀ, ﬃ, ﬄ, ﬅ, ﬆ) → lettres séparées, réparties sur la largeur du glyphe :
 * le texte modifiable contient « fi » (on peut taper, chercher, corriger normalement).
 */
function splitLigatures(chars: PdfChar[]): PdfChar[] {
  if (!chars.some((c) => c.c >= '\ufb00' && c.c <= '\ufb06')) return chars
  const out: PdfChar[] = []
  for (const c of chars) {
    const letters = c.c >= '\ufb00' && c.c <= '\ufb06' ? [...c.c.normalize('NFKC')] : [c.c]
    if (letters.length === 1) {
      out.push(c)
      continue
    }
    const w = (c.x1 - c.x0) / letters.length
    letters.forEach((l, k) => out.push({ ...c, c: l, x: c.x + w * k, x0: c.x0 + w * k, x1: c.x0 + w * (k + 1) }))
  }
  return out
}

function finishLine(chars: PdfChar[]): Line | null {
  const ink = chars.filter((c) => !isSpace(c))
  if (!ink.length) return null
  const ys = ink.map((c) => c.y).sort((a, b) => a - b)
  return {
    chars,
    start: ink[0].x,
    x0: Math.min(...ink.map((c) => c.x0)),
    x1: Math.max(...ink.map((c) => c.x1)),
    y0: Math.min(...ink.map((c) => c.y0)),
    y1: Math.max(...ink.map((c) => c.y1)),
    baseline: ys[Math.floor(ys.length / 2)],
    size: mode(ink.map((c) => Math.round(c.size * 10) / 10)),
    font: mode(ink.map((c) => c.f))
  }
}

/** Lignes de la page dans l'ordre de lecture ; une ligne est coupée là où il y a un grand vide (colonnes). */
function linesOf(chars: PdfChar[]): Line[] {
  const out: Line[] = []
  let cur: PdfChar[] = []
  let last: PdfChar | null = null
  const flush = (): void => {
    const l = finishLine(cur)
    if (l) out.push(l)
    cur = []
    last = null
  }
  for (const c of chars) {
    if (c.c === '\n' || c.c === '\r') {
      flush()
      continue
    }
    if (last && !isSpace(c)) {
      const size = Math.max(c.size, last.size, 1)
      const newLine = Math.abs(c.y - last.y) > size * 0.4 || c.x0 < last.x0 - size
      const column = c.x0 - last.x1 > size * 3
      if (newLine || column) flush()
    }
    cur.push(c)
    if (!isSpace(c)) last = c
  }
  flush()
  return out
}

/** Famille sans graisse ni style (« DejaVuSerif-Bold » et « DejaVuSerif » vont ensemble). */
const familyKey = (f: PdfCharFont | undefined): string =>
  (f?.family || f?.name || '').replace(/[-,]?(bold|italic|oblique|semibold|demi|black|regular|medium|light)\b/gi, '').toLowerCase()

/**
 * Paragraphe autour d'une ligne : lignes voisines de même police et même taille, qui se
 * chevauchent, à interligne régulier. On s'arrête à un retrait (nouveau paragraphe), à
 * un espace plus grand (espacement de paragraphe) ou après une ligne courte d'un texte justifié.
 */
/**
 * Élément de liste : la ligne commence par une étiquette — « (d) », « 2. », « a) », « iii) »,
 * « • », « – » — suivie d'un blanc. Renvoie l'abscisse du texte qui suit l'étiquette (là où
 * s'alignent les lignes suivantes, en retrait « suspendu »), ou null.
 */
function hangOf(l: Line): number | null {
  const chars = l.chars
  const text = chars.map((c) => c.c).join('')
  const m = /^\s*(\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]|[•●▪◦‣∙·\-–—*➢►✓])/u.exec(text)
  if (!m) return null
  const end = [...m[0]].length
  let j = end
  while (j < chars.length && isSpace(chars[j])) j++
  if (j >= chars.length || j === end && chars[j].x0 - chars[end - 1].x1 < l.size * 0.2) return null
  return chars[j].x
}

function paragraph(lines: Line[], hit: Line, fonts: PdfCharFont[]): Line[] {
  const same = (l: Line): boolean =>
    l !== hit &&
    Math.abs(l.size - hit.size) <= hit.size * 0.1 &&
    familyKey(fonts[l.font]) === familyKey(fonts[hit.font]) &&
    Math.min(l.x1, hit.x1) - Math.max(l.x0, hit.x0) > Math.min(l.x1 - l.x0, hit.x1 - hit.x0) * 0.3
  const others = lines.filter(same)
  const block = [hit]
  let pitch = 0
  const right = (): number => Math.max(...block.map((l) => l.x1))
  const justified = (): boolean => block.length >= 2 && block.slice(0, -1).filter((l) => Math.abs(l.x1 - right()) < 1.5).length >= 1
  // Vers le bas
  for (;;) {
    const last = block.at(-1)!
    const next = others.filter((l) => l.baseline > last.baseline + last.size * 0.5).sort((a, b) => a.baseline - b.baseline)[0]
    if (!next) break
    const gap = next.baseline - last.baseline
    if (gap > last.size * 1.9 || (pitch && Math.abs(gap - pitch) > pitch * 0.15)) break
    if (hangOf(next) !== null) break // élément de liste suivant : « (e) », « 3. »…
    // Retrait : nouveau paragraphe — sauf sous l'étiquette d'un élément de liste, où les lignes
    // suivantes s'alignent sur le texte après l'étiquette (retrait suspendu, LaTeX, Word).
    const hang = block.length === 1 ? hangOf(last) : null
    const hanging = hang !== null && Math.abs(next.start - hang) < last.size * 0.6
    if (next.x0 > last.x0 + last.size * 0.6 && !hanging) break
    if (justified() && last.x1 < right() - last.size * 1.5) break // ligne courte : fin de paragraphe
    pitch ||= gap
    block.push(next)
  }
  // Vers le haut
  for (;;) {
    const first = block[0]
    const prev = others.filter((l) => l.baseline < first.baseline - first.size * 0.5).sort((a, b) => b.baseline - a.baseline)[0]
    if (!prev) break
    const gap = first.baseline - prev.baseline
    if (gap > first.size * 1.9 || (pitch && Math.abs(gap - pitch) > pitch * 0.15)) break
    if (hangOf(first) !== null) break // une étiquette de liste commence le paragraphe
    const prevHang = hangOf(prev)
    const underLabel = prevHang !== null && Math.abs(first.start - prevHang) < first.size * 0.6
    if (first.x0 > prev.x0 + first.size * 0.6 && !underLabel) break // la ligne du dessous est en retrait : elle commence le paragraphe
    const r = Math.max(right(), prev.x1)
    if (block.length >= 2 && prev.x1 < r - first.size * 1.5 && Math.abs(block[0].x1 - r) < 1.5) break // ligne courte au-dessus
    pitch ||= gap
    block.unshift(prev)
  }
  return block
}

interface Found {
  page: Page
  chars: PdfChar[]
  fonts: PdfCharFont[]
  lines: Line[]
}

/** Paragraphe du PDF sous un point (coordonnées document), ou null. */
/** Caractères du PDF et texte reconnu par OCR de la page, police OCR en dernier. */
async function pageChars(page: Page): Promise<{ chars: PdfChar[]; fonts: PdfCharFont[] }> {
  const pdf = page.bg.kind === 'pdf' ? await pdfEngine.chars(page.bg.assetId, page.bg.index) : { chars: [], fonts: [] }
  if (!page.ocr?.chars.length) return pdf
  // Texte reconnu par OCR : police inconnue, on écrit avec une police courante.
  const ocrFont: PdfCharFont = { name: 'OCR', family: '', bold: false, italic: false, embedded: false, sample: -1 }
  const k = pdf.fonts.length
  return { chars: [...pdf.chars, ...page.ocr.chars.map((c) => ({ ...c, f: k }))], fonts: [...pdf.fonts, ocrFont] }
}

async function blockAt(ed: Editor, p: Point): Promise<Found | null> {
  const page = ed.doc.pageAt(p)
  if (!page || (page.bg.kind !== 'pdf' && !page.ocr)) return null
  const { chars, fonts } = await pageChars(page)
  // Les zones déjà modifiées n'ont plus de texte d'origine (retiré du PDF ou recouvert).
  const zones = [...(page.masks ?? []), ...(page.covers ?? []).map((c) => c.slice(0, 4) as number[])]
  const visible = zones.length
    ? chars.filter((c) => !zones.some(([x0, y0, x1, y1]) => (c.x0 + c.x1) / 2 >= x0 && (c.x0 + c.x1) / 2 <= x1 && (c.y0 + c.y1) / 2 >= y0 && (c.y0 + c.y1) / 2 <= y1))
    : chars
  // Le contenu d'origine a pu être décalé (paragraphe modifié plus haut) : on raisonne
  // en coordonnées d'origine.
  const x = p.x - page.left
  const y = originalY(page, x, p.y - page.top)
  const lines = linesOf(splitLigatures(visible))
  const hit = lines.find((l) => x >= l.x0 - 3 && x <= l.x1 + 3 && y >= l.y0 - 3 && y <= l.y1 + 3)
  if (!hit) return null
  return { page, chars: splitLigatures(visible), fonts, lines: paragraph(lines, hit, fonts) }
}

function rectOf(lines: Line[]): Box4 {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    y0: Math.min(...lines.map((l) => l.y0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y1: Math.max(...lines.map((l) => l.y1))
  }
}

/** Paragraphe du PDF sous un point (pour l'encadrer au survol), en coordonnées document. */
export async function paragraphAt(ed: Editor, p: Point): Promise<Box4 | null> {
  const found = await blockAt(ed, p)
  if (!found) return null
  const r = rectOf(found.lines)
  const dy = shiftAt(found.page, (r.x0 + r.x1) / 2, r.y0)
  return { x0: r.x0 + found.page.left, y0: r.y0 + found.page.top + dy, x1: r.x1 + found.page.left, y1: r.y1 + found.page.top + dy }
}

/** Mot du PDF sous un point, ou null. */
export async function wordAt(ed: Editor, p: Point): Promise<Box4 | null> {
  const page = ed.doc.pageAt(p)
  if (!page || (page.bg.kind !== 'pdf' && !page.ocr)) return null
  const hit = nearestWord(await pageWords(page), p.x, p.y)
  if (!hit || p.x < hit.x0 - 2 || p.x > hit.x1 + 2 || p.y < hit.y0 - 2 || p.y > hit.y1 + 2) return null
  return hit
}

type Align = 'left' | 'center' | 'right' | 'justify-left'

/** Alignement d'après les bords des lignes (la première peut être en retrait, la dernière plus courte). */
function alignmentOf(lines: Line[]): Align {
  if (lines.length < 2) return 'left'
  const tol = 1.5
  const rest = lines.slice(1)
  const near = (a: number, b: number): boolean => Math.abs(a - b) < tol
  const right = Math.max(...lines.map((l) => l.x1))
  const leftsAligned = rest.every((l) => near(l.x0, rest[0].x0))
  const rightsBody = lines.slice(0, -1).every((l) => near(l.x1, right))
  // Justifié : les lignes pleines ont des espaces élargis par rapport à la dernière ligne.
  if (leftsAligned && rightsBody && lines.length >= 2) {
    const body = lines.slice(0, -1).map(spaceWidth).filter((w) => w > 0)
    const last = spaceWidth(lines.at(-1)!)
    if (body.length && last > 0) return Math.min(...body) > last * 1.08 ? 'justify-left' : 'left'
    return lines.length >= 3 ? 'justify-left' : 'left'
  }
  if (leftsAligned) return 'left'
  if (lines.every((l) => near(l.x1, right))) return 'right'
  const c = (l: Line): number => (l.x0 + l.x1) / 2
  if (lines.every((l) => near(c(l), c(lines[0])))) return 'center'
  return 'left'
}

/** Largeur moyenne des espaces entre mots d'une ligne (en fraction de la taille), 0 si aucun. */
function spaceWidth(l: Line): number {
  const ink = l.chars.filter((c) => !isSpace(c))
  let total = 0
  let n = 0
  for (let i = 0; i + 1 < l.chars.length; i++) {
    if (!isSpace(l.chars[i])) continue
    const before = ink.filter((c) => c.x <= l.chars[i].x).at(-1)
    const after = ink.find((c) => c.x > l.chars[i].x)
    if (!before || !after) continue
    total += (after.x0 - before.x1) / l.size
    n++
  }
  return n ? total / n : 0
}

/** Texte d'une ligne (espaces de début et de fin retirés). */
const lineText = (l: Line): string => l.chars.map((c) => c.c).join('').trim()

const installed = new Map<string, boolean>()

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
/** La police du PDF est-elle installée sur l'appareil (sous son nom) ? */
function isInstalledName(f: PdfCharFont | undefined): boolean {
  if (!f) return false
  const base = f.name.replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '').replace(/(PS)?MT$/, '')
  return [f.family, base, base.replace(/([a-z])([A-Z])/g, '$1 $2')].some((n) => n && isInstalled(n))
}

export function closestFont(pdfName: string, family = ''): string {
  const base = pdfName.replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '').replace(/(PS)?MT$/, '')
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2')
  for (const candidate of [family, base, spaced]) if (candidate && isInstalled(candidate)) return candidate
  const n = `${family} ${pdfName}`.toLowerCase()
  if (/courier|mono|consol|menlo/.test(n)) return 'Courier New'
  if (/calibri|carlito/.test(n)) return isInstalled('Carlito') ? 'Carlito' : 'Arial'
  if (/cambria|caladea/.test(n)) return isInstalled('Caladea') ? 'Caladea' : 'Times New Roman'
  if (/times|roman|georgia|garamond|book|minion|palatino|serif/.test(n) && !/sans/.test(n)) return 'Times New Roman'
  return 'Arial'
}

/** Position de la ligne de base de la première ligne d'une zone de texte Fabric, depuis son haut. */
const baselineOffset = (size: number): number => size * 1.13 * (1 - 0.222)

export async function editTextAt(ed: Editor, p: Point): Promise<Textbox | null> {
  const found = await blockAt(ed, p)
  if (!found) return null
  const { page, lines, fonts, chars } = found
  const bg = page.bg as { assetId: string; index: number }
  // Paragraphe venu de l'OCR (texte en image) : il sera recouvert, pas retiré du PDF.
  const fromOcr = lines.every((l) => l.chars.every((c) => isSpace(c) || c.bg !== undefined))
  if (fromOcr) {
    // Police du scan devinée par comparaison des formes ; elle corrige aussi la taille.
    const guess = await matchFont(page, lines.flatMap((l) => [...l.chars, { ...l.chars[0], c: ' ' }]))
    const k = lines[0].font
    fonts[k] = { ...fonts[k], name: guess.family, family: guess.family, bold: guess.bold, italic: guess.italic }
    for (const l of lines) {
      l.size = Math.round(l.size * guess.scale * 10) / 10
      for (const c of l.chars) c.size = Math.round(c.size * guess.scale * 10) / 10
    }
  }

  // Polices d'origine (reconstruites depuis le PDF) de tous les caractères du paragraphe.
  const used = new Map<number, Set<number>>()
  for (const c of chars) {
    if (c.f < 0) continue
    if (!used.has(c.f)) used.set(c.f, new Set())
    used.get(c.f)!.add(c.c.codePointAt(0)!)
  }
  // Avance réelle de chaque caractère dans la page (en millièmes d'em) : un glyphe qui ne
  // correspond pas (ligature « fi » rendue pour « f »…) est laissé à la police de secours.
  const advances = new Map<number, Map<number, number[]>>()
  for (const l of linesOf(chars)) {
    for (let i = 0; i + 1 < l.chars.length; i++) {
      const a = l.chars[i]
      const b = l.chars[i + 1]
      // Espace ajouté par PDFium entre deux mots : sa position est approximative, elle ne dit
      // rien de la largeur de la lettre d'avant (« G », « n » isolés en italique…).
      if (a.f < 0 || a.f !== b.f || isSpace(a) || isSpace(b) || a.size <= 0) continue
      if (!advances.has(a.f)) advances.set(a.f, new Map())
      const m = advances.get(a.f)!
      const u = a.c.codePointAt(0)!
      if (!m.has(u)) m.set(u, [])
      m.get(u)!.push(((b.x - a.x) / a.size) * 1000)
    }
  }
  // Polices sans nom découpées en morceaux (Chrome met quelques lettres dans chacune) : celles
  // qui se suivent dans un même mot vont ensemble (le romain avec le romain, le gras avec le gras).
  const unnamed = (k: number): boolean => k >= 0 && !fonts[k]?.name && !fonts[k]?.family
  const group = new Map<number, number>()
  const root = (k: number): number => {
    while (group.has(k) && group.get(k) !== k) k = group.get(k)!
    return k
  }
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]
    const b = chars[i]
    if (isSpace(a) || isSpace(b) || a.f === b.f || !unnamed(a.f) || !unnamed(b.f) || Math.abs(a.y - b.y) > a.size * 0.3) continue
    const ra = root(a.f)
    const rb = root(b.f)
    group.set(a.f, ra)
    if (ra !== rb) group.set(rb, ra)
  }
  // Morceau qui ne contient que des espaces : il va avec toutes les polices sans nom.
  const spaceOnly = new Set(fonts.map((_, j) => j).filter((j) => unnamed(j) && chars.some((c) => c.f === j) && chars.every((c) => c.f !== j || isSpace(c))))
  const siblings = (k: number): number[] =>
    unnamed(k) ? fonts.map((_, j) => j).filter((j) => j !== k && unnamed(j) && (root(j) === root(k) || spaceOnly.has(j))) : []
  const inPara = [...new Set(lines.flatMap((l) => l.chars.map((c) => c.f)).filter((f) => f >= 0))]
  const keys = [...new Set([...inPara, ...inPara.flatMap(siblings)])].filter((k) => used.has(k))
  const faces = new Map<number, EmbeddedFace | null>()
  await Promise.all(keys.map(async (k) => faces.set(k, fonts[k].sample < 0 || page.bg.kind !== 'pdf' ? null : await embeddedFace(bg.assetId, bg.index, fonts[k], used.get(k) ?? [], advances.get(k)))))
  // Police d'origine illisible et absente de l'appareil : la plus ressemblante, d'après la forme
  // des mots du paragraphe (comme pour un scan), plutôt qu'Arial par défaut.
  const lookalike = new Map<number, string>()
  for (const k of inPara) {
    const f = fonts[k]
    if (lookalike.has(k) || faces.get(k) || siblings(k).some((j) => faces.get(j)) || fromOcr || isInstalledName(f)) continue
    // Police en morceaux : on compare les mots entiers (tous les morceaux du groupe).
    const family = new Set([k, ...siblings(k)])
    const own = lines.flatMap((l) => l.chars.filter((c) => family.has(c.f) || isSpace(c)))
    if (own.filter((c) => !isSpace(c)).length < 3) continue
    const guess = await matchFont(page, own)
    for (const j of family) {
      lookalike.set(j, guess.family)
      // Sans nom, la graisse et le style ne sont connus que par la forme des lettres.
      if (unnamed(j)) fonts[j] = { ...fonts[j], bold: fonts[j].bold || guess.bold, italic: fonts[j].italic || guess.italic }
    }
  }
  const familyOf = (k: number): string => {
    const f = fonts[k]
    const fallback = lookalike.get(k) ?? closestFont(f?.name ?? '', f?.family ?? '')
    const own = [faces.get(k), ...siblings(k).map((j) => faces.get(j))].filter((x): x is EmbeddedFace => !!x)
    return own.length ? [...own.map((x) => `'${x.family}'`), `'${fallback}'`].join(', ') : fallback
  }
  for (const face of faces.values()) if (face) cache.clearFontCache(face.family)

  // Texte : lignes recollées par des espaces (le retour automatique les recoupera au même
  // endroit) ; après un trait d'union en fin de ligne, on garde le retour tel quel.
  const parts: { text: string; chars: PdfChar[] }[] = []
  lines.forEach((l, i) => {
    const t = lineText(l)
    const sep = i === lines.length - 1 ? '' : /[-‐]$/.test(t) ? '\n' : ' '
    parts.push({ text: t + sep, chars: l.chars })
  })
  // Élément de liste : l'étiquette est suivie d'espaces insécables (ni étirés par la
  // justification, ni coupés) qui amènent le texte au même retrait que les lignes suivantes.
  const main = mode(lines.flatMap((l) => l.chars.filter((c) => !isSpace(c)).map((c) => c.f)))
  const mainFont = fonts[main]
  const size = mode(lines.map((l) => l.size))

  // Élément de liste (« (d) ») : l'étiquette est suivie d'espaces insécables — ni étirés par
  // la justification, ni coupés — jusqu'au retrait des lignes suivantes.
  const hang = lines.length > 1 ? hangOf(lines[0]) : null
  const label = hang !== null ? /^(\S+)([ \t\u00a0]+)/u.exec(parts[0].text) : null
  if (hang !== null && label) {
    const font = { fontStyle: mainFont?.italic ? 'italic' : 'normal', fontWeight: mainFont?.bold ? 'bold' : 'normal', fontSize: size, fontFamily: familyOf(main) } as Textbox
    const nb = measure(font, '\u00a0') || size * 0.25
    const n = Math.max(1, Math.round((hang - lines[0].start - measure(font, label[1])) / nb))
    parts[0].text = label[1] + '\u00a0'.repeat(n) + parts[0].text.slice(label[0].length)
  }
  const text = parts.map((p2) => p2.text).join('')
  const color = mode(lines.flatMap((l) => l.chars.filter((c) => !isSpace(c)).map((c) => c.color)))
  const align = alignmentOf(lines)
  const body = lines.length > 1 ? lines.slice(1) : lines
  // Bord gauche : origine des caractères (et non leur boîte), comme le dessin de la police.
  const left = align === 'left' || align === 'justify-left' ? Math.min(...body.map((l) => l.start)) : Math.min(...lines.map((l) => l.start))
  const right = Math.max(...lines.map((l) => l.x1))
  const firstIndent = (align === 'left' || align === 'justify-left') && lines.length > 1 && Math.abs(lines[0].start - left) > 1 ? lines[0].start - left : 0
  const pitch = lines.length > 1 ? (lines.at(-1)!.baseline - lines[0].baseline) / (lines.length - 1) : size * 1.16 * 1.13
  // Largeur : celle du paragraphe, à peine plus (le retour à la ligne retombe aux mêmes mots).
  const width = Math.max(10, right - left + (align === 'justify-left' ? 0 : 0.5 + size * 0.02))

  const r0 = rectOf(lines)
  const shifted = shiftAt(page, (r0.x0 + r0.x1) / 2, r0.y0)
  const box = new Textbox(text, {
    left: page.left + left,
    top: page.top + lines[0].baseline - baselineOffset(size) + shifted,
    width,
    fontSize: size,
    fontFamily: familyOf(main),
    fontWeight: mainFont?.bold ? 'bold' : 'normal',
    fontStyle: mainFont?.italic ? 'italic' : 'normal',
    fill: color,
    lineHeight: Math.min(4, Math.max(0.5, pitch / (size * 1.13))),
    textAlign: align,
    splitByGrapheme: false,
    // Pas de bordure : sinon Fabric décale le contenu d'une demi-épaisseur.
    strokeWidth: 0
  })
  box.set({ firstIndent, pdfEdit: true, pdfFonts: [...faces.values()].filter(Boolean) } as never)

  // Caractères dans une autre police (mot en gras…), une autre taille ou une autre couleur.
  let offset = 0
  for (const part of parts) {
    const ink = part.chars.filter((c) => !isSpace(c))
    let k = 0
    for (const ch of [...part.text.trimEnd()]) {
      if (/\s/.test(ch)) {
        offset++
        continue
      }
      const c = ink[k++]
      if (c && ((c.f !== main && !siblings(main).includes(c.f)) || Math.abs(c.size - size) > 0.05 || c.color !== color)) {
        const f = fonts[c.f]
        box.setSelectionStyles(
          { fontFamily: familyOf(c.f), fontWeight: f?.bold ? 'bold' : 'normal', fontStyle: f?.italic ? 'italic' : 'normal', fontSize: c.size, fill: c.color },
          offset,
          offset + 1
        )
      }
      offset++
    }
    offset += part.text.length - part.text.trimEnd().length
  }
  box.initDimensions()

  // Contrôle : mêmes retours à la ligne que l'original ; sinon on ajuste l'espacement des
  // lettres (police de secours un peu plus large ou plus étroite), puis on fige les retours.
  const flat = (t: string): string => t.replace(/\s+/gu, ' ').trim()
  const sameBreaks = (): boolean => box._textLines.length === lines.length && box._textLines.every((l, i) => flat(l.join('')) === flat(lineText(lines[i])))
  if (!sameBreaks()) {
    const natural = lines.map((l, i) => (i === lines.length - 1 || align !== 'justify-left' ? l.x1 - l.x0 : 0))
    const measured = lines.map((l) => measure(box, lineText(l)))
    let diff = 0
    let n = 0
    lines.forEach((l, i) => {
      if (!natural[i] || !measured[i]) return
      diff += natural[i] - measured[i]
      n += [...lineText(l)].length
    })
    if (n) box.set({ charSpacing: Math.max(-200, Math.min(200, (diff / n / size) * 1000)) })
    box.initDimensions()
    if (!sameBreaks()) {
      // Retours figés aux mêmes endroits que l'original, sans perdre l'italique, le gras… :
      // les styles sont repris caractère par caractère (même longueur de texte).
      const styles = box.getSelectionStyles(0, box._text.length)
      const chars = [...box._text]
      let at = 0
      for (const part of parts) {
        at += [...part.text].length
        if (part.text.endsWith(' ') && at - 1 < chars.length) chars[at - 1] = '\n'
      }
      box.set({ text: chars.join(''), width: width + size * 2, styles: {} })
      styles.forEach((st, i) => Object.keys(st).length && box.setSelectionStyles(st, i, i + 1))
      box.initDimensions()
    }
  }

  // Si le paragraphe gagne ou perd des lignes, la suite de sa colonne suivra (voir flow.ts).
  const r = rectOf(lines)
  box.set({ pdfFlow: { id: crypto.randomUUID(), pageId: page.pageId, x0: r.x0 - 2, x1: r.x1 + 2, y: r.y1 + 0.5, h0: box.getScaledHeight() } } as never)
  // Le texte d'origine est retiré du PDF : la zone exacte des caractères du paragraphe.
  const mask: [number, number, number, number] = [r.x0 - 0.5, r.y0 - 0.5, r.x1 + 0.5, r.y1 + 0.5]
  await ed.history.transaction(() => {
    if (fromOcr) {
      // Texte en image : recouvert de la couleur du fond autour de lui.
      const back = mode(lines.flatMap((l) => l.chars.map((c) => c.bg ?? '#ffffff')))
      const pad = size * 0.15
      page.set({ covers: [...(page.covers ?? []), [r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad, back]] } as never)
      page.dirty = true
    } else page.set({ masks: [...(page.masks ?? []), mask] } as never)
    ed.add(box)
  })
  ed.canvas.setActiveObject(box)
  box.enterEditing()
  box.hiddenTextarea?.focus()
  ed.canvas.requestRenderAll()
  return box
}

/** Largeur d'un texte avec la police et la taille de la zone (sans espacement des lettres). */
const measureCtx = document.createElement('canvas').getContext('2d')!
function measure(box: Textbox, text: string): number {
  const ctx = measureCtx
  ctx.font = `${box.fontStyle} ${box.fontWeight} ${box.fontSize}px ${box.fontFamily.includes(',') ? box.fontFamily : `"${box.fontFamily}"`}`
  return ctx.measureText(text).width
}

export type { Page }
