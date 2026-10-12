import { classRegistry, FabricObject, type TClassProperties } from 'fabric'
import '../core/props'

export type CellAlign = 'left' | 'center' | 'right'

export interface TableProps {
  cells: string[][]
  colWidths: number[]
  /** Hauteur minimale des lignes ; elles s'agrandissent pour contenir le texte. */
  minRowHeight: number
  fontFamily: string
  fontSize: number
  textColor: string
  textAlign: CellAlign
  borderColor: string
  borderWidth: number
  header: boolean
  headerFill: string
  /** Lignes alternées colorées (« bandes »). */
  banded: boolean
  bandFill: string
  padding: number
}

const TABLE_DEFAULTS: Omit<TableProps, 'cells' | 'colWidths'> = {
  minRowHeight: 22,
  fontFamily: 'Helvetica',
  fontSize: 11,
  textColor: '#1b1b1f',
  textAlign: 'left',
  borderColor: '#7f7f7f',
  borderWidth: 1,
  header: true,
  headerFill: '#dbe5f1',
  banded: false,
  bandFill: '#f2f2f2',
  padding: 5
}

const measureCtx = document.createElement('canvas').getContext('2d')!

/**
 * Tableau façon traitement de texte : cellules avec retour à la ligne automatique,
 * ligne d'en-tête, bordures. Redimensionner le tableau change la largeur des
 * colonnes sans déformer le texte. Double-clic sur une cellule pour l'éditer.
 */
export class Table extends FabricObject {
  static type = 'Table'
  declare cells: string[][]
  declare colWidths: number[]
  declare minRowHeight: number
  declare fontFamily: string
  declare fontSize: number
  declare textColor: string
  declare textAlign: CellAlign
  declare borderColor: string
  declare borderWidth: number
  declare header: boolean
  declare headerFill: string
  declare banded: boolean
  declare bandFill: string
  declare padding: number

  rowHeights: number[] = []
  private lines: string[][][] = []

  static ownDefaults = { ...TABLE_DEFAULTS, lockScalingFlip: true }

  static getDefaults(): Record<string, unknown> {
    return { ...super.getDefaults(), ...Table.ownDefaults }
  }

  constructor(options: Partial<TableProps> & Partial<TClassProperties<FabricObject>> = {}) {
    super()
    Object.assign(this, Table.getDefaults())
    this.setOptions(options)
    if (!this.cells) this.cells = [['', ''], ['', '']]
    if (!this.colWidths) this.colWidths = this.cells[0].map(() => 100)
    this.layout()
  }

  static create(rows: number, cols: number, width = 360): Table {
    return new Table({
      cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
      colWidths: Array.from({ length: cols }, () => width / cols)
    })
  }

  get rowCount(): number {
    return this.cells.length
  }

  get colCount(): number {
    return this.colWidths.length
  }

  /** Recalcule le retour à la ligne et la taille du tableau. */
  layout(): void {
    measureCtx.font = `${this.fontSize}px ${this.fontFamily}`
    const lineH = this.fontSize * 1.25
    this.lines = this.cells.map((row) => row.map((text, c) => wrap(text ?? '', this.colWidths[c] - this.padding * 2)))
    this.rowHeights = this.lines.map((row) =>
      Math.max(this.minRowHeight, ...row.map((ls) => ls.length * lineH + this.padding * 2))
    )
    this.set({ width: sum(this.colWidths), height: sum(this.rowHeights) })
    this.setCoords()
    this.dirty = true
  }

  /** Intègre une mise à l'échelle dans la largeur des colonnes (le texte garde sa taille). */
  bakeScale(): void {
    if (this.scaleX === 1 && this.scaleY === 1) return
    const sx = this.scaleX
    const sy = this.scaleY
    const center = this.getCenterPoint()
    this.colWidths = this.colWidths.map((w) => Math.max(24, w * sx))
    this.minRowHeight = Math.max(14, this.minRowHeight * sy)
    this.set({ scaleX: 1, scaleY: 1 })
    this.layout()
    this.setPositionByOrigin(center, 'center', 'center')
    this.setCoords()
  }

  /** Cellule sous un point local (origine au coin haut-gauche). */
  cellAt(x: number, y: number): { row: number; col: number } | null {
    let col = -1
    for (let c = 0, acc = 0; c < this.colCount; acc += this.colWidths[c], c++) if (x >= acc && x < acc + this.colWidths[c]) col = c
    let row = -1
    for (let r = 0, acc = 0; r < this.rowCount; acc += this.rowHeights[r], r++) if (y >= acc && y < acc + this.rowHeights[r]) row = r
    return row >= 0 && col >= 0 ? { row, col } : null
  }

  cellRect(row: number, col: number): { x: number; y: number; w: number; h: number } {
    return {
      x: sum(this.colWidths.slice(0, col)),
      y: sum(this.rowHeights.slice(0, row)),
      w: this.colWidths[col],
      h: this.rowHeights[row]
    }
  }

  setCell(row: number, col: number, text: string): void {
    this.cells[row][col] = text
    this.layout()
  }

  insertRow(at: number): void {
    this.cells.splice(at, 0, this.colWidths.map(() => ''))
    this.layout()
  }

  insertCol(at: number): void {
    const w = this.width / this.colCount
    this.colWidths.splice(at, 0, w)
    this.cells.forEach((row) => row.splice(at, 0, ''))
    this.layout()
  }

  deleteRow(at: number): void {
    if (this.rowCount <= 1) return
    this.cells.splice(at, 1)
    this.layout()
  }

