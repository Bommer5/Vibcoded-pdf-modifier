import { FabricImage, loadSVGFromString, Point, util, type FabricObject } from 'fabric'
import { assets, type Asset } from '../core/assets'
import { pageRenderer } from '../core/page-renderer'
import type { Editor } from '../core/editor'
import type { Page } from '../core/document'
import type { Obj } from '../core/props'
import { platform, type FileFilter, type OpenedFile } from '../platform'
import { decodeImage, DECODED_IMAGE_EXT, NATIVE_IMAGE_EXT } from './images'
import { pdfEngine } from '../pdf/engine'
import { loadProject } from './project'
import { decodeText, importTextAsPages, textBox, TEXT_EXT } from './text'
import { importXournal } from './xournal'

/** Formats bureautiques ouverts via LibreOffice (conversion fidèle en PDF). */
export const OFFICE_EXT = [
  // Traitement de texte
  'doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'ott', 'fodt', 'rtf', 'wpd', 'wps', 'lwp', 'abw', 'pages', 'hwp', 'epub',
  // Tableurs
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'fods', 'numbers',
  // Présentations
  'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'fodp', 'key',
  // Dessin / PAO
  'odg', 'vsd', 'vsdx', 'cdr', 'pub', 'emf', 'wmf', 'cgm', 'xps', 'html', 'htm'
]

export const IMAGE_EXT = [...NATIVE_IMAGE_EXT, ...DECODED_IMAGE_EXT]

type Kind = 'project' | 'pdf' | 'image' | 'svg' | 'text' | 'office' | 'xournal'

export function extOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

export function kindOf(name: string): Kind | null {
  const ext = extOf(name)
  if (ext === 'feuillet') return 'project'
  if (ext === 'pdf' || ext === 'ai') return 'pdf' // les .ai modernes sont des PDF
  if (ext === 'svg') return 'svg'
  if (ext === 'xopp' || ext === 'xoj') return 'xournal'
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (TEXT_EXT.includes(ext)) return 'text'
  if (OFFICE_EXT.includes(ext)) return 'office'
  return null
}

export const OPEN_FILTERS: FileFilter[] = [
  {
    name: 'Tous les fichiers pris en charge',
    extensions: ['feuillet', 'pdf', 'ai', 'svg', 'xopp', 'xoj', ...IMAGE_EXT, ...TEXT_EXT, ...OFFICE_EXT]
  },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Projet Feuillet', extensions: ['feuillet'] },
  { name: 'Images', extensions: [...IMAGE_EXT, 'svg'] },
  { name: 'Documents', extensions: OFFICE_EXT },
  { name: 'Xournal / Xournal++', extensions: ['xopp', 'xoj'] },
  { name: 'Texte', extensions: TEXT_EXT },
  { name: 'Tous les fichiers', extensions: ['*'] }
]

const PX_TO_PT = 0.75 // 96 ppp → 72 ppp
const LONG_TEXT_LINES = 40

export class Importer {
  constructor(private ed: Editor) {}

  /** Ouvre des fichiers comme nouveau document (le premier remplace le document courant). */
  async open(files: OpenedFile[]): Promise<void> {
    if (files.length === 0) return
    const { doc, history, viewport } = this.ed
    if (!doc.isEmpty && history.canUndo && !confirm('Le document actuel sera fermé. Continuer ?')) return

    let ok = false
    await this.guard(async () => {
      await history.transaction(() => this.replaceWith(files))
      ok = true
    })
    if (doc.pages.length === 0) await doc.addPage()
    history.reset()
    viewport.fit(doc.box(doc.pages[0]))
    if (!ok) return
    document.title = `${files[0].name} — Feuillet`
    this.ed.notify(`${files[0].name} ouvert (${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''})`, 'success')
  }

  private async replaceWith(files: OpenedFile[]): Promise<void> {
    this.ed.doc.clear()
    pageRenderer.clear()
    await pdfEngine.closeAll()
    pdfEngine.forgetText()
    assets.clear(this.ed.keepAssets?.())
    for (const file of files) {
      if (kindOf(file.name) === 'project') {
        if (files.length > 1) throw new Error('Ouvrez un projet .feuillet seul')
        await loadProject(this.ed.canvas, file.data)
      } else {
        await this.appendDocument(file)
      }
    }
  }

  /** Insère des fichiers dans le document courant : objets sur la page, ou pages à la suite. */
  async insert(files: OpenedFile[], at: Point | null = this.ed.pointer()): Promise<void> {
    if (files.length === 0) return
    if (this.ed.doc.isEmpty && files.every((f) => kindOf(f.name) !== 'image' && kindOf(f.name) !== 'svg')) {
      return this.open(files)
    }
    await this.guard(() =>
      this.ed.history.transaction(async () => {
        for (const [i, file] of files.entries()) {
          const offset = at ? new Point(at.x + i * 20, at.y + i * 20) : null
          await this.insertOne(file, offset)
        }
      })
    )
  }

