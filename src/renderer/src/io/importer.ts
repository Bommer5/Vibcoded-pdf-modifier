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
import { stripAnnotations } from './hybrid'
import { askPassword } from '../ui/password'
import { askPdfInsert } from '../ui/pdf-insert-dialog'
import { askCrop, type CropRect, type CropSource } from '../ui/crop-dialog'
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

/** Ne garde qu'une partie d'une image (fractions 0 à 1 de l'image entière). */
export function applyCrop(img: FabricImage, r: CropRect): void {
  const el = img.getElement() as HTMLImageElement | HTMLCanvasElement
  const W = (el as HTMLImageElement).naturalWidth || el.width
  const H = (el as HTMLImageElement).naturalHeight || el.height
  img.set({ cropX: Math.round(r.x * W), cropY: Math.round(r.y * H), width: Math.max(1, Math.round(r.w * W)), height: Math.max(1, Math.round(r.h * H)) })
  img.setCoords()
}

/** Copie réduite (côté le plus long ≤ max) d'une image, pour l'aperçu du cadrage. */
function scaled(src: CanvasImageSource & { width: number; height: number }, max: number): HTMLCanvasElement {
  const w0 = (src as HTMLImageElement).naturalWidth || src.width
  const h0 = (src as HTMLImageElement).naturalHeight || src.height
  const k = Math.min(1, max / Math.max(w0, h0))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w0 * k))
  c.height = Math.max(1, Math.round(h0 * k))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c
}

async function imageCanvas(asset: Asset): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return c
}
/** Nom de la pièce jointe d'un « PDF modifiable ». */
export const EMBEDDED_PROJECT = 'feuillet-project.feuillet'

export class Importer {
  constructor(private ed: Editor) {}

  /** Ouvre des fichiers comme nouveau document (le premier remplace le document courant). */
  /** Renvoie vrai si le document a bien été ouvert. */
  async open(files: OpenedFile[], opts: { confirm?: boolean } = {}): Promise<boolean> {
    if (files.length === 0) return false
    const { doc, history, viewport } = this.ed
    if (opts.confirm !== false && !doc.isEmpty && history.canUndo && !confirm('Le document actuel sera fermé. Continuer ?')) return false

    let ok = false
    await this.guard(async () => {
      await history.transaction(() => this.replaceWith(files))
      ok = true
    })
    if (doc.pages.length === 0) await doc.addPage()
    history.reset()
    viewport.fit(doc.box(doc.pages[0]))
    if (!ok) return false
    this.ed.notify(`${files[0].name} ouvert (${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''})`, 'success')
    return true
  }

  /**
   * Rouvre un « PDF modifiable » : le PDF d'origine est reconstitué en retirant les ajouts
   * de Feuillet (flux marqué), puis le projet joint redonne tous les objets modifiables.
   */
  private async openEditablePdf(data: Uint8Array, project: Uint8Array): Promise<void> {
    const original = await stripAnnotations(data)
    const source = assets.add(original, 'application/pdf')
    await pdfEngine.open(source.id, original)
    const scene = await loadProject(this.ed.canvas, project, (s) => {
      const map = (s.selfSource ?? null) as Record<string, number> | null
      if (!map) return // ancien format : le PDF d'origine était joint au projet
      for (const o of s.objects ?? []) {
        // Les décalages sont déjà dans le PDF reconstitué : on repart de cet état.
        delete o.pdfFlow
        const bg = o.bg as { kind?: string; assetId?: string; index?: number } | undefined
        if (o.type === 'Page' && bg?.kind === 'pdf' && typeof map[o.pageId as string] === 'number') {
          o.bg = { kind: 'pdf', assetId: source.id, index: map[o.pageId as string] }
          o.masks = [] // le texte modifié est déjà retiré du PDF d'origine reconstitué
          o.shifts = [] // et le contenu déjà décalé
        }
      }
    })
    this.ed.layers?.load(scene.layers as never)
  }

