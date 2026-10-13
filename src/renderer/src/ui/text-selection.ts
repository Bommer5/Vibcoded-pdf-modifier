import { Point, util, type IText } from 'fabric'
import type { Editor } from '../core/editor'
import { setOverlay } from '../core/overlay'
import type { Page } from '../core/page'
import { buildMarkup, lineRects, pageWords, wordsBetween, wordsText, type DocWord, type MarkupKind } from '../pdf/text'
import { isTextObject } from '../io/pdf-text'

const MARKUP_COLORS = ['#ffe600', '#7cf06b', '#5ad1ff', '#ff8ad8', '#ff6b6b']

/**
 * Sélection du texte d'origine des PDF (glisser comme dans un traitement de texte,
 * sur plusieurs lignes), puis : copier, surligner, souligner, barrer.
 * Les annotations épousent exactement les lignes de texte.
 */
export class TextSelection {
  private words: DocWord[] = []
  private all: DocWord[] = []
  private start: Point | null = null
  private bar = document.createElement('div')
  private color = MARKUP_COLORS[0]

  constructor(private ed: Editor) {
    this.bar.className = 'text-bar'
    this.bar.hidden = true
    document.getElementById('workspace')!.append(this.bar)
    this.renderBar()
    document.addEventListener('copy', (e) => {
      if (!this.words.length || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', wordsText(this.words))
      this.ed.notify('Texte copié', 'success')
    }, { capture: true })
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.clear())
  }

  get active(): boolean {
    return this.words.length > 0
  }

  async begin(p: Point): Promise<void> {
    this.clear()
    const page = this.ed.doc.pageAt(p)
    if (!page) return
    this.start = p
    this.all = await pageWords(page)
    if (!this.all.length) this.ed.notify('Cette page ne contient pas de texte sélectionnable (image ou scan).', 'info')
  }

  update(p: Point): void {
    if (!this.start || !this.all.length) return
    this.words = wordsBetween(this.all, this.start, p)
    this.paint()
  }

  end(): void {
    this.start = null
    if (!this.words.length) return this.clear()
    this.showBar()
  }

  clear(): void {
    this.words = []
    this.start = null
    this.bar.hidden = true
    setOverlay('text-selection', null)
  }

