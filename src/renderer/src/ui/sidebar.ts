import type { FabricObject } from 'fabric'
import type { Editor } from '../core/editor'
import type { Page } from '../core/page'
import type { Layers } from '../core/layers'
import type { Exporter } from '../io/exporter'
import { pdfEngine } from '../pdf/engine'
import type { PdfOutlineItem } from '../pdf/protocol'

type Tab = 'pages' | 'outline' | 'layers'

/**
 * Panneau latéral : miniatures des pages (réorganiser par glisser-déposer, dupliquer,
 * supprimer, insérer), sommaire du PDF, calques. Les miniatures ne sont rendues
 * que lorsqu'elles sont visibles, et rafraîchies après modification.
 */
export class Sidebar {
  private root = document.getElementById('sidebar') as HTMLElement
  private body = document.createElement('div')
  private tab: Tab = 'pages'
  private observer: IntersectionObserver
  private thumbs = new Map<string, HTMLCanvasElement>()
  private dirty = new Set<string>()
  private signature = ''
  private refreshTimer = 0

  constructor(
    private ed: Editor,
    private exporter: Exporter,
    private layers: Layers,
    private addPageAfter: (page: Page) => Promise<void>
  ) {
    const tabs = document.createElement('div')
    tabs.className = 'side-tabs'
    for (const [id, label] of [['pages', 'Pages'], ['outline', 'Sommaire'], ['layers', 'Calques']] as [Tab, string][]) {
      const b = document.createElement('button')
      b.textContent = label
      b.dataset.tab = id
      b.addEventListener('click', () => this.show(id))
      tabs.append(b)
    }
    this.body.className = 'side-body'
    this.root.append(tabs, this.body)
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) void this.renderThumb((e.target as HTMLElement).dataset.page!)
    }, { root: this.body, rootMargin: '200px' })
    // Après chaque modification : rafraîchit les miniatures concernées (en différé, sans bloquer).
    ed.canvas.on('object:modified', ({ target }) => this.markDirty(target))
    ed.canvas.on('object:added', ({ target }) => this.markDirty(target))
    ed.canvas.on('object:removed', ({ target }) => this.markDirty(target))
    layers.onChange(() => this.tab === 'layers' && this.render())
    this.show('pages')
  }

  get visible(): boolean {
    return this.root.classList.contains('open')
  }

  toggle(force?: boolean): void {
    this.root.classList.toggle('open', force)
    this.ed.canvas.fire('sidebar:toggle' as never)
    window.dispatchEvent(new Event('resize'))
    if (this.visible) this.render()
  }

  show(tab: Tab): void {
    this.tab = tab
    this.root.querySelectorAll<HTMLButtonElement>('.side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
    this.signature = ''
    this.render()
  }

  private markDirty(obj: FabricObject | undefined): void {
    if (!obj || !this.visible || this.tab !== 'pages') return
    const pages = this.ed.doc.pages
    if ((obj as Page).role === 'page' || pages.map((p) => p.pageId).join() !== this.signature) {
      window.clearTimeout(this.refreshTimer)
      this.refreshTimer = window.setTimeout(() => this.render(), 300)
      return
    }
    const page = this.ed.doc.pageAt(obj.getCenterPoint())
    if (page) this.dirty.add(page.pageId)
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      for (const id of this.dirty) void this.renderThumb(id)
      this.dirty.clear()
    }, 700)
  }

  render(): void {
    if (!this.visible) return
    if (this.tab === 'pages') return this.renderPages()
    if (this.tab === 'outline') return void this.renderOutline()
    this.layers.renderPanel(this.body)
  }

  // --- Pages -------------------------------------------------------------------

  private renderPages(): void {
    const pages = this.ed.doc.pages
    const sig = pages.map((p) => p.pageId).join()
    if (sig === this.signature && this.body.querySelector('.thumb-list')) return
    this.signature = sig
    this.observer.disconnect()
    this.thumbs.clear()
    const list = document.createElement('ol')
    list.className = 'thumb-list'
    let dragged: number | null = null
    pages.forEach((page, i) => {
      const item = document.createElement('li')
      item.className = 'thumb'
      item.draggable = true
      item.dataset.page = page.pageId
      const canvas = document.createElement('canvas')
      const w = 132
      canvas.width = w * devicePixelRatio
      canvas.height = Math.round((w * page.height) / page.width) * devicePixelRatio
      canvas.style.width = `${w}px`
      canvas.style.aspectRatio = `${page.width} / ${page.height}`
      this.thumbs.set(page.pageId, canvas)
      const label = document.createElement('span')
      label.className = 'thumb-label'
      label.textContent = String(i + 1)
      const actions = document.createElement('div')
      actions.className = 'thumb-actions'
      const act = (text: string, title: string, fn: () => void): void => {
        const b = document.createElement('button')
        b.textContent = text
        b.title = title
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          fn()
        })
        actions.append(b)
      }
      act('+', 'Insérer une page après', () => void this.addPageAfter(page))
      act('⧉', 'Dupliquer la page', () => void this.duplicate(page))
      act('✕', 'Supprimer la page', () => void this.remove(page))
      item.append(canvas, label, actions)
      item.addEventListener('click', () => this.ed.viewport.showRect(this.ed.doc.box(page)))
      item.addEventListener('dragstart', () => (dragged = i))
      item.addEventListener('dragover', (e) => {
        e.preventDefault()
        item.classList.add('drop')
      })
      item.addEventListener('dragleave', () => item.classList.remove('drop'))
      item.addEventListener('drop', (e) => {
        e.preventDefault()
        item.classList.remove('drop')
        if (dragged === null || dragged === i) return
        const order = [...pages]
        const [moved] = order.splice(dragged, 1)
        order.splice(i, 0, moved)
        void this.ed.history.transaction(() => this.ed.doc.reorder(order)).then(() => {
          this.ed.canvas.requestRenderAll()
          this.render()
        })
      })
      list.append(item)
      this.observer.observe(item)
    })
    this.body.replaceChildren(list)
  }

  private async renderThumb(pageId: string): Promise<void> {
    const canvas = this.thumbs.get(pageId)
    const page = this.ed.doc.pages.find((p) => p.pageId === pageId)
    if (!canvas || !page) return
    const dpi = (canvas.width / page.width) * 72
    const img = await this.exporter.raster(page, dpi)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  }

  private async duplicate(page: Page): Promise<void> {
    const { doc, history, canvas } = this.ed
    await history.transaction(async () => {
      const copy = doc.addPage({ width: page.width, height: page.height }, { bg: structuredClone(page.bg), after: page })
      const dy = copy.top - page.top
      for (const o of doc.ownedBy(page)) {
        const c = await o.clone()
        c.set({ top: c.top + dy })
        canvas.add(c)
      }
    })
    canvas.requestRenderAll()
  }

  private async remove(page: Page): Promise<void> {
    if (this.ed.doc.pages.length <= 1) return this.ed.notify('Le document doit garder au moins une page', 'info')
    await this.ed.history.transaction(() => this.ed.doc.removePage(page))
    this.ed.canvas.requestRenderAll()
  }

  // --- Sommaire ------------------------------------------------------------------

  private async renderOutline(): Promise<void> {
    const pages = this.ed.doc.pages
    const pdfs = [...new Set(pages.flatMap((p) => (p.bg.kind === 'pdf' ? [p.bg.assetId] : [])))]
    const wrap = document.createElement('div')
    wrap.className = 'outline'
    for (const assetId of pdfs) {
      const items = await pdfEngine.outline(assetId).catch(() => [])
      const build = (list: PdfOutlineItem[]): HTMLUListElement => {
        const ul = document.createElement('ul')
        for (const it of list) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.textContent = it.title || '(sans titre)'
          b.addEventListener('click', () => {
            const target = pages.find((p) => p.bg.kind === 'pdf' && p.bg.assetId === assetId && p.bg.index === it.page)
            if (target) this.ed.viewport.showRect(this.ed.doc.box(target))
          })
          li.append(b)
          if (it.children.length) li.append(build(it.children))
          ul.append(li)
        }
        return ul
      }
      if (items.length) wrap.append(build(items))
    }
    if (!wrap.childElementCount) wrap.innerHTML = '<p class="prop-hint">Ce document n’a pas de sommaire.</p>'
    if (this.tab === 'outline') this.body.replaceChildren(wrap)
  }
}
