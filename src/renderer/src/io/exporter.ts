import { StaticCanvas, util, type FabricObject } from 'fabric'
import type { PDFDocument, PDFEmbeddedPage, PDFImage, PDFPage } from 'pdf-lib'
import { assets, toDataUrl } from '../core/assets'
import type { Page } from '../core/document'
import type { Editor } from '../core/editor'
import { pageRenderer } from '../core/page-renderer'
import { paperSvg } from '../core/paper'
import { pdfEngine } from '../pdf/engine'
import { Table } from '../objects/table'
import { drawTextObject, hasRealText, PdfFonts } from './pdf-text'
import { ensureFonts } from '../core/fonts'
import { platform, type FileFilter } from '../platform'
import { canvasToBlob } from '../util/blob'
import { saveProject } from './project'
import { EMBEDDED_PROJECT } from './importer'
import { ANNOT_TAG } from './hybrid'

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
  { id: 'pdf-editable', label: 'PDF modifiable dans Feuillet (lisible partout)', ext: 'pdf', mime: 'application/pdf' },
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
      case 'pdf-editable':
        // Toujours le document complet : sinon les pages non exportées seraient perdues à la réouverture.
        return [await this.pdf(this.ed.doc.pages, { embedProject: true })]
      case 'feuillet':
        return [await saveProject(this.ed.canvas, { layers: this.ed.layers?.list })]
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
  async svg(page: Page, background: 'all' | 'vector' | 'none', objects?: FabricObject[], tableTextApart = false): Promise<string> {
    const sc = new StaticCanvas(undefined, { width: page.width, height: page.height, enableRetinaScaling: false, renderOnAddRemove: false })
    const clones = objects ? await Promise.all(objects.map((o) => o.clone())) : await this.sceneObjects(page)
    // Dans les PDF, le texte des tableaux est écrit à part avec de vraies polices.
    if (tableTextApart) for (const c of clones) if (c instanceof Table) c.svgWithoutText = true
    sc.add(...clones)
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
  async pdf(pages: Page[], opts: { embedProject?: boolean } = {}): Promise<Uint8Array> {
    // Mise en page calculée avec les polices définitives (celles intégrées au PDF).
    await ensureFonts(this.ed.doc.content as never)
    const { PDFDocument } = await lib.pdf()
    const pdfLib = await lib.pdf()
    const outerIndex = new Map<string, number>()
    const out = await PDFDocument.create()
    out.registerFontkit((await import('@pdf-lib/fontkit')).default)
    const fonts = new PdfFonts(out)
    out.setProducer('Feuillet')
    out.setCreator('Feuillet')

    // Texte d'origine modifié : on part d'une copie du PDF où ce texte est réellement supprimé.
    const masked = new Map<string, { page: number; masks: [number, number, number, number][]; shifts?: import('../pdf/protocol').PdfShift[] }[]>()
    for (const page of pages) {
      const shifts = page.shifts?.filter((s) => s.dy) ?? []
      if (page.bg.kind !== 'pdf' || (!page.masks?.length && !shifts.length)) continue
      masked.set(page.bg.assetId, [...(masked.get(page.bg.assetId) ?? []), { page: page.bg.index, masks: page.masks ?? [], shifts }])
    }
    const sources = new Map<string, Uint8Array>()
    for (const [assetId, list] of masked) {
      await pdfEngine.open(assetId, assets.get(assetId)!.bytes)
      sources.set(assetId, await pdfEngine.redacted(assetId, list))
    }

    for (const page of pages) {
      const bg = page.bg
      const hasContent = this.ed.doc.contentOn(page).length > 0
      const source = bg.kind === 'pdf' ? assets.get(bg.assetId) : undefined

      if (bg.kind === 'pdf' && source) {
        const bytes = sources.get(source.id)
        const src = await this.loadPdfLib(bytes ? `${source.id}#redacted` : source.id, bytes ?? source.bytes)
        const [copied] = await out.copyPages(src, [bg.index])
        out.addPage(copied)
        outerIndex.set(page.pageId, out.getPageCount() - 1)
        if (hasContent) {
          // Ajouts dans un flux séparé et marqué : retirable à la réouverture (PDF modifiable).
          copied.pushOperators(pdfLib.beginMarkedContent(ANNOT_TAG))
          await this.overlay(out, copied, page, placementOf(copied), 'none', fonts)
          copied.pushOperators(pdfLib.endMarkedContent())
        }
        continue
      }
      const target = out.addPage([page.width, page.height])
      if (bg.kind === 'image') {
        // Image d'origine intégrée telle quelle (pas de recompression).
        const image = await this.embedImage(out, bg.assetId)
        if (image) target.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height })
      }
      if (hasContent || bg.kind === 'paper') {
        await this.overlay(out, target, page, { rotation: 0, x: 0, y: 0, width: page.width, height: page.height }, 'vector', fonts)
      }
    }
    if (opts.embedProject) {
      // Le projet complet est joint au PDF : n'importe quel lecteur affiche le résultat,
      // Feuillet rouvre tout (calques, traits, textes) entièrement modifiable.
      // Le PDF d'origine n'est pas joint : il est dans ce fichier même (voir hybrid.ts).
      const sources = new Set(pages.flatMap((p) => (p.bg.kind === 'pdf' ? [p.bg.assetId] : [])))
      // Un PDF aussi utilisé comme image (page insérée) doit rester joint au projet.
      for (const o of this.ed.doc.content) {
        const ref = (o as { pdfPage?: { assetId: string } }).pdfPage
        if (ref) sources.delete(ref.assetId)
      }
      const project = await saveProject(
        this.ed.canvas,
        { layers: this.ed.layers?.list, selfSource: Object.fromEntries(outerIndex) },
        { exclude: sources }
      )
      await out.attach(project, EMBEDDED_PROJECT, {
        mimeType: 'application/zip',
        description: 'Projet Feuillet : ouvrez ce PDF dans Feuillet pour tout modifier'
      })
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

  /**
   * Ajouts d'une page dessinés dans le PDF, dans l'ordre d'empilement :
   * - formes, traits, images : en vectoriel (svg2pdf), par paquets consécutifs ;
   * - textes et tableaux : avec de vraies polices intégrées (texte sélectionnable, Unicode).
   */
  private async overlay(out: PDFDocument, target: PDFPage, page: Page, at: PdfPlacement, background: 'vector' | 'none', fonts: PdfFonts): Promise<void> {
    const pdfLib = await lib.pdf()
    const objects = this.ed.doc.contentOn(page)
    const display = displayMatrix(at)
    // Paquets : [formes…], texte, [formes…], texte…  (le fond papier va avec le premier paquet)
    const chunks: { text?: FabricObject; shapes?: FabricObject[]; pdfPage?: FabricObject }[] = []
    for (const o of objects) {
      // Page de PDF insérée comme image : réintégrée telle quelle, en vectoriel.
      if ((o as { pdfPage?: unknown }).pdfPage) chunks.push({ pdfPage: o })
      else if (hasRealText(o) && !(o as { markup?: unknown }).markup) {
        // Le cadre d'un tableau reste vectoriel ; seul son texte est écrit avec les polices.
        if (o instanceof Table) chunks.push({ shapes: [o] })
        chunks.push({ text: o })
      } else if (chunks.at(-1)?.shapes) chunks.at(-1)!.shapes!.push(o)
      else chunks.push({ shapes: [o] })
    }
    if (!chunks.length || !chunks[0].shapes) chunks.unshift({ shapes: [] })
    let first = true
    for (const chunk of chunks) {
      if (chunk.shapes) {
        const bg = first ? background : 'none'
        first = false
        if (!chunk.shapes.length && bg === 'none') continue
        await this.drawShapes(out, target, page, at, bg, chunk.shapes, pdfLib)
      } else if (chunk.pdfPage) {
        const ok = await this.drawPdfPage(out, target, page, chunk.pdfPage, display, pdfLib).catch((e) => {
          console.warn('Page PDF vectorielle impossible', e)
          return false
        })
        if (!ok) await this.drawShapes(out, target, page, at, 'none', [chunk.pdfPage], pdfLib, true)
      } else if (chunk.text) {
        const ok = await drawTextObject(pdfLib, fonts, target, chunk.text, page, display).catch((e) => {
          console.warn('Texte vectoriel impossible', e)
          return false
        })
        // Caractère absent de la police (emoji, idéogramme…) : image haute définition de l'objet.
        if (!ok) await this.drawShapes(out, target, page, at, 'none', [chunk.text], pdfLib, true)
      }
    }
  }

  /**
   * Dessine une page de PDF insérée comme image, en vectoriel : la page d'origine est
   * intégrée comme formulaire PDF et placée avec la même transformation qu'à l'écran
   * (position, taille, rotation, miroir).
   */
  private async drawPdfPage(out: PDFDocument, target: PDFPage, page: Page, o: FabricObject, display: number[], pdfLib: typeof import('pdf-lib')): Promise<boolean> {
    const ref = (o as { pdfPage?: { assetId: string; index: number } }).pdfPage!
    const bytes = assets.get(ref.assetId)?.bytes
    // Transparence : rendu en image (le formulaire PDF n'en porte pas).
    if (!bytes || o.opacity < 1) return false
    const src = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    const srcPage = src.getPage(ref.index)
    // Page tournée (/Rotate) : l'image affichée est déjà juste, on la garde.
    if (srcPage.getRotation().angle % 360 !== 0) return false
    const crop = srcPage.getCropBox()
    const embedded = await out.embedPage(srcPage, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height })
    const w = (o as FabricObject & { width: number }).width
    const h = (o as FabricObject & { height: number }).height
    // (u, v) de la page d'origine (v vers le haut) → repère local de l'image (centré, y vers le bas).
    const local = [w / embedded.width, 0, 0, -h / embedded.height, -w / 2, h / 2]
    const scene = util.multiplyTransformMatrices(o.calcTransformMatrix(), local as never)
    const onPage = util.multiplyTransformMatrices([1, 0, 0, 1, -page.left, -page.top] as never, scene)
    const m = util.multiplyTransformMatrices(display as never, onPage)
    const name = target.node.newXObject('FeuilletPdf', embedded.ref)
    target.pushOperators(
      pdfLib.pushGraphicsState(),
      pdfLib.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
      pdfLib.drawObject(name),
      pdfLib.popGraphicsState()
    )
    return true
  }

  private async drawShapes(
    out: PDFDocument,
    target: PDFPage,
    page: Page,
    at: PdfPlacement,
    background: 'vector' | 'none',
    objects: FabricObject[],
    pdfLib: typeof import('pdf-lib'),
    forceRaster = false
  ): Promise<void> {
    let embedded: PDFEmbeddedPage | PDFImage
    try {
      if (forceRaster) throw new Error('raster')
      const { jsPDF } = await lib.jspdf()
      const { svg2pdf } = await lib.svg2pdf()
      const svgText = pdfFonts(await this.svg(page, background, objects, true))
      const svgEl = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement
      const pdf = new jsPDF({ unit: 'pt', format: [page.width, page.height], orientation: page.width > page.height ? 'l' : 'p', compress: true, putOnlyUsedFonts: true })
      await svg2pdf(svgEl, pdf, { x: 0, y: 0, width: page.width, height: page.height })
      const [embeddedPage] = await out.embedPdf(new Uint8Array(pdf.output('arraybuffer')))
      embedded = embeddedPage
    } catch (e) {
      if (!forceRaster) console.warn('Export vectoriel impossible, repli en image 300 ppp', e)
      const canvas = await this.rasterObjects(page, objects, 300)
      embedded = await out.embedPng(new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer()))
    }
    draw(target, embedded, at, pdfLib.degrees, pdfLib.PDFImage)
  }

  /** Image transparente d'une page ne contenant que certains objets. */
  private async rasterObjects(page: Page, objects: FabricObject[], dpi: number): Promise<HTMLCanvasElement> {
    const s = dpi / 72
    const sc = new StaticCanvas(undefined, { width: Math.round(page.width * s), height: Math.round(page.height * s), enableRetinaScaling: false, renderOnAddRemove: false })
    sc.add(...(await Promise.all(objects.map((o) => o.clone()))))
    sc.setViewportTransform([s, 0, 0, s, -page.left * s, -page.top * s])
    sc.renderAll()
    const out = document.createElement('canvas')
    out.width = sc.width
    out.height = sc.height
    out.getContext('2d')!.drawImage(sc.getElement(), 0, 0)
    await sc.dispose()
    return out
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

/** Repère de la page affichée (points, y vers le bas) → repère de la page PDF (rotation comprise). */
function displayMatrix(at: PdfPlacement): number[] {
  const { rotation: r, x, y, width: W, height: H } = at
  const Hd = r % 180 === 0 ? H : W
  const origin = r === 90 ? [x + W, y] : r === 180 ? [x + W, y + H] : r === 270 ? [x, y + H] : [x, y]
  const rad = (r * Math.PI) / 180
  const cos = Math.round(Math.cos(rad))
  const sin = Math.round(Math.sin(rad))
  // (u, v) → (u, Hd − v) puis rotation r autour de l'origine.
  return [cos, sin, sin, -cos, origin[0] - sin * Hd, origin[1] + cos * Hd]
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
