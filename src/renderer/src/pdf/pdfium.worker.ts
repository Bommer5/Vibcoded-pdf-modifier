/// <reference lib="webworker" />
/**
 * Moteur PDF natif : PDFium (C++, moteur de Chrome) compilé en WebAssembly,
 * exécuté hors du fil de l'interface. Rendu, texte (boîtes de caractères) et sommaire.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import type { PdfChar, PdfCharFont, PdfGlyphFont, PdfFontInfo, PdfMask, PdfShift, PdfOutlineItem, PdfPageInfo, PdfRequest, PdfResponse, PdfWord } from './protocol'

const FPDF_ANNOT = 0x01
const FPDF_REVERSE_BYTE_ORDER = 0x10 // sortie RGBA au lieu de BGRA
const FPDFBitmap_BGRA = 4

interface Doc {
  handle: number
  buffer: number
  pages: PdfPageInfo[]
  /** Octets d'origine (pour produire une copie modifiée sans toucher au document affiché). */
  bytes: Uint8Array
}

const FPDF_PAGEOBJ_TEXT = 1

let engine: Promise<WrappedPdfiumModule> | null = null
const docs = new Map<string, Doc>()

function pdfium(): Promise<WrappedPdfiumModule> {
  engine ??= (async () => {
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
    const m = await init({ wasmBinary })
    m.PDFiumExt_Init()
    return m
  })()
  return engine
}

function heap(m: WrappedPdfiumModule): Uint8Array {
  const mod = m.pdfium as unknown as { HEAPU8?: Uint8Array; wasmExports: { memory?: WebAssembly.Memory } }
  return mod.wasmExports.memory ? new Uint8Array(mod.wasmExports.memory.buffer) : mod.HEAPU8!
}

/**
 * Taille réelle d'un caractère dans la page : la taille de police (Tf) multipliée par l'échelle
 * de la matrice du texte. Chrome, Skia, certains Word écrivent « 14,67 px » dans une page
 * réduite à 75 % : la lettre fait 11 pt, pas 14,67.
 */
function charSize(m: WrappedPdfiumModule, tp: number, i: number, buf: number): number {
  const size = m.FPDFText_GetFontSize(tp, i)
  if (!m.FPDFText_GetMatrix(tp, i, buf)) return size
  const [, , c, d] = f32(m, buf, 6)
  const k = Math.hypot(c, d)
  return k > 0.01 && Number.isFinite(k) ? size * k : size
}

function f32(m: WrappedPdfiumModule, ptr: number, count: number): Float32Array {
  return new Float32Array(heap(m).buffer, ptr, count).slice()
}

const FPDF_ERR_PASSWORD = 4
const FPDF_REMOVE_SECURITY = 3