  /** « PDF modifiable » : le projet Feuillet est joint au PDF. */
  private async embeddedProject(data: Uint8Array): Promise<Uint8Array | null> {
    const probe = `probe:${crypto.randomUUID()}`
    try {
      await pdfEngine.open(probe, data)
      return await pdfEngine.attachment(probe, EMBEDDED_PROJECT)
    } catch {
      return null
    } finally {
      await pdfEngine.close(probe).catch(() => {})
    }
  }

  private async replaceWith(files: OpenedFile[]): Promise<void> {
    this.ed.doc.clear()
    this.ed.layers?.reset()
    pageRenderer.clear()
    await pdfEngine.closeAll()
    pdfEngine.forgetText()
    assets.clear(this.ed.keepAssets?.())
    for (const file of files) {
      // PDF enregistré par Feuillet : on rouvre le projet complet qu'il contient (tout reste modifiable).
      const embedded = files.length === 1 && kindOf(file.name) === 'pdf' ? await this.embeddedProject(file.data) : null
      if (embedded) {
        await this.openEditablePdf(file.data, embedded)
        continue
      }
      if (kindOf(file.name) === 'project') {
        if (files.length > 1) throw new Error('Ouvrez un projet .feuillet seul')
        const scene = await loadProject(this.ed.canvas, file.data)
        this.ed.layers?.load(scene.layers as never)
      } else {
        await this.appendDocument(file)
      }
    }
  }

  /** Insère des fichiers dans le document courant : objets sur la page, ou pages à la suite. */
  async insert(files: OpenedFile[], at: Point | null = this.ed.pointer()): Promise<void> {
    if (files.length === 0) return
    if (this.ed.doc.isEmpty && files.every((f) => kindOf(f.name) !== 'image' && kindOf(f.name) !== 'svg')) {
      await this.open(files)
      return
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
      case 'pdf':
        return this.insertPdf(file.data, file.name, at)
      case 'office':
        if (await platform.officeAvailable()) {
          this.ed.notify(`Conversion de ${file.name}…`)
          return this.insertPdf(await platform.officeConvert(file.name, file.data, 'pdf'), file.name, at)
        }
      // fallthrough : sans LibreOffice, texte seul en nouvelles pages
      default: {
        const pages = await this.appendDocument(file, this.targetPage(at))
        if (pages[0]) this.ed.viewport.fit(this.ed.doc.box(pages[0]))
      }
    }
  }

  /**
   * PDF inséré dans un document existant : on demande comment (image sur la page, ou
   * nouvelles pages au format du PDF ou du document), quelles pages et où.
   */
  private async insertPdf(bytes: Uint8Array, name: string, at: Point | null): Promise<void> {
    const { asset, sizes } = await this.loadPdf(bytes, name)
    const target = this.targetPage(at)
    const choice = await askPdfInsert(name, sizes, target, this.thumbnail(asset.id, sizes[0]))
    if (!choice) return
    if (choice.mode === 'part') return this.insertPdfPart(asset, sizes, at, choice.pages[0] ?? 0)
    const { doc } = this.ed
    if (choice.mode === 'image') {
      // Première page choisie sur la page visée, les suivantes sur les pages d'après (créées au besoin).
      let page: Page = target
      for (const [k, index] of choice.pages.entries()) {
        if (k > 0) page = doc.pages[doc.pages.indexOf(page) + 1] ?? doc.addPage({ width: page.width, height: page.height }, { after: page })
        const img = await this.pdfPageImage(asset.id, index, sizes[index])
        const center = k === 0 && at ? at : new Point(page.left + page.width / 2, page.top + page.height / 2)
        this.place(img, center)
      }
      return
    }
    let after = choice.position === 'end' ? doc.pages.at(-1)! : target
    const added: Page[] = []
    for (const index of choice.pages) {
      if (choice.mode === 'pages-pdf') {
        after = doc.addPage(sizes[index], { bg: { kind: 'pdf', assetId: asset.id, index }, after })
      } else {
        // Format du document : page de la taille de la page visée, PDF centré sans déformation.
        after = doc.addPage({ width: target.width, height: target.height }, { after })
        const img = await this.pdfPageImage(asset.id, index, sizes[index])
        const k = Math.min(after.width / img.getScaledWidth(), after.height / img.getScaledHeight())
        img.scale(img.scaleX * k)
        img.setPositionByOrigin(new Point(after.left + after.width / 2, after.top + after.height / 2), 'center', 'center')
        img.setCoords()
        this.ed.add(img)
      }
      added.push(after)
    }
    if (added[0]) this.ed.viewport.fit(doc.box(added[0]))
  }