  /** Insère une image du presse-papiers. */
  async insertImageBlob(blob: Blob, at: Point | null): Promise<void> {
    await this.guard(async () => {
      const asset = await assets.addBlob(blob)
      await this.ed.history.transaction(() => this.placeImage(asset, at))
    })
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      console.error(e)
      this.ed.notify((e as Error).message || 'Import impossible', 'error')
    }
  }

  private async insertOne(file: OpenedFile, at: Point | null): Promise<void> {
    const kind = kindOf(file.name)
    switch (kind) {
      case 'image':
        for (const asset of await decodeImage(extOf(file.name), file.data)) await this.placeImage(asset, at)
        return
      case 'svg': {
        const group = await this.svgGroup(file.data)
        this.place(group, at)
        return
      }
      case 'text': {
        const text = decodeText(file.data)
        const page = this.targetPage(at)
        // Un long texte devient des pages ; un court texte, une zone sous le pointeur.
        if (text.split('\n').length > LONG_TEXT_LINES) {
          const pages = await importTextAsPages(text, this.ed.doc, (o) => this.ed.add(o), page)
          this.ed.viewport.fit(this.ed.doc.box(pages[0]))
          return
        }
        const box = textBox(text, 0, 0, Math.min(400, page.width - 80))
        this.place(box, at, false)
        return
      }
      case 'project':
        throw new Error('Utilisez « Ouvrir » pour un projet .feuillet')
      case null:
        throw new Error(`Format non pris en charge : ${file.name}`)
      default: {
        const pages = await this.appendDocument(file, this.targetPage(at))
        if (pages[0]) this.ed.viewport.fit(this.ed.doc.box(pages[0]))
      }
    }
  }

  /** Ajoute les pages d'un document (PDF, bureautique, Xournal, texte, image pleine page). */
  private async appendDocument(file: OpenedFile, after?: Page): Promise<Page[]> {
    const { doc } = this.ed
    const ext = extOf(file.name)
    switch (kindOf(file.name)) {
      case 'pdf':
        return this.appendPdf(file.data, file.name, after)
      case 'office':
        return this.appendOffice(file, after)
      case 'xournal':
        if (after) throw new Error('Un carnet Xournal s’ouvre comme nouveau document (Ouvrir)')
        return importXournal(file.data, file.path, doc, (o) => this.ed.add(o))
      case 'text':
        return importTextAsPages(decodeText(file.data), doc, (o) => this.ed.add(o))
      case 'image': {
        const pages: Page[] = []
        for (const asset of await decodeImage(ext, file.data)) {
          const bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
          const size = { width: bmp.width * PX_TO_PT, height: bmp.height * PX_TO_PT }
          bmp.close()
          pages.push(doc.addPage(size, { bg: { kind: 'image', assetId: asset.id }, after: pages.at(-1) ?? after }))
        }
        return pages
      }
      case 'svg': {
        const group = await this.svgGroup(file.data)
        const page = await doc.addPage({ width: group.width, height: group.height }, { after })
        group.set({ left: page.left, top: page.top, originX: 'left', originY: 'top' })
        this.ed.add(group)
        return [page]
      }
      default:
        throw new Error(`Format non pris en charge : ${file.name}`)
    }
  }

  /** Pages d'un PDF : seule la taille est lue ici (instantané) ; le rendu se fait à l'affichage. */
  private async appendPdf(bytes: Uint8Array, _name: string, after?: Page): Promise<Page[]> {
    const asset = assets.add(bytes, 'application/pdf')
    const sizes = await pdfEngine.open(asset.id, bytes)
    const pages: Page[] = []
    sizes.forEach((size, index) => {
      pages.push(this.ed.doc.addPage(size, { bg: { kind: 'pdf', assetId: asset.id, index }, after: pages.at(-1) ?? after }))
    })
    return pages
  }

  private async appendOffice(file: OpenedFile, after?: Page): Promise<Page[]> {
    if (await platform.officeAvailable()) {
      this.ed.notify(`Conversion de ${file.name}…`)
      const pdf = await platform.officeConvert(file.name, file.data, 'pdf')
      return this.appendPdf(pdf, file.name, after)
    }
    if (extOf(file.name) === 'docx') {
      // Repli sans LibreOffice : texte seul (mammoth).
      const mammoth = await import('mammoth')
      const buffer = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer
      const { value } = await mammoth.extractRawText({ arrayBuffer: buffer })
      this.ed.notify('LibreOffice absent : seul le texte du document a été importé.', 'info')
      return importTextAsPages(value, this.ed.doc, (o) => this.ed.add(o))
    }
    throw new Error(
      platform.kind === 'desktop'
        ? `Pour ouvrir ${file.name}, installez LibreOffice (gratuit) : https://www.libreoffice.org`
        : `Ce format n’est pas encore pris en charge sur cet appareil : ${file.name}`
    )
  }

  private async svgGroup(data: Uint8Array): Promise<FabricObject> {
    const { objects, options } = await loadSVGFromString(new TextDecoder().decode(data))
    const valid = objects.filter((o): o is FabricObject => !!o)
    if (valid.length === 0) throw new Error('SVG vide ou illisible')
    return util.groupSVGElements(valid, options)
  }

  private targetPage(at: Point | null): Page {
    const { doc } = this.ed
    return (at && doc.pageAt(at)) || doc.currentPage() || doc.pages[0]
  }

  private async placeImage(asset: Asset, at: Point | null): Promise<void> {
    const img = await FabricImage.fromURL(asset.url)
    ;(img as Obj).assetId = asset.id
    img.set({ scaleX: PX_TO_PT, scaleY: PX_TO_PT })
    this.place(img, at)
  }

  /** Pose un objet sur la page visée, centré sur `at`, réduit pour tenir dans la page. */
  private place(obj: FabricObject, at: Point | null, fit = true): void {
    const page = this.targetPage(at)
    if (fit) {
      const max = Math.min((page.width * 0.9) / obj.getScaledWidth(), (page.height * 0.9) / obj.getScaledHeight())
      if (max < 1) obj.scale(obj.scaleX * max)
    }
    const center = at ?? new Point(page.left + page.width / 2, page.top + page.height / 2)
    obj.setPositionByOrigin(center, 'center', 'center')
    obj.setCoords()
    this.ed.add(obj)
    this.ed.canvas.setActiveObject(obj)
    this.ed.canvas.requestRenderAll()
  }
}