/** Copie du document entier (option : sans chiffrement). */
function saveCopy(m: WrappedPdfiumModule, handle: number, flags: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const writer = m.pdfium.addFunction((_self: number, data: number, size: number) => {
    chunks.push(heap(m).slice(data, data + size))
    return 1
  }, 'iiii')
  const fw = m.pdfium.wasmExports.malloc(8)
  try {
    new Int32Array(heap(m).buffer, fw, 2).set([1, writer])
    if (!m.FPDF_SaveAsCopy(handle, fw, flags)) throw new Error('Enregistrement PDF impossible')
  } finally {
    m.pdfium.removeFunction(writer)
    m.pdfium.wasmExports.free(fw)
  }
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/**
 * Ouvre un PDF. S'il est chiffré (mot de passe d'ouverture, ou simples restrictions),
 * il est déverrouillé : on travaille ensuite sur une copie en clair, renvoyée à l'appelant.
 */
async function open(id: string, data: Uint8Array, password = ''): Promise<{ pages: PdfPageInfo[]; decrypted?: Uint8Array }> {
  const m = await pdfium()
  let buffer = m.pdfium.wasmExports.malloc(data.length)
  heap(m).set(data, buffer)
  let handle = m.FPDF_LoadMemDocument(buffer, data.length, password)
  if (!handle) {
    m.pdfium.wasmExports.free(buffer)
    throw new Error(m.FPDF_GetLastError() === FPDF_ERR_PASSWORD ? 'PASSWORD' : 'PDF illisible ou endommagé')
  }
  let decrypted: Uint8Array | undefined
  if (m.EPDF_IsEncrypted(handle)) {
    decrypted = saveCopy(m, handle, FPDF_REMOVE_SECURITY)
    m.FPDF_CloseDocument(handle)
    m.pdfium.wasmExports.free(buffer)
    buffer = m.pdfium.wasmExports.malloc(decrypted.length)
    heap(m).set(decrypted, buffer)
    handle = m.FPDF_LoadMemDocument(buffer, decrypted.length, '')
    data = decrypted
  }
  const count = m.FPDF_GetPageCount(handle)
  const sizePtr = m.pdfium.wasmExports.malloc(8)
  const pages: PdfPageInfo[] = []
  for (let i = 0; i < count; i++) {
    // Taille affichée (rotation /Rotate incluse).
    m.FPDF_GetPageSizeByIndexF(handle, i, sizePtr)
    const [w, h] = f32(m, sizePtr, 2)
    const rot = m.EPDF_GetPageRotationByIndex(handle, i)
    pages.push(rot % 2 === 1 ? { width: h, height: w } : { width: w, height: h })
  }
  m.pdfium.wasmExports.free(sizePtr)
  docs.set(id, { handle, buffer, pages, bytes: data })
  return { pages, decrypted }
}

async function close(id: string): Promise<void> {
  const m = await pdfium()
  const doc = docs.get(id)
  if (!doc) return
  m.FPDF_CloseDocument(doc.handle)
  m.pdfium.wasmExports.free(doc.buffer)
  docs.delete(id)
}

function getDoc(id: string): Doc {
  const doc = docs.get(id)
  if (!doc) throw new Error('Document PDF non chargé')
  return doc
}

async function render(id: string, index: number, width: number, height: number, masks?: PdfMask[], shifts?: PdfShift[]): Promise<ImageBitmap> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
  // Le texte modifié est retiré de la page chargée (en mémoire seulement) avant le rendu.
  let leftovers = masks?.length ? removeTextIn(m, page, doc.pages[index], masks).leftovers : []
  if (shifts?.length) leftovers = shiftContent(m, page, doc.pages[index], shifts, leftovers)
  const bmp = m.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, 0, 0)
  try {
    m.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff)
    m.FPDF_RenderPageBitmap(bmp, page, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER)
    const ptr = m.FPDFBitmap_GetBuffer(bmp)
    const stride = m.FPDFBitmap_GetStride(bmp)
    const src = heap(m)
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) pixels.set(src.subarray(ptr + y * stride, ptr + y * stride + width * 4), y * width * 4)
    for (const zone of leftovers) coverZone(m, page, pixels, width, height, zone)
    return await createImageBitmap(new ImageData(pixels, width, height))
  } finally {
    m.FPDFBitmap_Destroy(bmp)
    m.FPDF_ClosePage(page)
  }
}

/** Repère PDF de la page → repère affiché (points, y vers le bas). */
function toDisplay(m: WrappedPdfiumModule, page: number, info: PdfPageInfo, x: number, y: number): [number, number] {
  const K = 20
  const dev = m.pdfium.wasmExports.malloc(8)
  try {
    m.FPDF_PageToDevice(page, 0, 0, Math.round(info.width * K), Math.round(info.height * K), 0, x, y, dev, dev + 4)
    const v = new Int32Array(heap(m).buffer, dev, 2)
    return [v[0] / K, v[1] / K]
  } finally {
    m.pdfium.wasmExports.free(dev)
  }
}

/**
 * Décale le contenu d'origine situé sous un paragraphe modifié (texte, traits, images),
 * d'après sa position d'origine. Renvoie les zones à recouvrir, décalées de la même façon.
 */