  /**
   * Une partie seulement d'un fichier (un exercice dans un long PDF, un détail d'une photo) :
   * on choisit la page puis on entoure la zone. Pour un PDF, la page entière est gardée
   * derrière le cadrage : « Rogner » permet de l'agrandir ensuite, l'export reste vectoriel.
   */
  async insertPart(files: OpenedFile[], at: Point | null = null): Promise<void> {
    await this.guard(async () => {
      for (const file of files) {
        switch (kindOf(file.name)) {
          case 'pdf': {
            const { asset, sizes } = await this.loadPdf(file.data, file.name)
            await this.insertPdfPart(asset, sizes, at)
            break
          }
          case 'office': {
            if (!(await platform.officeAvailable())) throw new Error(`Pour ${file.name}, installez LibreOffice (gratuit) ou enregistrez-le en PDF`)
            this.ed.notify(`Conversion de ${file.name}…`)
            const { asset, sizes } = await this.loadPdf(await platform.officeConvert(file.name, file.data, 'pdf'), file.name)
            await this.insertPdfPart(asset, sizes, at)
            break
          }
          case 'image': {
            const frames = await decodeImage(extOf(file.name), file.data)
            const choice = await askCrop('Insérer une partie de l’image', 'Insérer', {
              count: frames.length,
              render: async (i, max) => scaled(await imageCanvas(frames[i]), max)
            })
            if (!choice) break
            const img = await FabricImage.fromURL(frames[choice.index].url)
            ;(img as Obj).assetId = frames[choice.index].id
            img.set({ scaleX: PX_TO_PT, scaleY: PX_TO_PT })
            applyCrop(img, choice.rect)
            await this.ed.history.transaction(() => this.place(img, at))
            break
          }
          default:
            await this.insert([file], at)
        }
      }
    })
  }

  private async insertPdfPart(asset: Asset, sizes: { width: number; height: number }[], at: Point | null, first = 0): Promise<void> {
    const choice = await askCrop('Insérer une partie du PDF', 'Insérer', this.pdfSource(asset.id, sizes), { index: first })
    if (!choice) return
    const img = await this.pdfPageImage(asset.id, choice.index, sizes[choice.index])
    applyCrop(img, choice.rect)
    await this.ed.history.transaction(() => this.place(img, at))
  }

  private pdfSource(id: string, sizes: { width: number; height: number }[]): CropSource {
    return {
      count: sizes.length,
      render: async (i, max) => {
        const k = max / Math.max(sizes[i].width, sizes[i].height)
        const w = Math.max(1, Math.round(sizes[i].width * k))
        const h = Math.max(1, Math.round(sizes[i].height * k))
        const bmp = await pdfEngine.render(id, i, w, h)
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        return c
      }
    }
  }

  /**
   * Rogner une image ou une page de PDF déjà posée : l'image entière est montrée avec le
   * cadrage actuel, qu'on peut réduire ou agrandir. La partie gardée ne bouge pas sur la page.
   */
  async recrop(img: FabricImage): Promise<void> {
    const el = img.getElement() as HTMLImageElement | HTMLCanvasElement
    const W = (el as HTMLImageElement).naturalWidth || el.width
    const H = (el as HTMLImageElement).naturalHeight || el.height
    if (!W || !H) return
    const current: CropRect = { x: (img.cropX ?? 0) / W, y: (img.cropY ?? 0) / H, w: img.width / W, h: img.height / H }
    const choice = await askCrop('Rogner', 'Appliquer', { count: 1, render: async (_i, max) => scaled(el, max) }, { index: 0, rect: current })
    if (!choice) return
    await this.ed.history.transaction(() => {
      // Centre de la nouvelle zone, dans le repère de l'image (centré), puis sur la page.
      const cx = choice.rect.x * W + (choice.rect.w * W) / 2 - (img.cropX ?? 0) - img.width / 2
      const cy = choice.rect.y * H + (choice.rect.h * H) / 2 - (img.cropY ?? 0) - img.height / 2
      const center = util.transformPoint(new Point(cx, cy), img.calcTransformMatrix())
      applyCrop(img, choice.rect)
      img.setPositionByOrigin(center, 'center', 'center')
      img.setCoords()
      this.ed.history.touch(img)
    })
    this.ed.canvas.requestRenderAll()
  }

