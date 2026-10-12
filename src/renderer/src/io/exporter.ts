import { StaticCanvas, type FabricObject } from 'fabric'
import type { PDFDocument, PDFEmbeddedPage, PDFImage, PDFPage } from 'pdf-lib'
import { assets, toDataUrl } from '../core/assets'
import type { Page } from '../core/document'
import type { Editor } from '../core/editor'
import { pageRenderer } from '../core/page-renderer'
import { paperSvg } from '../core/paper'
import { platform, type FileFilter } from '../platform'
import { canvasToBlob } from '../util/blob'
import { saveProject } from './project'

// Bibliothèques lourdes chargées seulement au moment d'exporter (démarrage plus rapide, moins de mémoire).
const lib = {
  pdf: () => import('pdf-lib'),
  jspdf: () => import('jspdf'),
  svg2pdf: () => import('svg2pdf.js'),
  docx: () => import('docx'),
  utif: () => import('utif2')
}

export interface ExportFormat {
  id: string
  label: string
  ext: string
  mime: string
  /** Un fichier par page (formats d'image). */
  perPage?: boolean
  raster?: boolean
  /** Nécessite LibreOffice. */
  office?: boolean
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  { id: 'feuillet', label: 'Projet Feuillet (tout reste modifiable)', ext: 'feuillet', mime: 'application/zip' },
  { id: 'png', label: 'Image PNG', ext: 'png', mime: 'image/png', perPage: true, raster: true },
  { id: 'jpg', label: 'Image JPEG', ext: 'jpg', mime: 'image/jpeg', perPage: true, raster: true },
  { id: 'webp', label: 'Image WebP', ext: 'webp', mime: 'image/webp', perPage: true, raster: true },
  { id: 'tiff', label: 'Image TIFF', ext: 'tiff', mime: 'image/tiff', perPage: true, raster: true },
  { id: 'svg', label: 'SVG (vectoriel)', ext: 'svg', mime: 'image/svg+xml', perPage: true },
  { id: 'docx', label: 'Word .docx (mise en page identique)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', raster: true },
  { id: 'docx-text', label: 'Word .docx (texte modifiable)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', office: true },
  { id: 'odt', label: 'OpenDocument .odt (texte modifiable)', ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', office: true },
  { id: 'odg', label: 'OpenDocument Dessin .odg', ext: 'odg', mime: 'application/vnd.oasis.opendocument.graphics', office: true },
  { id: 'rtf', label: 'RTF', ext: 'rtf', mime: 'application/rtf', office: true },
  { id: 'doc', label: 'Word 97-2003 .doc', ext: 'doc', mime: 'application/msword', office: true }
]

export interface ExportOptions {
  format: ExportFormat
  pages: Page[]
  /** Résolution des formats image (points par pouce). */
  dpi: number
  name: string
}

/** Rotation /Rotate et zone visible d'une page PDF d'origine. */
interface PdfPlacement {
  rotation: number
  x: number
  y: number
  width: number
  height: number
}

export class Exporter {
  private pdfCache = new Map<string, Promise<PDFDocument>>()

  constructor(private ed: Editor) {}

  async run(opts: ExportOptions): Promise<string[] | null> {
    const { format } = opts
    const parts = await this.render(opts)
    const filter: FileFilter = { name: format.label, extensions: [format.ext] }
    return platform.saveFiles(`${opts.name}.${format.ext}`, filter, format.mime, parts)
  }

  /** Produit les octets du ou des fichiers, sans les enregistrer. */
  async render({ format, pages, dpi, name }: ExportOptions): Promise<Uint8Array[]> {
    this.pdfCache.clear()
    switch (format.id) {
      case 'pdf':
        return [await this.pdf(pages)]
      case 'feuillet':
        return [await saveProject(this.ed.canvas)]
      case 'svg':
        return Promise.all(pages.map(async (p) => new TextEncoder().encode(await this.svg(p, 'all'))))
      case 'png':
      case 'jpg':
      case 'webp':
        return Promise.all(
          pages.map(async (p) => {
            const canvas = await this.raster(p, dpi)
            const blob = await canvasToBlob(canvas, format.mime, format.id === 'png' ? undefined : 0.92)
            return new Uint8Array(await blob.arrayBuffer())
          })
        )
      case 'tiff': {
        const UTIF = await lib.utif()
        return Promise.all(
          pages.map(async (p) => {
            const canvas = await this.raster(p, dpi)
            const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
            return new Uint8Array(UTIF.encodeImage(rgba.buffer as ArrayBuffer, canvas.width, canvas.height))
          })
        )
      }
      case 'docx':
        return [await this.docx(pages, dpi)]
      default: {
        // Formats bureautiques modifiables : PDF → import PDF de LibreOffice → format cible.
        if (!(await platform.officeAvailable())) throw new Error('Ce format nécessite LibreOffice (gratuit) : https://www.libreoffice.org')
        const pdf = await this.pdf(pages)
        const target = format.id === 'docx-text' ? 'docx' : format.ext
        return [await platform.officeConvert(`${name}.pdf`, pdf, target)]
      }
    }
  }