function shiftContent(m: WrappedPdfiumModule, page: number, info: PdfPageInfo, shifts: PdfShift[], zones: number[][]): number[][] {
  // Décalage (repère PDF) d'un élément dont le haut affiché est en (x0..x1, top).
  const offset = (x0: number, x1: number, top: number): [number, number] => {
    let dy = 0
    for (const s of shifts) if (top >= s.y - 0.5 && x1 > s.x0 && x0 < s.x1) dy += s.dy
    if (!dy) return [0, 0]
    const [ax, ay] = toPage(m, page, info, (x0 + x1) / 2, top)
    const [bx, by] = toPage(m, page, info, (x0 + x1) / 2, top + dy)
    return [bx - ax, by - ay]
  }
  const box = m.pdfium.wasmExports.malloc(16)
  try {
    const n = m.FPDFPage_CountObjects(page)
    const moves: [number, number, number][] = []
    for (let i = 0; i < n; i++) {
      const obj = m.FPDFPage_GetObject(page, i)
      if (!m.FPDFPageObj_GetBounds(obj, box, box + 4, box + 8, box + 12)) continue
      const [l, b, r, t] = f32(m, box, 4)
      const [ax, ay] = toDisplay(m, page, info, l, t)
      const [bx, by] = toDisplay(m, page, info, r, b)
      const [dx, dy] = offset(Math.min(ax, bx), Math.max(ax, bx), Math.min(ay, by))
      if (dx || dy) moves.push([obj, dx, dy])
    }
    for (const [obj, dx, dy] of moves) m.FPDFPageObj_Transform(obj, 1, 0, 0, 1, dx, dy)
  } finally {
    m.pdfium.wasmExports.free(box)
  }
  return zones.map(([x0, y0, x1, y1]) => {
    const [ax, ay] = toDisplay(m, page, info, x0, y1)
    const [bx] = toDisplay(m, page, info, x1, y0)
    const [dx, dy] = offset(Math.min(ax, bx), Math.max(ax, bx), ay)
    return [x0 + dx, y0 + dy, x1 + dx, y1 + dy]
  })
}

/** Recouvre une zone (repère PDF) de la couleur du fond, prise sur son pourtour. */
function coverZone(m: WrappedPdfiumModule, page: number, px: Uint8ClampedArray, width: number, height: number, [x0, y0, x1, y1]: number[]): void {
  const dev = m.pdfium.wasmExports.malloc(8)
  const toDev = (x: number, y: number): [number, number] => {
    m.FPDF_PageToDevice(page, 0, 0, width, height, 0, x, y, dev, dev + 4)
    const v = new Int32Array(heap(m).buffer, dev, 2)
    return [v[0], v[1]]
  }
  try {
    const [ax, ay] = toDev(x0, y0)
    const [bx, by] = toDev(x1, y1)
    const l = Math.max(0, Math.min(ax, bx) - 1)
    const t = Math.max(0, Math.min(ay, by) - 1)
    const r = Math.min(width - 1, Math.max(ax, bx) + 1)
    const b = Math.min(height - 1, Math.max(ay, by) + 1)
    // Couleur la plus fréquente sur le pourtour (le fond, pas le texte).
    const count = new Map<number, number>()
    const sample = (x: number, y: number): void => {
      const i = (y * width + x) * 4
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]
      count.set(key, (count.get(key) ?? 0) + 1)
    }
    for (let x = l; x <= r; x++) {
      sample(x, t)
      sample(x, b)
    }
    for (let y = t; y <= b; y++) {
      sample(l, y)
      sample(r, y)
    }
    let bg = 0xffffff
    let best = 0
    for (const [k, n] of count) {
      if (n > best) {
        best = n
        bg = k
      }
    }
    for (let y = t + 1; y < b; y++) {
      for (let x = l + 1; x < r; x++) {
        const i = (y * width + x) * 4
        px[i] = bg >> 16
        px[i + 1] = (bg >> 8) & 255
        px[i + 2] = bg & 255
        px[i + 3] = 255
      }
    }
  } finally {
    m.pdfium.wasmExports.free(dev)
  }
}

/** Convertit un point du repère affiché (points, origine en haut à gauche) vers le repère PDF de la page. */
function toPage(m: WrappedPdfiumModule, page: number, info: PdfPageInfo, x: number, y: number): [number, number] {
  const K = 20
  const out = m.pdfium.wasmExports.malloc(16)
  try {
    m.FPDF_DeviceToPage(page, 0, 0, Math.round(info.width * K), Math.round(info.height * K), 0, Math.round(x * K), Math.round(y * K), out, out + 8)
    const v = new Float64Array(heap(m).buffer, out, 2)
    return [v[0], v[1]]
  } finally {
    m.pdfium.wasmExports.free(out)
  }
}

/**
 * Retire les objets texte dont l'essentiel tombe dans une zone masquée.
 * Renvoie le nombre d'objets retirés.
 */
