import { Point, util } from 'fabric'
import type { Editor } from '../core/editor'
import { Table } from './table'

/**
 * Édition des cellules : double-clic sur une cellule → zone de saisie posée
 * exactement dessus. Tab / Maj+Tab : cellule suivante / précédente,
 * Entrée : valider (Maj+Entrée = retour à la ligne), Échap : annuler.
 * Tab dans la dernière cellule ajoute une ligne, comme dans Word.
 */
export class TableEditor {
  private input = document.createElement('textarea')
  private current: { table: Table; row: number; col: number } | null = null
  /** Dernière cellule utilisée par tableau (pour « insérer une ligne / colonne »). */
  readonly lastCell = new WeakMap<Table, { row: number; col: number }>()

  constructor(private ed: Editor) {
    this.input.className = 'cell-editor'
    this.input.hidden = true
    ed.canvas.upperCanvasEl.parentElement!.append(this.input)

    ed.canvas.on('mouse:dblclick', (o) => {
      if (!(o.target instanceof Table)) return
      const local = this.toLocal(o.target, o.scenePoint)
      const cell = o.target.cellAt(local.x, local.y)
      if (cell) this.open(o.target, cell.row, cell.col)
    })
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    this.input.addEventListener('blur', () => this.commit())
    ed.canvas.on('after:render', () => this.position())
  }

  /** Point document → coordonnées du tableau (origine au coin haut-gauche). */
  private toLocal(table: Table, p: Point): Point {
    const q = util.transformPoint(p, util.invertTransform(table.calcTransformMatrix()))
    return new Point(q.x + table.width / 2, q.y + table.height / 2)
  }

  open(table: Table, row: number, col: number): void {
    this.commit()
    this.current = { table, row, col }
    this.lastCell.set(table, { row, col })
    this.input.value = table.cells[row][col]
    this.input.hidden = false
    this.position()
    this.input.focus()
    this.input.select()
  }

  private position(): void {
    if (!this.current) return
    const { table, row, col } = this.current
    const r = table.cellRect(row, col)
    const m = util.multiplyTransformMatrices(this.ed.canvas.viewportTransform, table.calcTransformMatrix())
    const tl = util.transformPoint(new Point(r.x - table.width / 2, r.y - table.height / 2), m)
    const br = util.transformPoint(new Point(r.x + r.w - table.width / 2, r.y + r.h - table.height / 2), m)
    const zoom = Math.hypot(m[0], m[1])
    Object.assign(this.input.style, {
      left: `${Math.min(tl.x, br.x)}px`,
      top: `${Math.min(tl.y, br.y)}px`,
      width: `${Math.abs(br.x - tl.x)}px`,
      height: `${Math.abs(br.y - tl.y)}px`,
      font: `${table.header && row === 0 ? 'bold ' : ''}${table.fontSize * zoom}px ${table.fontFamily}`,
      padding: `${table.padding * zoom}px`,
      textAlign: table.textAlign,
      lineHeight: '1.25'
    })
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.current) return
    const { table, row, col } = this.current
    if (e.key === 'Escape') {
      e.preventDefault()
      this.current = null
      this.input.hidden = true
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      this.commit()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      let next = row * table.colCount + col + (e.shiftKey ? -1 : 1)
      if (next >= table.rowCount * table.colCount) {
        this.commit()
        this.ed.history.transaction(() => table.insertRow(table.rowCount))
        this.ed.canvas.requestRenderAll()
      }
      next = Math.max(0, next)
      this.open(table, Math.floor(next / table.colCount), next % table.colCount)
    }
  }

  commit(): void {
    const cur = this.current
    if (!cur) return
    this.current = null
    this.input.hidden = true
    if (cur.table.cells[cur.row]?.[cur.col] === this.input.value) return
    void this.ed.history.transaction(() => cur.table.setCell(cur.row, cur.col, this.input.value))
    this.ed.canvas.requestRenderAll()
  }
}
