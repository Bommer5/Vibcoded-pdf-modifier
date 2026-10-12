/// <reference lib="webworker" />
/**
 * Moteur PDF natif : PDFium (C++, moteur de Chrome) compilé en WebAssembly,
 * exécuté hors du fil de l'interface. Rendu, texte (boîtes de caractères) et sommaire.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import type { PdfOutlineItem, PdfPageInfo, PdfRequest, PdfResponse, PdfWord } from './protocol'

const FPDF_ANNOT = 0x01
const FPDF_REVERSE_BYTE_ORDER = 0x10 // sortie RGBA au lieu de BGRA
const FPDFBitmap_BGRA = 4

interface Doc {
  handle: number
  buffer: number
  pages: PdfPageInfo[]
}

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

async function open(id: string, data: Uint8Array): Promise<PdfPageInfo[]> {
  const m = await pdfium()
  const buffer = m.pdfium.wasmExports.malloc(data.length)
  heap(m).set(data, buffer)
  const handle = m.FPDF_LoadMemDocument(buffer, data.length, '')
  if (!handle) {
    m.pdfium.wasmExports.free(buffer)
    throw new Error(m.FPDF_GetLastError() === 4 ? 'PDF protégé par mot de passe' : 'PDF illisible ou endommagé')
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
  docs.set(id, { handle, buffer, pages })
  return pages
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

async function render(id: string, index: number, width: number, height: number): Promise<ImageBitmap> {
  const m = await pdfium()
  const doc = getDoc(id)
  const page = m.FPDF_LoadPage(doc.handle, index)
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

self.onmessage = async (e: MessageEvent<{ id: number; req: PdfRequest }>) => {
  const { id, req } = e.data
  const reply = (res: PdfResponse, transfer: Transferable[] = []): void => self.postMessage({ id, res }, { transfer })
  try {
    switch (req.op) {
      case 'open':
        return reply({ ok: true, pages: await open(req.doc, req.data) })
      case 'close':
        await close(req.doc)
        return reply({ ok: true })
      case 'render': {
        const bitmap = await render(req.doc, req.page, req.width, req.height)
        return reply({ ok: true, bitmap }, [bitmap])
      }
      case 'text':
        return reply({ ok: true, words: await text(req.doc, req.page) })
      case 'outline':
        return reply({ ok: true, outline: await outline(req.doc) })
    }
  } catch (err) {
    reply({ ok: false, error: (err as Error).message || String(err) })
  }
}
