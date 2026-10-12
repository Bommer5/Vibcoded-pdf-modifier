import type { FabricObject, IText } from 'fabric'
import { util } from 'fabric'
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib'
import { Table } from '../objects/table'

/**
 * Texte vectoriel dans les PDF exportés, avec de vraies polices :
 * - la police exacte de l'ordinateur si elle est installée (API Local Font Access) ;
 * - sinon une police libre aux mêmes dimensions (Liberation ≈ Arial / Times / Courier,
 *   Carlito ≈ Calibri, Caladea ≈ Cambria) : la mise en page reste identique à l'écran ;
 * - polices réduites aux seuls caractères utilisés (sous-ensembles) : fichiers légers ;
 * - Unicode complet dans la limite des caractères de la police ; sinon l'objet est
 *   intégré en image haute définition plutôt que d'afficher des carrés vides.
 */

const FONT_URLS = import.meta.glob('../fonts/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>

type Style = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic'

function bundledFile(family: string, style: Style): string {
  const f = family.toLowerCase()
  const base = /calibri|carlito/.test(f)
    ? 'Carlito'
    : /cambria|caladea/.test(f)
      ? 'Caladea'
      : /mono|courier|consol|menlo|code/.test(f)
        ? 'LiberationMono'
        : /times|roman|georgia|garamond|book|minion|palatino|serif/.test(f) && !/sans/.test(f)
          ? 'LiberationSerif'
          : 'LiberationSans'
  return `../fonts/${base}-${style}.ttf`
}

const styleOf = (bold: boolean, italic: boolean): Style => (bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular')

interface FontFile {
  bytes: Uint8Array
  /** Nom PostScript (pour nommer le sous-ensemble selon la norme PDF). */
  psName: string
}

const bytesCache = new Map<string, Promise<FontFile | null>>()

interface LocalFontData {
  family: string
  style: string
  postscriptName: string
  blob(): Promise<Blob>
}

/** Police installée sur l'appareil (si l'API est disponible et la police n'est pas une collection TTC). */
async function localFont(family: string, style: Style): Promise<FontFile | null> {
  const query = (window as Window & { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
  if (!query) return null
  try {
    const fonts = (await query()).filter((f) => f.family.toLowerCase() === family.toLowerCase())
    const want = style === 'Regular' ? /^(regular|normal|book|roman)$/i : style === 'BoldItalic' ? /bold.*(italic|oblique)/i : new RegExp(`^${style}$`, 'i')
    const match = fonts.find((f) => want.test(f.style))
    if (!match) return null
    const bytes = new Uint8Array(await (await match.blob()).arrayBuffer())
    const tag = String.fromCharCode(...bytes.subarray(0, 4))
    return tag === 'ttcf' ? null : { bytes, psName: match.postscriptName }
  } catch {
    return null
  }
}

function fontBytes(family: string, style: Style): Promise<FontFile | null> {
  const key = `${family}|${style}`
  let p = bytesCache.get(key)
  if (!p) {
    p = (async () => {
      const local = await localFont(family, style)
      if (local) return local
      const file = bundledFile(family, style)
      const url = FONT_URLS[file]
      if (!url) return null
      return { bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()), psName: file.split('/').pop()!.replace('.ttf', '').replace('-Regular', '') }
    })()
    bytesCache.set(key, p)
  }
  return p
}

/** Polices intégrées à un PDF en cours de construction (une seule fois chacune, en sous-ensemble). */
export class PdfFonts {
  /** Une police intégrée par fichier réel (Arial et Helvetica → même police : une seule fois). */
  private fonts = new Map<string, Promise<PDFFont>>()
  constructor(private out: PDFDocument) {}

  async get(family: string, bold: boolean, italic: boolean): Promise<PDFFont> {
    const style = styleOf(bold, italic)
    const file = (await fontBytes(family, style)) ?? (await fontBytes('Liberation Sans', style))
    let f = this.fonts.get(file!.psName)
    if (!f) {
      // Sous-ensemble nommé selon la norme PDF : six majuscules + « + » + nom PostScript.
      const tag = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')
      f = this.out.embedFont(file!.bytes, { subset: true, customName: `${tag}+${file!.psName}` })
      this.fonts.set(file!.psName, f)
    }
    return f
  }
}

/** Une portion de texte à dessiner (repère local de l'objet, origine au centre, y vers le bas). */
interface Run {
  text: string
  x: number
  y: number
  /** Largeur mesurée à l'écran (sans l'espace final), pour caler exactement le mot dans le PDF. */
  width?: number
  size: number
  family: string
  bold: boolean
  italic: boolean
  color: string
  opacity: number
  /** Rectangles pleins associés (soulignement, barré, surlignage du texte). */
  rects: { x: number; y: number; w: number; h: number; color: string; behind: boolean }[]
}

export const isTextObject = (o: FabricObject): o is IText => typeof (o as IText)._textLines !== 'undefined' && 'text' in o

/** Décompose un texte Fabric en portions positionnées exactement comme à l'écran. */
function textRuns(o: IText): Run[] {
  const t = o as unknown as {
    _textLines: string[][]
    lineHeight: number
    getCompleteStyleDeclaration(i: number, j: number): object
    _getTopOffset(): number
    _getLeftOffset(): number
    _getLineLeftOffset(i: number): number
    getHeightOfLineImpl(i: number): number
    getHeightOfLine(i: number): number
    __charBounds: { left: number; width: number; kernedWidth: number }[][]
    _fontSizeFraction: number
    offsets: Record<string, number>
    textDecorationThickness?: number
  }
  const runs: Run[] = []
  const left = t._getLeftOffset()
  let lineTop = t._getTopOffset()
  for (let i = 0; i < t._textLines.length; i++) {
    const line = t._textLines[i]
    const impl = t.getHeightOfLineImpl(i)
    const baseline = lineTop + impl - impl * t._fontSizeFraction
    const lineLeft = left + t._getLineLeftOffset(i)
    let current: Run | null = null
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      const s = t.getCompleteStyleDeclaration(i, j) as Record<string, unknown>
      const box = t.__charBounds[i][j]
      const size = Number(s.fontSize)
      const style = {
        family: String(s.fontFamily),
        bold: s.fontWeight === 'bold' || Number(s.fontWeight) >= 600,
        italic: s.fontStyle === 'italic' || s.fontStyle === 'oblique',
        color: String(s.fill ?? '#000000'),
        size
      }
      const x = lineLeft + box.left
      const y = baseline + Number(s.deltaY ?? 0)
      // Nouvelle portion à chaque mot (positions exactes, justification comprise) ou changement de style.
      // L'espace reste attaché au mot précédent : copier-coller et recherche gardent les espaces.
      const wordStart = !/\s/.test(ch) && /\s/.test(current?.text.at(-1) ?? '')
      const same =
        current && !wordStart &&
        current.family === style.family && current.bold === style.bold && current.italic === style.italic &&
        current.color === style.color && current.size === size && current.y === y
      if (!same) {
        if (current) runs.push(current)
        current = { text: '', x, y, ...style, opacity: 1, rects: [] }
      }
      current!.text += ch
      if (!/\s/.test(ch)) current!.width = x + box.kernedWidth - current!.x
      const thick = (size * (t.textDecorationThickness ?? 66.667)) / 1000
      const bg = s.textBackgroundColor as string | undefined
      if (bg) current!.rects.push({ x, y: lineTop, w: box.kernedWidth, h: t.getHeightOfLine(i) / t.lineHeight, color: bg, behind: true })
      const charBase = lineTop + (t.getHeightOfLine(i) / t.lineHeight) * (1 - t._fontSizeFraction) + Number(s.deltaY ?? 0)
      if (s.underline) current!.rects.push({ x, y: charBase + t.offsets.underline * size, w: box.kernedWidth, h: thick, color: style.color, behind: false })
      if (s.linethrough) current!.rects.push({ x, y: charBase + t.offsets.linethrough * size - thick / 2, w: box.kernedWidth, h: thick, color: style.color, behind: false })
    }
    if (current) runs.push(current)
    lineTop += t.getHeightOfLine(i)
  }
  return runs.filter((r) => r.text.trim() || r.rects.length)
}

function tableRuns(t: Table): Run[] {
  return t.exportRuns().map((r) => ({ ...r, opacity: 1, italic: false, rects: [] }))
}

/** Objets dont le texte est écrit avec de vraies polices (et retiré de la surcouche vectorielle SVG). */
export const hasRealText = (o: FabricObject): boolean => isTextObject(o) || o instanceof Table

function hex(color: string): [number, number, number] {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = color
  const v = ctx.fillStyle as string // normalisé en #rrggbb (ou rgba(...))
  if (v.startsWith('#')) return [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16) / 255) as [number, number, number]
  const m = v.match(/[\d.]+/g)!.map(Number)
  return [m[0] / 255, m[1] / 255, m[2] / 255]
}

/**
 * Dessine le texte d'un objet sur une page PDF. `display` convertit le repère de la page
 * affichée (points, y vers le bas) vers celui de la page PDF (rotation /Rotate comprise).
 * Renvoie false si un caractère manque dans la police (l'appelant intègre alors une image).
 */
export async function drawTextObject(
  pdf: typeof import('pdf-lib'),
  fonts: PdfFonts,
  target: PDFPage,
  obj: FabricObject,
  pageOrigin: { left: number; top: number },
  display: number[]
): Promise<boolean> {
  const runs = obj instanceof Table ? tableRuns(obj) : textRuns(obj as IText)
  if (!runs.length) return true
  // Repère local de l'objet → page affichée → page PDF.
  const local = util.multiplyTransformMatrices([1, 0, 0, 1, -pageOrigin.left, -pageOrigin.top], obj.calcTransformMatrix())
  const m = util.multiplyTransformMatrices(display as never, local)

  const embedded = await Promise.all(runs.map((r) => fonts.get(r.family, r.bold, r.italic)))
  for (const [k, r] of runs.entries()) {
    const fk = (embedded[k] as unknown as { embedder?: { font?: { hasGlyphForCodePoint?(c: number): boolean } } }).embedder?.font
    if (fk?.hasGlyphForCodePoint && [...r.text].some((ch) => !/\s/.test(ch) && !fk.hasGlyphForCodePoint!(ch.codePointAt(0)!))) return false
  }

  const ops = pdf
  const opacity = obj.opacity ?? 1
  const out: import('pdf-lib').PDFOperator[] = [ops.pushGraphicsState(), ops.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5])]
  if (opacity < 1) {
    const gs = target.doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity })
    const name = target.node.newExtGState('GS', target.doc.context.register(gs))
    out.push(ops.setGraphicsState(name))
  }
  const rect = (x: number, y: number, w: number, h: number, color: string): void => {
    const [cr, cg, cb] = hex(color)
    out.push(ops.setFillingRgbColor(cr, cg, cb), ops.rectangle(x, y, w, h), ops.fill())
  }
  for (const r of runs) for (const b of r.rects) if (b.behind) rect(b.x, b.y, b.w, b.h, b.color)
  for (const [k, r] of runs.entries()) {
    if (!r.text.trim()) continue
    const font = embedded[k]
    const key = target.node.newFontDictionary(font.name, font.ref)
    const [cr, cg, cb] = hex(r.color)
    // Filet de sécurité : si la police du PDF n'a pas exactement les mêmes largeurs que celle
    // de l'écran, le mot est légèrement resserré ou élargi pour occuper la même place.
    const natural = font.widthOfTextAtSize(r.text.trimEnd(), r.size)
    const scale = r.width && natural > 0 ? Math.min(130, Math.max(70, (100 * r.width) / natural)) : 100
    out.push(
      ops.setFillingRgbColor(cr, cg, cb),
      ops.beginText(),
      ops.setFontAndSize(key, r.size),
      ops.setCharacterSqueeze(Math.abs(scale - 100) < 0.5 ? 100 : scale),
      // Le repère de l'objet a l'axe y vers le bas : on retourne les glyphes pour qu'ils restent droits.
      ops.setTextMatrix(1, 0, 0, -1, r.x, r.y),
      ops.showText(font.encodeText(r.text)),
      ops.endText()
    )
  }
  for (const r of runs) for (const b of r.rects) if (!b.behind) rect(b.x, b.y, b.w, b.h, b.color)
  out.push(ops.popGraphicsState())
  target.pushOperators(...out)
  return true
}
