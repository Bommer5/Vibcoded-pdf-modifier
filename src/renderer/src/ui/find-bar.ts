import { Point, type FabricObject } from 'fabric'
import type { Editor } from '../core/editor'
import { setOverlay } from '../core/overlay'
import type { Page } from '../core/page'
import { lineRects, normalize, pageWords, type DocWord } from '../pdf/text'

interface Hit {
  page: Page
  rects: { x0: number; y0: number; x1: number; y1: number }[]
}

/**
 * Recherche (Ctrl+F) dans le texte des PDF et dans les zones de texte ajoutées.
 * Insensible à la casse et aux accents (« ecole » trouve « École »), traverse les mots.
 * Les pages sont parcourues par petits lots : l'interface reste fluide sur 1 000 pages.
 */
export class FindBar {
  private root = document.createElement('div')
  private input = document.createElement('input')
  private count = document.createElement('span')
  private hits: Hit[] = []
  private current = -1
  private generation = 0

  constructor(private ed: Editor) {
    this.root.className = 'find-bar'
    this.root.hidden = true
    this.input.placeholder = 'Rechercher dans le document…'
    this.input.setAttribute('aria-label', 'Rechercher')
    const prev = this.button('↑', 'Précédent (Maj+Entrée)', () => this.step(-1))
    const next = this.button('↓', 'Suivant (Entrée)', () => this.step(1))
    const close = this.button('✕', 'Fermer (Échap)', () => this.close())
    this.count.className = 'find-count'
    this.root.append(this.input, this.count, prev, next, close)
    document.getElementById('workspace')!.append(this.root)

    let timer = 0
    this.input.addEventListener('input', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void this.search(), 180)
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.step(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') this.close()
    })
  }

  private button(text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = text
    b.title = title
    b.addEventListener('click', fn)
    return b
  }

  open(): void {
    this.root.hidden = false
    this.input.focus()
    this.input.select()
    if (this.input.value) void this.search()
  }

  close(): void {
    this.root.hidden = true
    this.hits = []
    this.generation++
    setOverlay('find', null)
  }

  private async search(): Promise<void> {
    const gen = ++this.generation
    const query = normalize(this.input.value.trim()).replace(/\s+/g, ' ')
    this.hits = []
    this.current = -1
    this.paint()
    if (query.length < 2) {
      this.count.textContent = ''
      return
    }
    this.count.textContent = '…'
    const pages = this.ed.doc.pages
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]
      const words = await pageWords(page)
      if (gen !== this.generation) return
      this.hits.push(...matchWords(words, query).map((w) => ({ page, rects: lineRects(w) })))
      for (const obj of this.ed.doc.ownedBy(page)) {
        const text = (obj as FabricObject & { text?: string }).text
        if (text && normalize(text).includes(query)) {
          const r = obj.getBoundingRect()
          this.hits.push({ page, rects: [{ x0: r.left, y0: r.top, x1: r.left + r.width, y1: r.top + r.height }] })
        }
      }
      if (this.current < 0 && this.hits.length) this.step(1)
      if (i % 8 === 7) {
        this.updateCount()
        this.paint()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    this.updateCount()
    this.paint()
  }

  private updateCount(): void {
    this.count.textContent = this.hits.length ? `${this.current + 1} / ${this.hits.length}` : 'Aucun résultat'
  }

  private step(dir: 1 | -1): void {
    if (!this.hits.length) return
    this.current = (this.current + dir + this.hits.length) % this.hits.length
    const r = this.hits[this.current].rects[0]
    this.ed.viewport.centerOn(new Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    this.updateCount()
    this.paint()
  }

  private paint(): void {
    if (!this.hits.length) return setOverlay('find', null)
    setOverlay('find', (ctx) => {
      this.hits.forEach((hit, i) => {
        ctx.fillStyle = i === this.current ? 'rgba(255,140,0,0.55)' : 'rgba(255,214,0,0.4)'
        for (const r of hit.rects) ctx.fillRect(r.x0 - 1, r.y0 - 1, r.x1 - r.x0 + 2, r.y1 - r.y0 + 2)
      })
    })
  }
}

/** Correspondances d'une requête (normalisée) sur une suite de mots, même à cheval sur plusieurs mots. */
function matchWords(words: DocWord[], query: string): DocWord[][] {
  if (!words.length) return []
  let text = ''
  const owner: number[] = []
  words.forEach((w, i) => {
    if (i) {
      text += ' '
      owner.push(i)
    }
    const n = normalize(w.text)
    text += n
    for (let k = 0; k < n.length; k++) owner.push(i)
  })
  const out: DocWord[][] = []
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) {
    out.push(words.slice(owner[at], owner[at + query.length - 1] + 1))
  }
  return out
}