function removeTextIn(m: WrappedPdfiumModule, page: number, info: PdfPageInfo, masks: PdfMask[]): { removed: number; leftovers: number[][] } {
  const zones = masks.map(([x0, y0, x1, y1]) => {
    const [ax, ay] = toPage(m, page, info, x0, y0)
    const [bx, by] = toPage(m, page, info, x1, y1)
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
  })
  const box = m.pdfium.wasmExports.malloc(16)
  let removed = 0
  try {
    for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
      const obj = m.FPDFPage_GetObject(page, i)
      if (m.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue
      if (!m.FPDFPageObj_GetBounds(obj, box, box + 4, box + 8, box + 12)) continue
      const [l, b, r, t] = f32(m, box, 4)
      const area = Math.max(1e-3, (r - l) * (t - b))
      const inside = zones.some(([zx0, zy0, zx1, zy1]) => {
        const w = Math.min(r, zx1) - Math.max(l, zx0)
        const h = Math.min(t, zy1) - Math.max(b, zy0)
        return w > 0 && h > 0 && (w * h) / area > 0.5
      })
      if (inside && m.FPDFPage_RemoveObject(page, obj)) {
        m.FPDFPageObj_Destroy(obj)
        removed++
      }
    }
  } finally {
    m.pdfium.wasmExports.free(box)
  }
  return { removed, leftovers: leftoverZones(m, page, zones) }
}

/**
 * Zones (repère PDF) où il reste du texte après le retrait : objet texte à cheval sur la zone
 * (une même instruction du PDF qui contient aussi du texte voisin). On le recouvrira de la
 * couleur du fond pour qu'aucun texte d'origine ne reste visible sous le texte modifié.
 */
function leftoverZones(m: WrappedPdfiumModule, page: number, zones: number[][]): number[][] {
  const tp = m.FPDFText_LoadPage(page)
  const box = m.pdfium.wasmExports.malloc(16)
  const hit = new Set<number>()
  try {
    const n = m.FPDFText_CountChars(tp)
    for (let i = 0; i < n; i++) {
      const code = m.FPDFText_GetUnicode(tp, i)
      if (!code || code === 32 || code === 10 || code === 13) continue
      if (!m.FPDFText_GetLooseCharBox(tp, i, box)) continue
      const [l, t, r, b] = f32(m, box, 4)
      const cx = (l + r) / 2
      const cy = (t + b) / 2
      zones.forEach(([x0, y0, x1, y1], k) => {
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) hit.add(k)
      })
    }
  } finally {
    m.pdfium.wasmExports.free(box)
    m.FPDFText_ClosePage(tp)
  }
  return [...hit].map((k) => zones[k])
}

/** Police, taille et couleur du texte sous un point (pour reproduire l'apparence en modification). */
async function fontInfo(id: string, index: number, x: number, y: number): Promise<PdfFontInfo | null> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
  const tp = m.FPDFText_LoadPage(page)
  const buf = m.pdfium.wasmExports.malloc(256)
  try {
    const [px, py] = toPage(m, page, doc.pages[index], x, y)
    const ci = m.FPDFText_GetCharIndexAtPos(tp, px, py, 4, 4)
    if (ci < 0) return null
    const fontSize = charSize(m, tp, ci, buf)
    const obj = m.FPDFText_GetTextObject(tp, ci)
    let fontName = ''
    let bold = false
    let italic = false
    let color = '#000000'
    if (obj) {
      const font = m.FPDFTextObj_GetFont(obj)
      if (font) {
        const len = m.FPDFFont_GetBaseFontName(font, buf, 256)
        fontName = len > 1 ? m.pdfium.UTF8ToString(buf) : ''
        bold = m.FPDFFont_GetWeight(font) >= 600 || /bold|black|heavy|semibold/i.test(fontName)
        italic = (m.FPDFFont_GetFlags(font) & 0x40) !== 0 || /italic|oblique/i.test(fontName)
      }
      if (m.FPDFPageObj_GetFillColor(obj, buf, buf + 4, buf + 8, buf + 12)) {
        const [r, g, b] = new Uint32Array(heap(m).buffer, buf, 3)
        color = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      }
    }
    return { fontSize, fontName: fontName.replace(/^[A-Z]{6}\+/, ''), bold, italic, color }
  } finally {
    m.pdfium.wasmExports.free(buf)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
  }
}

/**
 * Tous les caractères d'une page avec leur origine exacte (ligne de base), leur boîte, leur
 * taille, leur couleur et leur police : de quoi reconstruire un paragraphe à l'identique
 * (retraits, interligne, justification, mots en gras) pour le modifier.
 */