  /** Ouvre un PDF (mot de passe compris) et lit la taille de ses pages. */
  private async loadPdf(bytes: Uint8Array, name: string): Promise<{ asset: Asset; sizes: { width: number; height: number }[] }> {
    const asset = assets.add(bytes, 'application/pdf')
    const sizes = await this.openWithPassword(asset.id, bytes, name)
    // PDF chiffré : on garde la copie déverrouillée (export, modification du texte…).
    const clear = pdfEngine.decrypted.get(asset.id)
    if (clear) {
      assets.replace(asset.id, clear)
      pdfEngine.decrypted.delete(asset.id)
      this.ed.notify('PDF déverrouillé : il sera enregistré sans protection.', 'info')
    }
    return { asset, sizes }
  }

  /** Aperçu de la première page pour la boîte de dialogue. */
  private async thumbnail(id: string, size: { width: number; height: number }): Promise<HTMLCanvasElement | null> {
    try {
      const k = 150 / Math.max(size.width, size.height)
      const w = Math.max(1, Math.round(size.width * k * 2))
      const h = Math.max(1, Math.round(size.height * k * 2))
      const bmp = await pdfEngine.render(id, 0, w, h)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
      return c
    } catch {
      return null
    }
  }

  /**
   * Page de PDF en image (≈ 220 ppp, nette à l'écran et à l'impression). Elle garde la
   * référence de sa page d'origine : l'export PDF la réintègre en vectoriel (texte compris).
   */
  private async pdfPageImage(id: string, index: number, size: { width: number; height: number }): Promise<FabricImage> {
    const scale = Math.min(3, 3600 / Math.max(size.width, size.height))
    const w = Math.max(1, Math.round(size.width * scale))
    const h = Math.max(1, Math.round(size.height * scale))
    const bmp = await pdfEngine.render(id, index, w, h)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Rendu impossible'))), 'image/png'))
    const png = await assets.addBlob(blob)
    const img = await FabricImage.fromURL(png.url)
    ;(img as Obj & { pdfPage?: { assetId: string; index: number } }).assetId = png.id
    ;(img as Obj & { pdfPage?: { assetId: string; index: number } }).pdfPage = { assetId: id, index }
    img.set({ scaleX: size.width / w, scaleY: size.height / h })
    return img
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
      case 'xournal': {
        if (after) throw new Error('Un carnet Xournal s’ouvre comme nouveau document (Ouvrir)')
        const pages = await importXournal(file.data, file.path, doc, (o) => this.ed.add(o))
        this.ed.layers?.load(undefined) // calques recréés d'après le carnet
        return pages
      }
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

  /** Ouvre un PDF, en demandant le mot de passe s'il est protégé (et à nouveau s'il est faux). */
  private async openWithPassword(id: string, bytes: Uint8Array, name: string): Promise<{ width: number; height: number }[]> {
    let password: string | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        return await pdfEngine.open(id, bytes, password)
      } catch (e) {
        if ((e as Error).message !== 'PASSWORD') throw e
        password = (await askPassword(name, attempt > 0)) ?? undefined
        if (password === undefined) throw new Error(`${name} est protégé par un mot de passe`)
      }
    }
  }

  /** Pages d'un PDF : seule la taille est lue ici (instantané) ; le rendu se fait à l'affichage. */
  private async appendPdf(bytes: Uint8Array, _name: string, after?: Page): Promise<Page[]> {
    const { asset, sizes } = await this.loadPdf(bytes, _name)
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
    this.ed.placed?.()
    this.ed.canvas.requestRenderAll()
  }
}
