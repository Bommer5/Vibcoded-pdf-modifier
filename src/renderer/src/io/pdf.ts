import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

// Ressources pdf.js copiées localement (scripts/copy-pdfjs-assets.mjs) : aucun accès réseau.
const base = new URL('./pdfjs/', document.baseURI).href

/** Résolution d'affichage des pages PDF (2 = 144 ppp, net jusqu'à ~200 % de zoom). */
export const PDF_RENDER_SCALE = 2

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    data: bytes.slice(), // pdf.js transfère le tampon au worker : on garde l'original intact
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    enableXfa: true
  }).promise
}

/** Taille de page en points, rotation /Rotate incluse. */
export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const vp = page.getViewport({ scale: 1 })
  return { width: vp.width, height: vp.height }
}

/** Rend une page en image WebP (annotations et champs de formulaire inclus). */
export async function renderPage(page: PDFPageProxy, scale = PDF_RENDER_SCALE): Promise<Blob> {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise
  return canvasToBlob(canvas, 'image/webp', 0.95)
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage image impossible'))), type, quality)
  )
}