async function chars(id: string, index: number): Promise<{ chars: PdfChar[]; fonts: PdfCharFont[] }> {
  const m = await pdfium()
  const doc = getDoc(id)
  const { width: W, height: H } = doc.pages[index]
  const page = m.FPDF_LoadPage(doc.handle, index)
  const tp = m.FPDFText_LoadPage(page)
  const buf = m.pdfium.wasmExports.malloc(256)
  const dev = m.pdfium.wasmExports.malloc(8)
  const K = 20
  const toDevice = (x: number, y: number): [number, number] => {
    m.FPDF_PageToDevice(page, 0, 0, Math.round(W * K), Math.round(H * K), 0, x, y, dev, dev + 4)
    const v = new Int32Array(heap(m).buffer, dev, 2)
    return [v[0] / K, v[1] / K]
  }
  const out: PdfChar[] = []
  const fonts: PdfCharFont[] = []
  const fontIndex = new Map<number, number>()
  const colors = new Map<number, string>()
  try {
    const n = m.FPDFText_CountChars(tp)
    for (let i = 0; i < n; i++) {
      const code = m.FPDFText_GetUnicode(tp, i)
      if (!code || code === 0xfffe) continue
      const c = String.fromCodePoint(code)
      if (!m.FPDFText_GetLooseCharBox(tp, i, buf)) continue
      const [l, t, r, b] = f32(m, buf, 4)
      const [ax, ay] = toDevice(l, t)
      const [bx, by] = toDevice(r, b)
      let ox = (ax + bx) / 2
      let oy = Math.max(ay, by)
      if (m.FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) {
        const o = new Float64Array(heap(m).buffer, buf, 2)
        ;[ox, oy] = toDevice(o[0], o[1])
      }
      const obj = m.FPDFText_GetTextObject(tp, i)
      let f = -1
      let color = '#000000'
      if (obj) {
        const font = m.FPDFTextObj_GetFont(obj)
        if (font) {
          let k = fontIndex.get(font)
          if (k === undefined) {
            const len = m.FPDFFont_GetBaseFontName(font, buf, 256)
            const name = (len > 1 ? m.pdfium.UTF8ToString(buf) : '').replace(/^[A-Z]{6}\+/, '')
            const flen = m.FPDFFont_GetFamilyName(font, buf, 256)
            const family = flen > 1 ? m.pdfium.UTF8ToString(buf) : ''
            k = fonts.length
            fonts.push({
              name,
              family,
              bold: m.FPDFFont_GetWeight(font) >= 600 || /bold|black|heavy|semibold|demi/i.test(name),
              italic: (m.FPDFFont_GetFlags(font) & 0x40) !== 0 || /italic|oblique/i.test(name),
              embedded: m.FPDFFont_GetIsEmbedded(font) === 1,
              sample: i
            })
            fontIndex.set(font, k)
          }
          f = k
        }
        if (!colors.has(obj)) {
          let col = '#000000'
          if (m.FPDFPageObj_GetFillColor(obj, buf, buf + 4, buf + 8, buf + 12)) {
            const [cr, cg, cb] = new Uint32Array(heap(m).buffer, buf, 3)
            col = '#' + [cr, cg, cb].map((v) => v.toString(16).padStart(2, '0')).join('')
          }
          colors.set(obj, col)
        }
        color = colors.get(obj)!
      }
      out.push({ c, x: ox, y: oy, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), size: charSize(m, tp, i, buf), f, color, i })
    }
  } finally {
    m.pdfium.wasmExports.free(buf)
    m.pdfium.wasmExports.free(dev)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
  }
  return { chars: out, fonts }
}

/** Fichier de la police intégrée utilisée par un caractère (TrueType, OpenType ou CFF), ou null. */
async function fontData(id: string, index: number, charIndex: number): Promise<Uint8Array | null> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
  const tp = m.FPDFText_LoadPage(page)
  const lenPtr = m.pdfium.wasmExports.malloc(8)
  try {
    const obj = m.FPDFText_GetTextObject(tp, charIndex)
    const font = obj ? m.FPDFTextObj_GetFont(obj) : 0
    if (!font || m.FPDFFont_GetIsEmbedded(font) !== 1) return null
    if (!m.FPDFFont_GetFontData(font, 0, 0, lenPtr)) return null
    const len = new Uint32Array(heap(m).buffer, lenPtr, 1)[0]
    if (!len) return null
    const data = m.pdfium.wasmExports.malloc(len)
    try {
      if (!m.FPDFFont_GetFontData(font, data, len, lenPtr)) return null
      return heap(m).slice(data, data + len)
    } finally {
      m.pdfium.wasmExports.free(data)
    }
  } finally {
    m.pdfium.wasmExports.free(lenPtr)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
  }
}