  // --- Scène d'une page -------------------------------------------------------

  /** Objets de contenu dessinés sur une page, clonés. */
  private async sceneObjects(page: Page): Promise<FabricObject[]> {
    return Promise.all(this.ed.doc.contentOn(page).map((o) => o.clone()))
  }

  async raster(page: Page, dpi: number, withBackground = true, transparent = false): Promise<HTMLCanvasElement> {
    const s = dpi / 72
    const out = document.createElement('canvas')
    out.width = Math.round(page.width * s)
    out.height = Math.round(page.height * s)
    const ctx = out.getContext('2d')!
    if (withBackground) await pageRenderer.paint(ctx, page, s)
    else if (!transparent) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
    }
    const sc = new StaticCanvas(undefined, { width: out.width, height: out.height, enableRetinaScaling: false, renderOnAddRemove: false })
    sc.add(...(await this.sceneObjects(page)))
    sc.setViewportTransform([s, 0, 0, s, -page.left * s, -page.top * s])
    sc.renderAll()
    ctx.drawImage(sc.getElement(), 0, 0)
    await sc.dispose()
    return out
  }

  /**
   * SVG autonome d'une page (images en data URL).
   * Fond : 'all' (tout), 'vector' (papier seulement, le reste est posé à part), 'none'.
   */
  async svg(page: Page, background: 'all' | 'vector' | 'none'): Promise<string> {
    const sc = new StaticCanvas(undefined, { width: page.width, height: page.height, enableRetinaScaling: false, renderOnAddRemove: false })
    sc.add(...(await this.sceneObjects(page)))
    sc.setViewportTransform([1, 0, 0, 1, -page.left, -page.top])
    let markup = sc.toSVG({ width: `${page.width}pt`, height: `${page.height}pt` })
    await sc.dispose()
    for (const asset of assets.all()) {
      if (asset.mime.startsWith('image/') && markup.includes(asset.url)) markup = markup.split(asset.url).join(toDataUrl(asset))
    }
    const bg = await this.backgroundSvg(page, background)
    if (bg) {
      const at = markup.indexOf('</defs>')
      const insertAt = at >= 0 ? at + 7 : markup.indexOf('>', markup.indexOf('<svg')) + 1
      markup = markup.slice(0, insertAt) + `<g transform="translate(${page.left} ${page.top})">${bg}</g>` + markup.slice(insertAt)
    }
    return markup
  }

  private async backgroundSvg(page: Page, mode: 'all' | 'vector' | 'none'): Promise<string> {
    if (mode === 'none') return ''
    const bg = page.bg
    if (bg.kind === 'paper') return paperSvg(page, bg.style, bg.color)
    if (mode === 'vector' || bg.kind === 'blank') return mode === 'all' ? `<rect width="${page.width}" height="${page.height}" fill="#ffffff"/>` : ''
    // Fond rendu en image (2× = 144 ppp) pour un SVG autonome.
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(page.width * 2)
    canvas.height = Math.round(page.height * 2)
    await pageRenderer.paint(canvas.getContext('2d')!, page, 2)
    const url = canvas.toDataURL('image/jpeg', 0.9)
    return `<image x="0" y="0" width="${page.width}" height="${page.height}" preserveAspectRatio="none" href="${url}"/>`
  }

  // --- PDF --------------------------------------------------------------------

