import type { FabricObject, Point } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import { paragraphAt, wordAt, type Box4 } from '../pdf/edit-text'
import { pageWords } from '../pdf/text'
import { canRecognize, recognizePage } from '../pdf/ocr'
import type { Tool, ToolManager } from '../tools/manager'
import { icon } from './icons'

const PDF_TOOLS: Tool[] = ['textselect', 'edittext']

/**
 * Rend les deux outils PDF compréhensibles du premier coup :
 * - une bande explique ce que fait l'outil et quoi faire, ou pourquoi il ne fait rien ici
 *   (pas de PDF, page sans texte ou PDF scanné), avec le bon raccourci (« Écrire du texte ») ;
 * - au survol, ce qui sera pris s'encadre : le mot (Annoter PDF) ou le paragraphe entier
 *   (Modifier PDF), avec une étiquette « Cliquer pour modifier » / « Glisser pour sélectionner » ;
 * - les boutons sont grisés tant que le document ne contient aucun PDF.
 */
export class PdfToolsGuide {
  private banner = document.createElement('div')
  private hoverBox = document.createElement('div')
  private hovered: Box4 | null = null
  private frame = 0
  private lastPoint: Point | null = null
  private bannerKey = ''

  constructor(
    private ed: Editor,
    private tools: ToolManager,
    private actions: { open: () => void; writeText: () => void }
  ) {
    this.banner.className = 'pdf-guide'
    this.banner.hidden = true
    this.banner.setAttribute('role', 'status')
    this.hoverBox.className = 'pdf-hover'
    this.hoverBox.hidden = true
    this.hoverBox.innerHTML = '<span class="pdf-hover-label"></span>'
    const ws = document.getElementById('workspace')!
    ws.append(this.banner, this.hoverBox)

    const c = ed.canvas
    tools.onChange(() => {
      this.hide()
      void this.refresh()
      this.markButtons()
    })
    c.on('mouse:move', (o) => {
      if (!PDF_TOOLS.includes(tools.tool)) return
      this.lastPoint = o.scenePoint
      if (!this.frame) this.frame = requestAnimationFrame(() => void this.onHover())
    })
    c.on('mouse:out', () => this.hide())
    c.on('mouse:down', () => this.hide())
    // La vue bouge (défilement, zoom) : l'encadré suit, la bande se met à jour.
    let timer = 0
    c.on('after:render', () => {
      this.place()
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void this.refresh(), 200)
    })
    const pagesChanged = ({ target }: { target?: FabricObject }): void => {
      if ((target as Page | undefined)?.role === 'page') this.markButtons()
    }
    c.on('object:added', pagesChanged as never)
    c.on('object:removed', pagesChanged as never)
    this.markButtons()
  }

  /** Le document a-t-il un PDF ou une image (scan, photo) où chercher du texte ? */
  private get hasPdf(): boolean {
    return this.ed.doc.pages.some((p) => p.bg.kind === 'pdf' || p.bg.kind === 'image')
  }

  private ocrRunning = false

  /** Reconnaissance du texte de la page (scan, photo, texte en image), sur l'appareil. */
  private async recognize(page: Page): Promise<void> {
    if (this.ocrRunning) return
    this.ocrRunning = true
    this.bannerKey = ''
    this.banner.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      this.ed.notify('Reconnaissance du texte… (la première fois, quelques secondes de préparation)', 'info')
      const data = await recognizePage(page, (p) => {
        const label = this.banner.querySelector('.pdf-guide-ocr')
        if (label) label.textContent = `Reconnaissance… ${Math.round(p * 100)} %`
      })
      const words = data.chars.filter((c) => c.c === ' ' || c.c === '\n').length
      await this.ed.history.transaction(() => page.set({ ocr: data } as never))
      this.ed.notify(data.chars.length ? `Texte reconnu (${words} mots environ) : il se modifie comme le reste.` : 'Aucun texte trouvé sur cette page.', data.chars.length ? 'success' : 'info')
    } catch (e) {
      console.error(e)
      this.ed.notify('Reconnaissance du texte impossible sur cet appareil.', 'error')
    } finally {
      this.ocrRunning = false
      this.bannerKey = ''
      void this.refresh()
    }
  }

  /** Grise les outils PDF quand il n'y a aucun PDF (ils restent cliquables : la bande explique). */
  private markButtons(): void {
    const off = !this.hasPdf
    for (const t of PDF_TOOLS) document.querySelector(`#toolbar [data-tool=${t}]`)?.classList.toggle('unavailable', off)
  }

  private async onHover(): Promise<void> {
    this.frame = 0
    const p = this.lastPoint
    if (!p || !PDF_TOOLS.includes(this.tools.tool)) return
    const edit = this.tools.tool === 'edittext'
    const box = edit ? await paragraphAt(this.ed, p) : await wordAt(this.ed, p)
    if (p !== this.lastPoint) return
    this.hovered = box
    this.hoverBox.classList.toggle('word', !edit)
    this.hoverBox.querySelector('.pdf-hover-label')!.textContent = edit ? 'Cliquer pour modifier ce texte' : 'Glisser pour sélectionner'
    this.place()
  }

  private place(): void {
    const b = this.hovered
    if (!b || !PDF_TOOLS.includes(this.tools.tool)) {
      this.hoverBox.hidden = true
      return
    }
    const v = this.ed.canvas.viewportTransform
    const pad = this.tools.tool === 'edittext' ? 4 : 1
    Object.assign(this.hoverBox.style, {
      left: `${b.x0 * v[0] + v[4] - pad}px`,
      top: `${b.y0 * v[3] + v[5] - pad}px`,
      width: `${(b.x1 - b.x0) * v[0] + pad * 2}px`,
      height: `${(b.y1 - b.y0) * v[3] + pad * 2}px`
    })
    this.hoverBox.hidden = false
  }

  private hide(): void {
    this.hovered = null
    this.hoverBox.hidden = true
  }

  /** Bande d'explication selon l'outil et la page à l'écran. */
  private async refresh(): Promise<void> {
    const tool = this.tools.tool
    if (!PDF_TOOLS.includes(tool)) {
      this.banner.hidden = true
      this.bannerKey = ''
      return
    }
    const page = (this.lastPoint && this.ed.doc.pageAt(this.lastPoint)) || this.ed.doc.currentPage()
    let state: 'nopdf' | 'notext' | 'ok' = 'ok'
    if (!this.hasPdf) state = 'nopdf'
    else if (!page || (await pageWords(page)).length === 0) state = 'notext'
    const key = `${tool}:${state}`
    if (key === this.bannerKey && !this.banner.hidden) return
    this.bannerKey = key
    const edit = tool === 'edittext'
    const name = edit ? 'Modifier PDF' : 'Annoter PDF'
    const what = edit
      ? 'réécrit le texte d’un PDF importé, avec sa police et sa taille'
      : 'sélectionne le texte d’un PDF importé pour le copier, le surligner, le souligner ou le barrer'
    let html: string
    if (state === 'ok') {
      html = edit
        ? `${icon('edittext', 18)}<span><b>Modifier PDF</b> — survolez le texte : le paragraphe s’encadre. <b>Cliquez</b> pour le réécrire, puis <kbd>Échap</kbd> pour terminer.</span>`
        : `${icon('textselect', 18)}<span><b>Annoter PDF</b> — <b>glissez</b> sur le texte du PDF, puis choisissez <b>Copier</b>, <b>Surligner</b>, <b>Souligner</b> ou <b>Barrer</b>.</span>`
    } else {
      const why = state === 'nopdf'
        ? 'Ce document ne contient pas de PDF.'
        : page && canRecognize(page)
          ? 'Cette page n’a pas de texte reconnu (scan, photo, texte en image) : lancez la reconnaissance du texte.'
          : 'Cette page n’a pas de texte (page ajoutée).'
      html = `${icon(edit ? 'edittext' : 'textselect', 18)}<span><b>${name}</b> ${what}. ${why}</span>`
    }
    this.banner.innerHTML = html
    if (state !== 'ok') {
      const actions = document.createElement('span')
      actions.className = 'pdf-guide-actions'
      // Page sans texte mais avec un scan, une photo ou du texte en image : OCR.
      if (state === 'notext' && page && canRecognize(page)) {
        const ocr = document.createElement('button')
        ocr.type = 'button'
        ocr.className = 'primary pdf-guide-ocr'
        ocr.innerHTML = `${icon('textselect', 16)}<span>Reconnaître le texte (OCR)</span>`
        ocr.addEventListener('click', () => void this.recognize(page))
        actions.append(ocr)
      }
      const write = document.createElement('button')
      write.type = 'button'
      write.className = state === 'notext' && page && canRecognize(page) ? '' : 'primary'
      write.innerHTML = `${icon('text', 16)}Écrire du texte`
      write.addEventListener('click', () => this.actions.writeText())
      actions.append(write)
      if (state === 'nopdf') {
        const open = document.createElement('button')
        open.type = 'button'
        open.textContent = 'Ouvrir un PDF…'
        open.addEventListener('click', () => this.actions.open())
        actions.append(open)
      }
      this.banner.append(actions)
    }
    this.banner.classList.toggle('empty', state !== 'ok')
    this.banner.hidden = false
  }
}
