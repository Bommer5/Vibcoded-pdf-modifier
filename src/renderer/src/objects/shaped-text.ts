import { classRegistry, Textbox, type TOptions, type TextboxProps } from 'fabric'

type Pt = [number, number]
interface Span {
  x: number
  w: number
}

/**
 * Zone de texte de forme libre : on entoure une zone à la main (rond, nuage,
 * forme autour d'un dessin…) et le texte s'écoule à l'intérieur, ligne par ligne,
 * sans avoir à jouer avec les espaces. Alignements, gras, couleurs… comme un texte normal.
 *
 * `contour` : polygone en coordonnées locales (origine au coin haut-gauche de la zone).
 */
export class ShapedText extends Textbox {
  static type = 'ShapedText'
  declare contour: Pt[]
  /** Contour visible (vide = invisible, affiché en pointillés seulement à l'édition). */
  declare contourStroke: string
  declare contourFill: string
  declare contourHeight: number
  private spans: Span[] = []
  /** Décalage vertical du texte : la première ligne commence là où la forme est assez large. */
  private topInset = 0

  constructor(text: string, options: Partial<TOptions<TextboxProps>> & { contour?: Pt[]; contourStroke?: string; contourFill?: string } = {}) {
    super(text, { contourStroke: '', contourFill: '', ...options } as never)
    this.initDimensions()
  }

  /** Crée une zone à partir d'un tracé en coordonnées document. */
  static fromOutline(points: Pt[], opts: Partial<TOptions<TextboxProps>>): ShapedText {
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const contour = simplify(points.map(([x, y]) => [x - left, y - top] as Pt), 1.5)
    return new ShapedText('', {
      ...opts,
      left,
      top,
      width: Math.max(...xs) - left,
      contour,
      contourHeight: Math.max(...ys) - top
    } as never)
  }

  private lineBand(): number {
    return this.fontSize * this.lineHeight * this._fontSizeMult
  }

  /** Zone horizontale disponible pour la ligne graphique `i`. */
  private spanFor(i: number): Span {
    if (!this.contour?.length) return { x: 0, w: this.width }
    const band = this.lineBand()
    const y0 = this.topInset + i * band
    const pad = this.fontSize * 0.15
    let best: Span | null = null
    // L'intervalle doit être libre sur toute la hauteur de la ligne : on intersecte plusieurs coupes.
    const samples = [0.1, 0.5, 0.9].map((f) => intervalsAt(this.contour, y0 + band * f))
    for (const [a, b] of samples[0]) {
      let lo = a
      let hi = b
      for (const others of samples.slice(1)) {
        const hit = others.find(([c, d]) => d > lo && c < hi)
        if (!hit) {
          hi = lo
          break
        }
        lo = Math.max(lo, hit[0])
        hi = Math.min(hi, hit[1])
      }
      const w = hi - lo - pad * 2
      if (w > 0 && (!best || w > best.w)) best = { x: lo + pad, w }
    }
    if (best && best.w >= this.fontSize * 1.2) return best
    // En dessous de la forme (trop de texte) : on continue sur toute la largeur.
    if (y0 + band >= (this.contourHeight ?? 0)) return { x: 0, w: this.width }
    return { x: best?.x ?? this.width / 2, w: 0 }
  }

  initDimensions(): void {
    this.topInset = this.findTopInset()
    super.initDimensions()
    if (this.contourHeight) this.height = Math.max(this.height + this.topInset, this.contourHeight)
  }

  _getTopOffset(): number {
    return -this.height / 2 + this.topInset
  }

  private findTopInset(): number {
    if (!this.contour?.length || !this.contourHeight) return 0
    const band = this.fontSize * (this.lineHeight ?? 1.16) * (this._fontSizeMult ?? 1.13)
    for (let y = 0; y + band < this.contourHeight; y += band / 4) {
      this.topInset = y
      if (this.spanFor(0).w >= this.fontSize * 4) return y
    }
    return 0
  }

