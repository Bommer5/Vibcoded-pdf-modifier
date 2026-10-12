/// <reference lib="webworker" />
/**
 * Moteur PDF natif : PDFium (C++, moteur de Chrome) compilé en WebAssembly,
 * exécuté hors du fil de l'interface. Rendu, texte (boîtes de caractères) et sommaire.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import type { PdfFontInfo, PdfMask, PdfOutlineItem, PdfPageInfo, PdfRequest, PdfResponse, PdfWord } from './protocol'

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

async function render(id: string, index: number, width: number, height: number, masks?: PdfMask[]): Promise<ImageBitmap> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
  // Le texte modifié est retiré de la page chargée (en mémoire seulement) avant le rendu.
  if (masks?.length) removeTextIn(m, page, doc.pages[index], masks)
  const bmp = m.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, 0, 0)
  try {
    m.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff)
    m.FPDF_RenderPageBitmap(bmp, page, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER)
    const ptr = m.FPDFBitmap_GetBuffer(bmp)
    const stride = m.FPDFBitmap_GetStride(bmp)
    const src = heap(m)
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) pixels.set(src.subarray(ptr + y * stride, ptr + y * stride + width * 4), y * width * 4)
    return await createImageBitmap(new ImageData(pixels, width, height))
  } finally {
    m.FPDFBitmap_Destroy(bmp)
    m.FPDF_ClosePage(page)
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
function removeTextIn(m: WrappedPdfiumModule, page: number, info: PdfPageInfo, masks: PdfMask[]): number {
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
  return removed
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
    const fontSize = m.FPDFText_GetFontSize(tp, ci)
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

/** Copie du PDF où le texte modifié a été réellement supprimé (et non masqué). */
async function redacted(id: string, pages: { page: number; masks: PdfMask[] }[]): Promise<Uint8Array> {
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
    for (const { page: index, masks } of pages) {
      const page = m.FPDF_LoadPage(handle, index)
      if (removeTextIn(m, page, src.pages[index], masks)) m.FPDFPage_GenerateContent(page)
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
        const bitmap = await render(req.doc, req.page, req.width, req.height, req.masks)
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
      case 'attachment': {
        const file = await attachment(req.doc, req.name)
        return reply({ ok: true, file }, file ? [file.buffer] : [])
      }
    }
  } catch (err) {
    reply({ ok: false, error: (err as Error).message || String(err) })
  }
}