  /**
   * PDF fidèle : les pages issues d'un PDF sont reprises telles quelles (texte
   * sélectionnable, vectoriel, polices d'origine) et les ajouts sont superposés
   * en vectoriel (svg2pdf). Repli en image haute définition si besoin.
   */
  async pdf(pages: Page[]): Promise<Uint8Array> {
    const { PDFDocument } = await lib.pdf()
    const out = await PDFDocument.create()
    out.setProducer('Feuillet')
    out.setCreator('Feuillet')

    for (const page of pages) {
      const bg = page.bg
      const hasContent = this.ed.doc.contentOn(page).length > 0
      const source = bg.kind === 'pdf' ? assets.get(bg.assetId) : undefined

      if (bg.kind === 'pdf' && source) {
        const src = await this.loadPdfLib(source.id, source.bytes)
        const [copied] = await out.copyPages(src, [bg.index])
        out.addPage(copied)
        if (hasContent) await this.overlay(out, copied, page, placementOf(copied), 'none')
        continue
      }
      const target = out.addPage([page.width, page.height])
      if (bg.kind === 'image') {
        // Image d'origine intégrée telle quelle (pas de recompression).
        const image = await this.embedImage(out, bg.assetId)
        if (image) target.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height })
      }
      if (hasContent || bg.kind === 'paper') {
        await this.overlay(out, target, page, { rotation: 0, x: 0, y: 0, width: page.width, height: page.height }, 'vector')
      }
    }
    return out.save()
  }

  private loadPdfLib(id: string, bytes: Uint8Array): Promise<PDFDocument> {
    let doc = this.pdfCache.get(id)
    if (!doc) {
      doc = lib.pdf().then(({ PDFDocument }) => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }))
      this.pdfCache.set(id, doc)
    }
    return doc
  }

  private async embedImage(out: PDFDocument, assetId: string): Promise<PDFImage | null> {
    const asset = assets.get(assetId)
    if (!asset) return null
    if (asset.mime === 'image/jpeg') return out.embedJpg(asset.bytes)
    if (asset.mime === 'image/png') return out.embedPng(asset.bytes)
    const bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    return out.embedPng(new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer()))
  }

  private async overlay(out: PDFDocument, target: PDFPage, page: Page, at: PdfPlacement, background: 'vector' | 'none'): Promise<void> {
    let embedded: PDFEmbeddedPage | PDFImage
    const { degrees, PDFImage } = await lib.pdf()
    try {
      const { jsPDF } = await lib.jspdf()
      const { svg2pdf } = await lib.svg2pdf()
      const svgText = pdfFonts(await this.svg(page, background))
      const svgEl = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement
      const pdf = new jsPDF({ unit: 'pt', format: [page.width, page.height], orientation: page.width > page.height ? 'l' : 'p', compress: true, putOnlyUsedFonts: true })
      await svg2pdf(svgEl, pdf, { x: 0, y: 0, width: page.width, height: page.height })
      const [first] = await out.embedPdf(new Uint8Array(pdf.output('arraybuffer')))
      embedded = first
    } catch (e) {
      console.warn('Export vectoriel impossible, repli en image 300 ppp', e)
      const canvas = await this.raster(page, 300, false, true)
      embedded = await out.embedPng(new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer()))
    }
    draw(target, embedded, at, degrees, PDFImage)
  }

  // --- Word -------------------------------------------------------------------

  private async docx(pages: Page[], dpi: number): Promise<Uint8Array> {
    const { Document: DocxDocument, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, VerticalPositionRelativeFrom } = await lib.docx()
    const sections = await Promise.all(
      pages.map(async (page) => {
        const canvas = await this.raster(page, dpi)
        const png = new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer())
        return {
          properties: {
            page: {
              size: { width: Math.round(page.width * 20), height: Math.round(page.height * 20) },
              margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 }
            }
          },
          children: [
            new Paragraph({
              children: [
                new ImageRun({
                  type: 'png',
                  data: png,
                  transformation: { width: (page.width * 96) / 72, height: (page.height * 96) / 72 },
                  floating: {
                    horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
                    verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
                    behindDocument: true
                  }
                })
              ]
            })
          ]
        }
      })
    )
    const blob = await Packer.toBlob(new DocxDocument({ creator: 'Feuillet', sections }))
    return new Uint8Array(await blob.arrayBuffer())
  }
}

/**
 * Les polices standard du PDF (Helvetica, Times, Courier) couvrent le français.
 * On ramène chaque police à la famille standard la plus proche.
 * TODO : intégrer les polices TrueType pour l'Unicode complet (voir docs/RESEARCH.md).
 */
function pdfFonts(svg: string): string {
  return svg.replace(/font-family="([^"]*)"/g, (_m, family: string) => {
    const f = family.toLowerCase()
    const std = /mono|courier|consol|menlo/.test(f)
      ? 'courier'
      : /times|georgia|garamond|cambria|book|(^|[^-])serif/.test(f) && !/sans/.test(f)
        ? 'times'
        : 'helvetica'
    return `font-family="${std}"`
  })
}

function placementOf(page: PDFPage): PdfPlacement {
  const box = page.getCropBox()
  return { rotation: ((page.getRotation().angle % 360) + 360) % 360, ...box }
}

/**
 * Dessine la surcouche (en coordonnées « page affichée ») sur une page PDF
 * dont le contenu est éventuellement tourné par /Rotate.
 */
function draw(
  target: PDFPage,
  what: PDFEmbeddedPage | PDFImage,
  at: PdfPlacement,
  degrees: typeof import('pdf-lib').degrees,
  PDFImageClass: typeof import('pdf-lib').PDFImage
): void {
  const { rotation: r, x, y, width: W, height: H } = at
  const displayed = r % 180 === 0 ? { width: W, height: H } : { width: H, height: W }
  const origin = r === 90 ? { x: x + W, y } : r === 180 ? { x: x + W, y: y + H } : r === 270 ? { x, y: y + H } : { x, y }
  const opts = { ...origin, ...displayed, rotate: degrees(r) }
  if (what instanceof PDFImageClass) target.drawImage(what, opts)
  else target.drawPage(what, opts)
}
