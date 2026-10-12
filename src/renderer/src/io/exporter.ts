import { Document as DocxDocument, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, VerticalPositionRelativeFrom } from 'docx'
import { StaticCanvas, type FabricObject } from 'fabric'
import { jsPDF } from 'jspdf'
import { degrees, PDFDocument, PDFImage, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib'
import { svg2pdf } from 'svg2pdf.js'
import * as UTIF from 'utif2'
import { assets, toDataUrl } from '../core/assets'
import type { Page } from '../core/document'
import type { Editor } from '../core/editor'
import type { Obj } from '../core/props'
import { platform, type FileFilter } from '../platform'
import { canvasToBlob } from './pdf'
import { saveProject } from './project'

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
        return Promise.all(pages.map(async (p) => new TextEncoder().encode(await this.svg(p, true))))
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
      case 'tiff':
        return Promise.all(
          pages.map(async (p) => {
            const canvas = await this.raster(p, dpi)
            const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
            return new Uint8Array(UTIF.encodeImage(rgba.buffer as ArrayBuffer, canvas.width, canvas.height))
          })
        )
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

  /** Objets à dessiner sur une page, clonés. Les fonds PDF sont exclus si `withBackground` est faux. */
  private async sceneObjects(page: Page, withBackground: boolean): Promise<FabricObject[]> {
    const { doc } = this.ed
    const objs = [...(withBackground ? [doc.background(page)].filter((o): o is FabricObject => !!o) : []), ...doc.contentOn(page)]
    return Promise.all(objs.map((o) => o.clone()))
  }

  async raster(page: Page, dpi: number, withBackground = true, transparent = false): Promise<HTMLCanvasElement> {
    const s = dpi / 72
    const sc = new StaticCanvas(undefined, {
      width: Math.round(page.width * s),
      height: Math.round(page.height * s),
      enableRetinaScaling: false,
      backgroundColor: transparent ? undefined : '#ffffff',
      renderOnAddRemove: false
    })
    sc.add(...(await this.sceneObjects(page, withBackground)))
    sc.setViewportTransform([s, 0, 0, s, -page.left * s, -page.top * s])
    sc.renderAll()
    const out = document.createElement('canvas')
    out.width = sc.width
    out.height = sc.height
    out.getContext('2d')!.drawImage(sc.getElement(), 0, 0)
    await sc.dispose()
    return out
  }

  /** SVG autonome d'une page (images incluses en data URL). */
  async svg(page: Page, withBackground: boolean): Promise<string> {
    const sc = new StaticCanvas(undefined, {
      width: page.width,
      height: page.height,
      enableRetinaScaling: false,
      backgroundColor: withBackground ? '#ffffff' : undefined,
      renderOnAddRemove: false
    })
    sc.add(...(await this.sceneObjects(page, withBackground)))
    sc.setViewportTransform([1, 0, 0, 1, -page.left, -page.top])
    let markup = sc.toSVG({ width: `${page.width}pt`, height: `${page.height}pt` })
    await sc.dispose()
    for (const asset of assets.all()) {
      if (asset.mime.startsWith('image/') && markup.includes(asset.url)) markup = markup.split(asset.url).join(toDataUrl(asset))
    }
    return markup
  }

  // --- PDF --------------------------------------------------------------------

  /**
   * PDF fidèle : les pages issues d'un PDF sont reprises telles quelles (texte
   * sélectionnable, vectoriel, polices d'origine) et les ajouts sont superposés
   * en vectoriel (svg2pdf). Repli en image haute définition si besoin.
   */
  async pdf(pages: Page[]): Promise<Uint8Array> {
    const out = await PDFDocument.create()
    out.setProducer('Feuillet')
    out.setCreator('Feuillet')

    for (const page of pages) {
      const p = page as Obj & Page
      const source = p.pdfAssetId ? assets.get(p.pdfAssetId) : undefined
      const hasContent = this.ed.doc.contentOn(page).length > 0

      if (source && p.pdfPageIndex !== undefined) {
        const src = await this.loadPdfLib(source.id, source.bytes)
        const [copied] = await out.copyPages(src, [p.pdfPageIndex])
        out.addPage(copied)
        if (hasContent) await this.overlay(out, copied, page, placementOf(copied))
      } else {
        const target = out.addPage([page.width, page.height])
        await this.overlay(out, target, page, { rotation: 0, x: 0, y: 0, width: page.width, height: page.height }, true)
      }
    }
    return out.save()
  }

  private loadPdfLib(id: string, bytes: Uint8Array): Promise<PDFDocument> {
    let doc = this.pdfCache.get(id)
    if (!doc) {
      doc = PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
      this.pdfCache.set(id, doc)
    }
    return doc
  }

  private async overlay(out: PDFDocument, target: PDFPage, page: Page, at: PdfPlacement, withBackground = false): Promise<void> {
    let embedded: PDFEmbeddedPage | PDFImage
    try {
      const svgText = pdfFonts(await this.svg(page, withBackground))
      const svgEl = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement
      const pdf = new jsPDF({ unit: 'pt', format: [page.width, page.height], orientation: page.width > page.height ? 'l' : 'p', compress: true, putOnlyUsedFonts: true })
      await svg2pdf(svgEl, pdf, { x: 0, y: 0, width: page.width, height: page.height })
      const [first] = await out.embedPdf(new Uint8Array(pdf.output('arraybuffer')))
      embedded = first
    } catch (e) {
      console.warn('Export vectoriel impossible, repli en image 300 ppp', e)
      const canvas = await this.raster(page, 300, withBackground, !withBackground)
      embedded = await out.embedPng(new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer()))
    }
    draw(target, embedded, at)
  }

  // --- Word -------------------------------------------------------------------

  private async docx(pages: Page[], dpi: number): Promise<Uint8Array> {
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
function draw(target: PDFPage, what: PDFEmbeddedPage | PDFImage, at: PdfPlacement): void {
  const { rotation: r, x, y, width: W, height: H } = at
  const displayed = r % 180 === 0 ? { width: W, height: H } : { width: H, height: W }
  const origin = r === 90 ? { x: x + W, y } : r === 180 ? { x: x + W, y: y + H } : r === 270 ? { x, y: y + H } : { x, y }
  const opts = { ...origin, ...displayed, rotate: degrees(r) }
  if (what instanceof PDFImage) target.drawImage(what, opts)
  else target.drawPage(what, opts)
}