/**
 * Contours des glyphes d'une police du PDF, pour reconstruire une police utilisable par
 * l'écran et l'export (les sous-ensembles intégrés aux PDF sont souvent refusés tels quels).
 * PDFium fait la correspondance Unicode → glyphe (y compris pour les polices CID).
 * `codepoints` : caractères vus dans la page (toujours repris) ; `strict` : caractères
 * supplémentaires, repris seulement s'ils existent vraiment dans le sous-ensemble.
 */
async function glyphs(id: string, index: number, charIndex: number, codepoints: number[], strict: number[]): Promise<PdfGlyphFont | null> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
  const tp = m.FPDFText_LoadPage(page)
  const buf = m.pdfium.wasmExports.malloc(16)
  const UPM = 1000
  try {
    const obj = m.FPDFText_GetTextObject(tp, charIndex)
    const font = obj ? m.FPDFTextObj_GetFont(obj) : 0
    if (!font) return null
    // Pas de fichier de police dans le PDF (Type 3 : lettres dessinées, comme Chrome les écrit ;
    // police standard non intégrée) : PDFium renverrait les contours d'une police de remplacement,
    // fins et étrangers à l'original. On préfère alors une police ressemblante.
    if (!m.FPDFFont_GetFontData(font, 0, 0, buf) || !new Uint32Array(heap(m).buffer, buf, 1)[0]) return null
    const read = (fn: (ptr: number) => boolean): number => (fn(buf) ? new Float32Array(heap(m).buffer, buf, 1)[0] : 0)
    const outline = (u: number): number[] | null => {
      const path = m.FPDFFont_GetGlyphPath(font, u, UPM)
      if (!path) return null
      const n = m.FPDFGlyphPath_CountGlyphSegments(path)
      const d: number[] = []
      const pending: number[] = []
      for (let k = 0; k < n; k++) {
        const seg = m.FPDFGlyphPath_GetGlyphPathSegment(path, k)
        if (!seg || !m.FPDFPathSegment_GetPoint(seg, buf, buf + 4)) continue
        // Les contours sont en em (1 = taille de la police) : on passe en millièmes.
        const [x, y] = Array.from(new Float32Array(heap(m).buffer, buf, 2), (v) => v * UPM)
        const type = m.FPDFPathSegment_GetType(seg)
        if (type === 2) d.push(0, x, y) // déplacement
        else if (type === 0) d.push(1, x, y) // ligne
        else {
          // Bézier cubique : trois segments consécutifs (deux points de contrôle, puis l'extrémité).
          pending.push(x, y)
          if (pending.length === 6) d.push(2, ...pending.splice(0, 6))
        }
        if (m.FPDFPathSegment_GetClose(seg)) d.push(3)
      }
      return d
    }
    // Signature du glyphe « absent » (.notdef) : un caractère de contrôle n'existe dans aucune police.
    const notdef = JSON.stringify(outline(1) ?? [])
    const out: PdfGlyphFont = { ascent: read((p) => m.FPDFFont_GetAscent(font, UPM, p)), descent: read((p) => m.FPDFFont_GetDescent(font, UPM, p)), glyphs: [] }
    const seen = new Set<number>()
    const add = (u: number, mustExist: boolean): void => {
      if (seen.has(u)) return
      seen.add(u)
      const w = read((p) => m.FPDFFont_GetGlyphWidth(font, u, UPM, p))
      // Espace et caractères invisibles : pas de contour, mais une largeur.
      // Un vrai caractère sans contour lisible (apostrophe d'une police Type 3…) n'est pas
      // ajouté vide : la police de secours le dessinera.
      const blank = u === 32 || u === 0xa0 || (u >= 0x2000 && u <= 0x200f) || u === 0x202f
      const d = outline(u) ?? (w > 0 && blank ? [] : null)
      if (d === null) return
      if (mustExist && (w <= 0 || (u !== 32 && u !== 0xa0 && (d.length === 0 || JSON.stringify(d) === notdef)))) return
      out.glyphs.push({ u, w, d })
    }
    for (const u of codepoints) add(u, false)
    for (const u of strict) add(u, true)
    return out
  } finally {
    m.pdfium.wasmExports.free(buf)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
  }
}