  _wrapText(lines: string[], _desiredWidth: number): string[][] {
    this.isWrapping = true
    const data = this.getGraphemeDataForRender(lines)
    const out: string[][] = []
    this.spans = []
    const additional = this._getWidthOfCharSpacing()
    for (let p = 0; p < data.wordsData.length; p++) {
      const words = data.wordsData[p]
      let line: string[] = []
      let width = 0
      let started = true
      let offset = 0
      let span = this.spanFor(out.length)
      for (const { word, width: ww } of words) {
        const space = started ? 0 : this._measureWord([' '], p, offset)
        if (!started && width + space + ww > span.w) {
          out.push(line)
          this.spans.push(span)
          span = this.spanFor(out.length)
          line = []
          width = 0
          started = true
        }
        if (!started) {
          line.push(' ')
          width += this._measureWord([' '], p, offset) + additional
        }
        line = line.concat(word)
        width += ww + additional
        offset += word.length + 1
        started = false
      }
      out.push(line)
      this.spans.push(span)
    }
    this.isWrapping = false
    return out
  }

  _getLineLeftOffset(lineIndex: number): number {
    const span = this.spans[lineIndex] ?? { x: 0, w: this.width }
    const diff = span.w - this.getLineWidth(lineIndex)
    switch (this.textAlign) {
      case 'center':
        return span.x + diff / 2
      case 'right':
        return span.x + diff
      default:
        return span.x
    }
  }

  /** Justification ligne par ligne, sur la largeur propre à chaque ligne (sauf fin de paragraphe). */
  enlargeSpaces(): void {
    for (let i = 0; i < this._textLines.length; i++) {
      if (this.isEndOfWrapping(i)) continue
      const span = this.spans[i]
      const current = this.getLineWidth(i)
      const spaces = this.textLines[i].match(this._reSpacesAndTabs)
      if (!span || current >= span.w || !spaces) continue
      const diff = (span.w - current) / spaces.length
      let acc = 0
      const line = this._textLines[i]
      for (let j = 0; j <= line.length; j++) {
        const bound = this.__charBounds[i][j]
        if (this._reSpaceAndTab.test(line[j])) {
          bound.width += diff
          bound.kernedWidth += diff
          bound.left += acc
          acc += diff
        } else bound.left += acc
      }
    }
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const showGuide = !this.contourStroke && (this.isEditing || this.canvas?.getActiveObject() === this || !this.text)
    if (this.contour?.length && (this.contourStroke || this.contourFill || showGuide)) {
      ctx.save()
      ctx.translate(-this.width / 2, -this.height / 2)
      ctx.beginPath()
      this.contour.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      if (this.contourFill) {
        ctx.fillStyle = this.contourFill
        ctx.fill()
      }
      if (this.contourStroke) {
        ctx.strokeStyle = this.contourStroke
        ctx.lineWidth = 1.5
        ctx.stroke()
      } else if (showGuide) {
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = '#4f8cff'
        ctx.lineWidth = 1 / (this.canvas?.getZoom() ?? 1)
        ctx.stroke()
      }
      ctx.restore()
    }
    super._render(ctx)
  }

  _toSVG(): string[] {
    const markup = super._toSVG()
    if (this.contour?.length && (this.contourStroke || this.contourFill)) {
      const d = this.contour.map(([x, y], i) => `${i ? 'L' : 'M'} ${x - this.width / 2} ${y - this.height / 2}`).join(' ') + ' Z'
      markup.unshift(`<path d="${d}" fill="${this.contourFill || 'none'}" stroke="${this.contourStroke || 'none'}" stroke-width="1.5"/>\n`)
    }
    return markup
  }
}

classRegistry.setClass(ShapedText)

/** Intervalles [x1, x2] intérieurs au polygone sur la droite horizontale y. */
function intervalsAt(poly: Pt[], y: number): [number, number][] {
  const xs: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
  }
  xs.sort((a, b) => a - b)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]])
  return out
}

/** Simplification Ramer-Douglas-Peucker (tracé à main levée → polygone léger). */
function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts
  const sq = tolerance * tolerance
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let max = 0
    let idx = -1
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy || 1
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len))
      const ex = ax + t * dx - pts[i][0]
      const ey = ay + t * dy - pts[i][1]
      const d = ex * ex + ey * ey
      if (d > max) {
        max = d
        idx = i
      }
    }
    if (max > sq && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}