  /** Mots touchés par un trait de surligneur (aimantation) : null si le trait ne passe pas sur du texte. */
  async snapStroke(points: [number, number][], page: Page | undefined): Promise<DocWord[] | null> {
    if (!page || points.length < 2) return null
    // Texte du PDF (ou reconnu par OCR) et texte écrit dans le document (zones de texte,
    // paragraphes modifiés) : le surligneur s'aimante aux deux.
    const words = [...(await pageWords(page)), ...this.objectWords(page)]
    if (!words.length) return null
    const ys = points.map((p) => p[1])
    const heights = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b)
    const lineH = heights[heights.length >> 1] || 10
    // Trait qui descend sur plusieurs lignes : comme une sélection de texte du début à la fin.
    if (Math.max(...ys) - Math.min(...ys) > lineH * 1.6) {
      const [a, b] = [points[0], points.at(-1)!]
      return wordsBetween(words, { x: a[0], y: a[1] }, { x: b[0], y: b[1] })
    }
    const minX = Math.min(...points.map((p) => p[0]))
    const maxX = Math.max(...points.map((p) => p[0]))
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2
    const hit = words.filter((w) => w.x1 > minX && w.x0 < maxX && midY >= w.y0 - (w.y1 - w.y0) * 0.35 && midY <= w.y1 + (w.y1 - w.y0) * 0.35)
    // Ne garder que la ligne la plus proche du trait.
    if (!hit.length) return null
    const best = hit.reduce((a, b) => (Math.abs((a.y0 + a.y1) / 2 - midY) <= Math.abs((b.y0 + b.y1) / 2 - midY) ? a : b))
    return hit.filter((w) => w.line === best.line && w.page === best.page)
  }

  /**
   * Mots des zones de texte posées sur la page (repère du document), ligne par ligne, d'après
   * la mise en page calculée par Fabric. Textes tournés : ignorés (surlignage en biais).
   */
  private objectWords(page: Page): DocWord[] {
    const out: DocWord[] = []
    let line = 100000 // après les lignes du PDF et de l'OCR
    for (const o of this.ed.doc.content) {
      if (!isTextObject(o) || !o.visible || Math.abs(o.angle % 360) > 0.5) continue
      if (this.ed.doc.pageAt(o.getCenterPoint()) !== page) continue
      const t = o as IText & { __charBounds: { left: number; width: number }[][]; _getLineLeftOffset(i: number): number }
      const m = o.calcTransformMatrix()
      const at = (x: number, y: number): Point => util.transformPoint(new Point(x, y), m)
      let top = -o.height / 2
      t._textLines.forEach((chars, li) => {
        // Fabric : la dernière ligne ne compte pas l'interligne ; ailleurs, il s'ajoute au-dessus.
        const lh = t.lineHeight || 1
        const h = t.getHeightOfLine(li) / (li === t._textLines.length - 1 ? lh : 1)
        const fs = t.getHeightOfLine(li) / (lh * 1.13)
        const y0 = top + h - fs * 1.13
        const y1 = top + h - fs * 0.05
        const left = t._getLineLeftOffset(li) - o.width / 2
        const bounds = t.__charBounds[li] ?? []
        let start = -1
        const flush = (end: number): void => {
          if (start < 0) return
          const a = at(left + bounds[start].left, y0)
          const b = at(left + bounds[end - 1].left + bounds[end - 1].width, y1)
          out.push({ text: chars.slice(start, end).join(''), x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y), line, page, index: out.length })
          start = -1
        }
        chars.forEach((ch, i) => {
          if (/\s/.test(ch)) flush(i)
          else if (start < 0) start = i
        })
        flush(chars.length)
        line++
        top += h
      })
    }
    return out
  }

  private async apply(kind: MarkupKind): Promise<void> {
    const obj = buildMarkup(this.words, kind, kind === 'highlight' ? this.color : this.color === '#ffe600' ? '#e5484d' : this.color)
    if (!obj) return
    await this.ed.history.transaction(() => this.ed.add(obj))
    this.clear()
  }

  private paint(): void {
    const rects = lineRects(this.words)
    setOverlay('text-selection', (ctx) => {
      ctx.fillStyle = 'rgba(79,140,255,0.3)'
      for (const r of rects) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    })
  }

  private renderBar(): void {
    this.bar.replaceChildren()
    const add = (label: string, title: string, fn: () => void): void => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', fn)
      this.bar.append(b)
    }
    add('Copier', 'Copier le texte (Ctrl+C)', () => {
      void navigator.clipboard?.writeText(wordsText(this.words))
      this.ed.notify('Texte copié', 'success')
    })
    add('Surligner', 'Surligner le texte', () => void this.apply('highlight'))
    add('Souligner', 'Souligner le texte', () => void this.apply('underline'))
    add('Barrer', 'Barrer le texte', () => void this.apply('strike'))
    for (const c of MARKUP_COLORS) {
      const s = document.createElement('button')
      s.className = `swatch ${c === this.color ? 'active' : ''}`
      s.style.background = c
      s.title = 'Couleur'
      s.addEventListener('click', () => {
        this.color = c
        this.renderBar()
      })
      this.bar.append(s)
    }
  }

  private showBar(): void {
    const last = lineRects(this.words).at(-1)
    if (!last) return
    const p = util.transformPoint(new Point(last.x1, last.y1), this.ed.canvas.viewportTransform)
    this.bar.hidden = false
    const ws = document.getElementById('workspace')!.getBoundingClientRect()
    const w = this.bar.offsetWidth
    this.bar.style.left = `${Math.max(8, Math.min(ws.width - w - 8, p.x - w / 2))}px`
    this.bar.style.top = `${Math.min(ws.height - 50, p.y + 10)}px`
  }
}