/** Copie du PDF où le texte modifié a été réellement supprimé (et non masqué). */
async function redacted(id: string, pages: { page: number; masks: PdfMask[]; shifts?: PdfShift[] }[]): Promise<Uint8Array> {
  const m = await pdfium()
  const src = getDoc(id)
  const buffer = m.pdfium.wasmExports.malloc(src.bytes.length)
  heap(m).set(src.bytes, buffer)
  const handle = m.FPDF_LoadMemDocument(buffer, src.bytes.length, '')
  const chunks: Uint8Array[] = []
  const writer = m.pdfium.addFunction((_self: number, data: number, size: number) => {
    chunks.push(heap(m).slice(data, data + size))
    return 1
  }, 'iiii')
  const fw = m.pdfium.wasmExports.malloc(8)
  try {
    for (const { page: index, masks, shifts } of pages) {
      const page = m.FPDF_LoadPage(handle, index)
      const removal = masks.length ? removeTextIn(m, page, src.pages[index], masks) : { removed: 0, leftovers: [] }
      const removed = removal.removed + (shifts?.length ? 1 : 0)
      const leftovers = shifts?.length ? shiftContent(m, page, src.pages[index], shifts, removal.leftovers) : removal.leftovers
      // Texte d'origine qu'on n'a pas pu retirer seul : recouvert d'un rectangle blanc.
      for (const [x0, y0, x1, y1] of leftovers) {
        const rect = m.FPDFPageObj_CreateNewRect(x0, y0, x1 - x0, y1 - y0)
        m.FPDFPageObj_SetFillColor(rect, 255, 255, 255, 255)
        m.FPDFPath_SetDrawMode(rect, 1, false)
        m.FPDFPage_InsertObject(page, rect)
      }
      if (removed || leftovers.length) m.FPDFPage_GenerateContent(page)
      m.FPDF_ClosePage(page)
    }
    new Int32Array(heap(m).buffer, fw, 2).set([1, writer])
    if (!m.FPDF_SaveAsCopy(handle, fw, 0)) throw new Error('Enregistrement PDF impossible')
    const total = chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  } finally {
    m.pdfium.removeFunction(writer)
    m.pdfium.wasmExports.free(fw)
    m.FPDF_CloseDocument(handle)
    m.pdfium.wasmExports.free(buffer)
  }
}

/** Mots de la page avec leur boîte, dans le repère affiché (rotation incluse). */
async function text(id: string, index: number): Promise<PdfWord[]> {
  const m = await pdfium()
  const doc = getDoc(id)
  const { width: W, height: H } = doc.pages[index]
  const page = m.FPDF_LoadPage(doc.handle, index)
  const tp = m.FPDFText_LoadPage(page)
  const rect = m.pdfium.wasmExports.malloc(16)
  const dev = m.pdfium.wasmExports.malloc(8)
  // PageToDevice travaille en entiers : on vise un « écran » 20× plus grand pour garder 0,05 pt de précision.
  const K = 20
  const toDevice = (x: number, y: number): [number, number] => {
    m.FPDF_PageToDevice(page, 0, 0, Math.round(W * K), Math.round(H * K), 0, x, y, dev, dev + 4)
    const v = new Int32Array(heap(m).buffer, dev, 2)
    return [v[0] / K, v[1] / K]
  }
  const words: PdfWord[] = []
  try {
    const n = m.FPDFText_CountChars(tp)
    let cur: PdfWord | null = null
    let line = 0
    let lastY = Number.NaN
    for (let i = 0; i < n; i++) {
      const code = m.FPDFText_GetUnicode(tp, i)
      const ch = String.fromCodePoint(code || 32)
      const isBreak = code === 10 || code === 13
      if (code === 32 || code === 9 || isBreak || code === 0) {
        if (cur) words.push(cur)
        cur = null
        if (isBreak) line++
        continue
      }
      if (!m.FPDFText_GetLooseCharBox(tp, i, rect)) continue
      const [l, t, r, b] = f32(m, rect, 4)
      const [ax, ay] = toDevice(l, t)
      const [bx, by] = toDevice(r, b)
      const box = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }
      const midY = (box.y0 + box.y1) / 2
      // Saut de ligne non signalé : la position verticale change nettement.
      if (!Number.isNaN(lastY) && Math.abs(midY - lastY) > (box.y1 - box.y0) * 0.7 && cur) {
        words.push(cur)
        cur = null
        line++
      }
      lastY = midY
      if (cur && box.x0 - cur.x1 > (box.y1 - box.y0) * 0.6) {
        words.push(cur)
        cur = null
      }
      if (!cur) cur = { text: ch, ...box, line }
      else {
        cur.text += ch
        cur.x0 = Math.min(cur.x0, box.x0)
        cur.y0 = Math.min(cur.y0, box.y0)
        cur.x1 = Math.max(cur.x1, box.x1)
        cur.y1 = Math.max(cur.y1, box.y1)
      }
    }
    if (cur) words.push(cur)
  } finally {
    m.pdfium.wasmExports.free(rect)
    m.pdfium.wasmExports.free(dev)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
  }
  return words
}