  deleteCol(at: number): void {
    if (this.colCount <= 1) return
    this.colWidths.splice(at, 1)
    this.cells.forEach((row) => row.splice(at, 1))
    this.layout()
  }

  private fillFor(r: number): string | null {
    if (this.header && r === 0) return this.headerFill
    if (this.banded && (r - (this.header ? 1 : 0)) % 2 === 1) return this.bandFill
    return null
  }

  private textX(c: number, x: number, lineW: number): number {
    if (this.textAlign === 'center') return x + (this.colWidths[c] - lineW) / 2
    if (this.textAlign === 'right') return x + this.colWidths[c] - this.padding - lineW
    return x + this.padding
  }

  _render(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    ctx.translate(-this.width / 2, -this.height / 2)
    const lineH = this.fontSize * 1.25
    let y = 0
    this.rowHeights.forEach((h, r) => {
      const fill = this.fillFor(r)
      if (fill) {
        ctx.fillStyle = fill
        ctx.fillRect(0, y, this.width, h)
      }
      let x = 0
      this.colWidths.forEach((w, c) => {
        ctx.font = `${this.header && r === 0 ? 'bold ' : ''}${this.fontSize}px ${this.fontFamily}`
        ctx.fillStyle = this.textColor
        ctx.textBaseline = 'alphabetic'
        this.lines[r][c].forEach((line, i) => {
          const lw = ctx.measureText(line).width
          ctx.fillText(line, this.textX(c, x, lw), y + this.padding + this.fontSize * 0.95 + i * lineH)
        })
        x += w
      })
      y += h
    })
    ctx.strokeStyle = this.borderColor
    ctx.lineWidth = this.borderWidth
    ctx.beginPath()
    for (let r = 0, yy = 0; r <= this.rowCount; yy += this.rowHeights[r] ?? 0, r++) {
      ctx.moveTo(0, yy)
      ctx.lineTo(this.width, yy)
    }
    for (let c = 0, xx = 0; c <= this.colCount; xx += this.colWidths[c] ?? 0, c++) {
      ctx.moveTo(xx, 0)
      ctx.lineTo(xx, this.height)
    }
    ctx.stroke()
    ctx.restore()
  }

  _toSVG(): string[] {
    const out: string[] = [`<g transform="translate(${-this.width / 2} ${-this.height / 2})">\n`]
    const lineH = this.fontSize * 1.25
    measureCtx.font = `${this.fontSize}px ${this.fontFamily}`
    let y = 0
    this.rowHeights.forEach((h, r) => {
      const fill = this.fillFor(r)
      if (fill) out.push(`<rect x="0" y="${y}" width="${this.width}" height="${h}" fill="${fill}"/>\n`)
      let x = 0
      this.colWidths.forEach((w, c) => {
        const bold = this.header && r === 0
        measureCtx.font = `${bold ? 'bold ' : ''}${this.fontSize}px ${this.fontFamily}`
        this.lines[r][c].forEach((line, i) => {
          const tx = this.textX(c, x, measureCtx.measureText(line).width)
          out.push(
            `<text x="${tx}" y="${y + this.padding + this.fontSize * 0.95 + i * lineH}" font-family="${this.fontFamily}" font-size="${this.fontSize}" font-weight="${bold ? 'bold' : 'normal'}" fill="${this.textColor}" xml:space="preserve">${escapeXml(line)}</text>\n`
          )
        })
        x += w
      })
      y += h
    })
    const stroke = `stroke="${this.borderColor}" stroke-width="${this.borderWidth}"`
    for (let r = 0, yy = 0; r <= this.rowCount; yy += this.rowHeights[r] ?? 0, r++)
      out.push(`<line x1="0" y1="${yy}" x2="${this.width}" y2="${yy}" ${stroke}/>\n`)
    for (let c = 0, xx = 0; c <= this.colCount; xx += this.colWidths[c] ?? 0, c++)
      out.push(`<line x1="${xx}" y1="0" x2="${xx}" y2="${this.height}" ${stroke}/>\n`)
    out.push('</g>\n')
    return out
  }

  toObject(propertiesToInclude: string[] = []): ReturnType<FabricObject['toObject']> {
    return super.toObject([
      ...propertiesToInclude,
      'cells', 'colWidths', 'minRowHeight', 'fontFamily', 'fontSize', 'textColor', 'textAlign',
      'borderColor', 'borderWidth', 'header', 'headerFill', 'banded', 'bandFill', 'padding'
    ] as never[])
  }

  static async fromObject(object: Record<string, unknown>): Promise<Table> {
    const { type: _type, ...options } = object
    return new Table(structuredClone(options) as Partial<TableProps>)
  }
}

classRegistry.setClass(Table)

function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Retour à la ligne par mots (les mots trop longs sont coupés). */
function wrap(text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const candidate = line + word
      if (measureCtx.measureText(candidate).width <= maxWidth || line === '') {
        if (measureCtx.measureText(candidate).width > maxWidth && line === '') {
          // mot plus long que la cellule : coupe par caractères
          let chunk = ''
          for (const ch of word) {
            if (measureCtx.measureText(chunk + ch).width > maxWidth && chunk) {
              out.push(chunk)
              chunk = ''
            }
            chunk += ch
          }
          line = chunk
        } else line = candidate
      } else {
        out.push(line.trimEnd())
        line = word.trimStart()
      }
    }
    out.push(line.trimEnd())
  }
  return out
}