async function outline(id: string): Promise<PdfOutlineItem[]> {
  const m = await pdfium()
  const doc = getDoc(id)
  const titleBuf = m.pdfium.wasmExports.malloc(512)
  const walk = (parent: number, depth: number): PdfOutlineItem[] => {
    const items: PdfOutlineItem[] = []
    let node = m.FPDFBookmark_GetFirstChild(doc.handle, parent)
    let guard = 0
    while (node && guard++ < 5000) {
      const len = m.FPDFBookmark_GetTitle(node, titleBuf, 512)
      const title = len > 2 ? m.pdfium.UTF16ToString(titleBuf) : ''
      const dest = m.FPDFBookmark_GetDest(doc.handle, node)
      const page = dest ? m.FPDFDest_GetDestPageIndex(doc.handle, dest) : -1
      items.push({ title, page, children: depth < 8 ? walk(node, depth + 1) : [] })
      node = m.FPDFBookmark_GetNextSibling(doc.handle, node)
    }
    return items
  }
  try {
    return walk(0, 0)
  } finally {
    m.pdfium.wasmExports.free(titleBuf)
  }
}

/** Pièce jointe du PDF par nom (ex. le projet Feuillet embarqué dans un « PDF modifiable »). */
async function attachment(id: string, name: string): Promise<Uint8Array | null> {
  const m = await pdfium()
  const doc = getDoc(id)
  const count = m.FPDFDoc_GetAttachmentCount(doc.handle)
  const nameBuf = m.pdfium.wasmExports.malloc(1024)
  const lenPtr = m.pdfium.wasmExports.malloc(4)
  try {
    for (let i = 0; i < count; i++) {
      const att = m.FPDFDoc_GetAttachment(doc.handle, i)
      if (!att) continue
      m.FPDFAttachment_GetName(att, nameBuf, 1024)
      if (m.pdfium.UTF16ToString(nameBuf) !== name) continue
      if (!m.FPDFAttachment_GetFile(att, 0, 0, lenPtr)) return null
      const len = new Uint32Array(heap(m).buffer, lenPtr, 1)[0]
      const buf = m.pdfium.wasmExports.malloc(len)
      try {
        m.FPDFAttachment_GetFile(att, buf, len, lenPtr)
        return heap(m).slice(buf, buf + len)
      } finally {
        m.pdfium.wasmExports.free(buf)
      }
    }
    return null
  } finally {
    m.pdfium.wasmExports.free(nameBuf)
    m.pdfium.wasmExports.free(lenPtr)
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; req: PdfRequest }>) => {
  const { id, req } = e.data
  const reply = (res: PdfResponse, transfer: Transferable[] = []): void => self.postMessage({ id, res }, { transfer })
  try {
    switch (req.op) {
      case 'open': {
        const { pages, decrypted } = await open(req.doc, req.data, req.password)
        return reply({ ok: true, pages, decrypted }, decrypted ? [decrypted.buffer] : [])
      }
      case 'close':
        await close(req.doc)
        return reply({ ok: true })
      case 'render': {
        const bitmap = await render(req.doc, req.page, req.width, req.height, req.masks, req.shifts)
        return reply({ ok: true, bitmap }, [bitmap])
      }
      case 'text':
        return reply({ ok: true, words: await text(req.doc, req.page) })
      case 'outline':
        return reply({ ok: true, outline: await outline(req.doc) })
      case 'fontinfo':
        return reply({ ok: true, font: await fontInfo(req.doc, req.page, req.x, req.y) })
      case 'redacted': {
        const file = await redacted(req.doc, req.pages)
        return reply({ ok: true, file }, [file.buffer])
      }
      case 'chars': {
        const r = await chars(req.doc, req.page)
        return reply({ ok: true, chars: r.chars, fonts: r.fonts })
      }
      case 'glyphs':
        return reply({ ok: true, glyphFont: await glyphs(req.doc, req.page, req.char, req.codepoints, req.strict) })
      case 'fontdata': {
        const file = await fontData(req.doc, req.page, req.char)
        return reply({ ok: true, file }, file ? [file.buffer] : [])
      }
      case 'attachment': {
        const file = await attachment(req.doc, req.name)
        return reply({ ok: true, file }, file ? [file.buffer] : [])
      }
    }
  } catch (err) {
    reply({ ok: false, error: (err as Error).message || String(err) })
  }
}
