import { ActiveSelection, Group, type FabricObject, type IText } from 'fabric'
import { editChart } from '../charts/chart-dialog'
import { chartObject, isChart } from '../charts/chart-object'
import type { Editor } from '../core/editor'
import { ShapedText } from '../objects/shaped-text'
import { Table, type CellAlign } from '../objects/table'
import type { TableEditor } from '../objects/table-editor'
import { buildInk, scenePoints, type InkObject } from '../tools/ink'
import type { Tool, ToolManager } from '../tools/manager'
import { dashArray, settings, SWATCHES, type LineStyle, type ShapeKind, type ToolSettings } from '../tools/settings'

export const FONTS = [
  'Helvetica', 'Arial', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New',
  'Verdana', 'Trebuchet MS', 'Calibri', 'Cambria', 'Comic Sans MS'
]
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72]

type TextObj = IText & { underline: boolean; linethrough: boolean }
const isText = (o: FabricObject): o is TextObj => 'text' in o && typeof (o as IText).enterEditing === 'function'

/**
 * Panneau Propriétés (à droite) : s'adapte à ce qui est sélectionné
 * (texte, forme, trait, tableau, graphique) ou, sans sélection, à l'outil actif.
 */
export class PropertiesPanel {
  private root = document.getElementById('properties') as HTMLElement

  constructor(
    private ed: Editor,
    private tools: ToolManager,
    private tableEditor: TableEditor
  ) {
    const c = ed.canvas
    const refresh = (): void => this.render()
    c.on('selection:created', refresh)
    c.on('selection:updated', refresh)
    c.on('selection:cleared', refresh)
    c.on('text:selection:changed', refresh)
    c.on('text:editing:entered', refresh)
    c.on('text:editing:exited', refresh)
    tools.onChange(refresh)
    settings.onChange(() => {
      if (c.getActiveObjects().length === 0) this.render()
    })
    // Ctrl+B / Ctrl+I / Ctrl+U pendant la saisie d'un texte, comme dans Word.
    window.addEventListener(
      'keydown',
      (e) => {
        const t = c.getActiveObject()
        if (!(e.ctrlKey || e.metaKey) || !t || !isText(t) || !t.isEditing) return
        const key = e.key.toLowerCase()
        if (!['b', 'i', 'u'].includes(key)) return
        e.preventDefault()
        e.stopPropagation()
        this.toggleTextStyle(t, key as 'b' | 'i' | 'u')
      },
      { capture: true }
    )
    this.render()
  }

  private toggleTextStyle(t: TextObj, key: 'b' | 'i' | 'u'): void {
    const ranged = t.selectionStart !== t.selectionEnd
    const current = ranged ? (t.getSelectionStyles(t.selectionStart, t.selectionEnd)[0] ?? {}) : {}
    const read = (k: string): unknown => (current as Record<string, unknown>)[k] ?? (t as unknown as Record<string, unknown>)[k]
    const props =
      key === 'b'
        ? { fontWeight: read('fontWeight') === 'bold' ? 'normal' : 'bold' }
        : key === 'i'
          ? { fontStyle: read('fontStyle') === 'italic' ? 'normal' : 'italic' }
          : { underline: !read('underline') }
    if (ranged) t.setSelectionStyles(props)
    else t.set(props)
    t.initDimensions()
    this.ed.canvas.requestRenderAll()
    this.ed.history.record()
    this.render()
  }

  render(): void {
    const sel = this.ed.canvas.getActiveObjects()
    this.root.replaceChildren()
    if (sel.length === 0) return this.renderTool(this.tools.tool)

    const texts = sel.filter(isText)
    const tables = sel.filter((o): o is Table => o instanceof Table)
    const chart = sel.length === 1 && isChart(sel[0]) ? sel[0] : null

    if (texts.length) this.textSection(texts)
    if (tables.length === 1) this.tableSection(tables[0])
    if (chart) {
      this.section('Graphique')
      this.button('Modifier le graphique…', () => this.editChart(chart), 'primary wide')
    }
    const drawables = sel.filter((o) => !isText(o) && !(o instanceof Table) && !isChart(o) && !(o as { assetId?: string }).assetId)
    if (drawables.length) this.strokeSection(drawables)
    this.section('Calque')
    this.slider('Opacité', 0, 100, Math.round((sel[0].opacity ?? 1) * 100), (v) => this.apply(sel, (o) => o.set({ opacity: v / 100 })), '%')
  }

  // --- Outils (sans sélection) --------------------------------------------------------

  private renderTool(tool: Tool): void {
    const v = settings.value
    const set = <K extends keyof ToolSettings>(k: K) => (val: ToolSettings[K]) => settings.set(k, val)
    switch (tool) {
      case 'pen':
        this.section('Stylo')
        this.colors(v.penColor, set('penColor'))
        this.slider('Épaisseur', 0.5, 20, v.penWidth, set('penWidth'), ' pt', 0.5)
        this.lineStyle(v.penStyle, set('penStyle'))
        this.toggle('Sensible à la pression', v.pressure, set('pressure'))
        this.hint('Maintenez Maj, ou gardez le stylet immobile en fin de trait, pour une ligne droite.')
        break
      case 'highlighter':
        this.section('Surligneur')
        this.colors(v.highlighterColor, set('highlighterColor'), ['#ffe600', '#7cf06b', '#5ad1ff', '#ff8ad8', '#ffb347', '#c39bff'])
        this.slider('Épaisseur', 4, 40, v.highlighterWidth, set('highlighterWidth'), ' pt')
        this.hint('Maj = trait bien droit, idéal pour surligner une ligne de texte.')
        break
      case 'eraser':
        this.section('Gomme')
        this.choice<'partial' | 'stroke'>('Mode', v.eraserMode, [['partial', 'Partielle'], ['stroke', 'Trait entier']], set('eraserMode'))
        this.slider('Taille', 6, 80, v.eraserSize, set('eraserSize'), ' px')
        this.hint('Le bout gomme du stylet est reconnu automatiquement. Images et textes ne sont jamais effacés par la gomme.')
        break
      case 'shape':
        this.section('Formes')
        this.choice<ShapeKind>('Forme', v.shape, [['line', '╱ Ligne'], ['arrow', '→ Flèche'], ['rect', '▭ Rectangle'], ['ellipse', '◯ Ellipse'], ['triangle', '△ Triangle']], set('shape'))
        this.label('Contour')
        this.colors(v.shapeStroke, set('shapeStroke'))
        this.label('Remplissage')
        this.colors(v.shapeFill, set('shapeFill'), SWATCHES, true)
        this.slider('Épaisseur', 0.5, 20, v.shapeWidth, set('shapeWidth'), ' pt', 0.5)
        this.lineStyle(v.shapeStyle, set('shapeStyle'))
        this.hint('Maj : carré, cercle, ou ligne aimantée tous les 15°.')
        break
      case 'text':
        this.section('Texte')
        this.select('Police', FONTS, v.fontFamily, set('fontFamily'))
        this.select('Taille', SIZES.map(String), String(v.fontSize), (s) => settings.set('fontSize', Number(s)))
        this.colors(v.textColor, set('textColor'))
        this.hint('Cliquez sur la page pour écrire.')
        break
      case 'table':
        this.section('Tableau')
        this.slider('Lignes', 1, 30, v.tableRows, set('tableRows'), '')
        this.slider('Colonnes', 1, 12, v.tableCols, set('tableCols'), '')
        this.hint('Cliquez sur la page pour placer le tableau. Double-clic sur une cellule pour écrire, Tab pour passer à la suivante.')
        break
      default:
        this.section('Astuces')
        this.hint('Cliquez-glissez pour sélectionner. Glissez la sélection pour la déplacer.')
        this.hint('Ctrl+C puis Ctrl+V colle sous le pointeur. Espace maintenu = déplacer la vue.')
    }
  }

  // --- Texte (façon Word) ----------------------------------------------------------------

  private textSection(texts: TextObj[]): void {
    const t = texts[0]
    const editing = t.isEditing && t.selectionStart !== t.selectionEnd
    const styleAt = editing ? (t.getSelectionStyles(t.selectionStart, t.selectionEnd)[0] ?? {}) : {}
    const get = <K extends string>(k: K): unknown => (styleAt as Record<string, unknown>)[k] ?? (t as unknown as Record<string, unknown>)[k]

    /** Applique un style : à la portion sélectionnée en cours d'édition, sinon à tout le texte. */
    const style = (props: Record<string, unknown>): void =>
      this.apply(texts, (o) => {
        const obj = o as TextObj
        if (obj.isEditing && obj.selectionStart !== obj.selectionEnd) obj.setSelectionStyles(props)
        else {
          for (const k of Object.keys(props)) obj.removeStyle(k as never)
          obj.set(props)
        }
        obj.initDimensions?.()
      })

    this.section('Texte')
    this.select('Police', FONTS, String(get('fontFamily')), (f) => style({ fontFamily: f }))
    this.select('Taille', SIZES.map(String), String(Math.round(Number(get('fontSize')))), (s) => style({ fontSize: Number(s) }), true)

    const row = this.row()
    this.iconToggle(row, 'G', 'Gras (Ctrl+B)', get('fontWeight') === 'bold', (on) => style({ fontWeight: on ? 'bold' : 'normal' }), 'bold')
    this.iconToggle(row, 'I', 'Italique (Ctrl+I)', get('fontStyle') === 'italic', (on) => style({ fontStyle: on ? 'italic' : 'normal' }), 'italic')
    this.iconToggle(row, 'S', 'Souligné (Ctrl+U)', !!get('underline'), (on) => style({ underline: on }), 'underline')
    this.iconToggle(row, 'ab', 'Barré', !!get('linethrough'), (on) => style({ linethrough: on }), 'strike')

    this.label('Alignement')
    const align = this.row()
    for (const [id, label, title] of [
      ['left', '⇤', 'Aligner à gauche'],
      ['center', '↔', 'Centrer'],
      ['right', '⇥', 'Aligner à droite'],
      ['justify-left', '☰', 'Justifier']
    ] as const) {
      this.iconToggle(align, label, title, t.textAlign === id, () => this.apply(texts, (o) => o.set({ textAlign: id })))
    }
    this.select('Interligne', ['1', '1.15', '1.25', '1.5', '2', '2.5', '3'], String(Math.round(t.lineHeight * 100) / 100), (s) =>
      this.apply(texts, (o) => o.set({ lineHeight: Number(s) }))
    )
    this.label('Couleur du texte')
    this.colors(String(get('fill')), (c) => style({ fill: c }))
    this.label('Surlignage')
    this.colors(String(get('textBackgroundColor') || 'transparent'), (c) => style({ textBackgroundColor: c === 'transparent' ? '' : c }), ['#ffe600', '#7cf06b', '#5ad1ff', '#ff8ad8', '#ffb347'], true)

    const shaped = (texts as unknown[]).filter((o): o is ShapedText => o instanceof ShapedText)
    if (shaped.length) {
      this.section('Forme de la zone')
      this.label('Contour')
      this.colors(shaped[0].contourStroke || 'transparent', (c) => this.apply(shaped, (o) => o.set({ contourStroke: c === 'transparent' ? '' : c })), SWATCHES, true)
      this.label('Fond')
      this.colors(shaped[0].contourFill || 'transparent', (c) => this.apply(shaped, (o) => o.set({ contourFill: c === 'transparent' ? '' : c })), ['#fff8c5', '#e2f0ff', '#e6f7e6', '#ffe4ec', '#f2f2f2'], true)
      this.hint('Le texte suit la forme dessinée. Sans contour, la forme n’apparaît qu’en pointillés pendant l’édition.')
    } else {
      this.hint('Astuce : avec l’outil Texte, entourez une zone à main levée pour que le texte épouse sa forme.')
    }
  }

  // --- Tableau -------------------------------------------------------------------------

  private tableSection(table: Table): void {
    const cell = this.tableEditor.lastCell.get(table) ?? { row: table.rowCount - 1, col: table.colCount - 1 }
    const edit = (fn: () => void): void => this.apply([table], () => fn())
    this.section('Tableau')
    const r1 = this.row()
    this.miniButton(r1, '+ Ligne', 'Insérer une ligne sous la cellule active', () => edit(() => table.insertRow(cell.row + 1)))
    this.miniButton(r1, '+ Colonne', 'Insérer une colonne à droite', () => edit(() => table.insertCol(cell.col + 1)))
    const r2 = this.row()
    this.miniButton(r2, '− Ligne', 'Supprimer la ligne active', () => edit(() => table.deleteRow(cell.row)))
    this.miniButton(r2, '− Colonne', 'Supprimer la colonne active', () => edit(() => table.deleteCol(cell.col)))
    this.select('Taille du texte', SIZES.map(String), String(table.fontSize), (s) =>
      edit(() => {
        table.fontSize = Number(s)
        table.layout()
      })
    )
    this.label('Alignement')
    const align = this.row()
    for (const [id, label] of [['left', '⇤'], ['center', '↔'], ['right', '⇥']] as [CellAlign, string][]) {
      this.iconToggle(align, label, id, table.textAlign === id, () => edit(() => (table.textAlign = id)))
    }
    this.toggle('Ligne d’en-tête', table.header, (on) => edit(() => (table.header = on)))
    this.toggle('Lignes alternées', table.banded, (on) => edit(() => (table.banded = on)))
    this.label('Couleur d’en-tête')
    this.colors(table.headerFill, (c) => edit(() => (table.headerFill = c)), ['#dbe5f1', '#fce4d6', '#e2efda', '#fff2cc', '#ededed', '#4472c4'])
    this.label('Bordures')
    this.colors(table.borderColor, (c) => edit(() => (table.borderColor = c)))
    this.hint('Double-clic sur une cellule pour écrire. Redimensionnez le tableau avec les poignées : le texte garde sa taille.')
  }

  // --- Traits et formes ------------------------------------------------------------------

  private strokeSection(objs: FabricObject[]): void {
    const o = objs[0]
    const ink = (o as InkObject).ink
    const isGroup = o instanceof Group && !(o instanceof ActiveSelection)
    this.section(ink ? (ink.tool === 'highlighter' ? 'Surlignage' : 'Trait') : 'Forme')
    const strokeColor = ink ? ink.color : String(o.stroke ?? '#000000')
    this.label(ink ? 'Couleur' : 'Contour')
    this.colors(strokeColor, (c) => this.restyle(objs, { color: c }))
    if (!ink && !isGroup && (o as { shape?: string }).shape !== 'line' && (o as { shape?: string }).shape !== 'arrow') {
      this.label('Remplissage')
      this.colors(String(o.fill || 'transparent'), (c) => this.apply(objs, (x) => x.set({ fill: c === 'transparent' ? '' : c })), SWATCHES, true)
    }
    const width = ink ? ink.size * ((Math.abs(o.scaleX) + Math.abs(o.scaleY)) / 2) : o.strokeWidth
    this.slider('Épaisseur', 0.5, ink?.tool === 'highlighter' ? 40 : 20, Math.round(width * 2) / 2, (w) => this.restyle(objs, { size: w }), ' pt', 0.5)
    if (!ink || ink.tool === 'pen') {
      const current: LineStyle = ink ? ink.style : o.strokeDashArray ? (o.strokeDashArray[0] < 0.01 ? 'dotted' : 'dashed') : 'solid'
      this.lineStyle(current, (s) => this.restyle(objs, { style: s }))
    }
  }

  /** Change couleur / épaisseur / style ; les traits d'encre sont reconstruits. */
  private restyle(objs: FabricObject[], change: { color?: string; size?: number; style?: LineStyle }): void {
    const c = this.ed.canvas
    void this.ed.history.transaction(() => {
      const replaced: FabricObject[] = []
      for (const o of objs) {
        const ink = (o as InkObject).ink
        if (ink) {
          const scale = (Math.abs(o.scaleX) + Math.abs(o.scaleY)) / 2
          const next = buildInk({
            ...ink,
            points: scenePoints(o as InkObject),
            size: change.size ?? ink.size * scale,
            color: change.color ?? ink.color,
            style: change.style ?? ink.style
          })
          next.set({ opacity: o.opacity })
          const index = c.getObjects().indexOf(o)
          c.remove(o)
          c.insertAt(index, next)
          replaced.push(next)
        } else {
          const width = change.size ?? o.strokeWidth
          const style = change.style ?? (o.strokeDashArray ? (o.strokeDashArray[0] < 0.01 ? 'dotted' : 'dashed') : 'solid')
          o.set({ stroke: change.color ?? o.stroke, strokeWidth: width, strokeDashArray: dashArray(style, width) })
          if (o instanceof Group) o.forEachObject((child) => child.set({ stroke: change.color ?? child.stroke }))
          replaced.push(o)
        }
      }
      c.discardActiveObject()
      c.setActiveObject(replaced.length === 1 ? replaced[0] : new ActiveSelection(replaced, { canvas: c }))
    })
    c.requestRenderAll()
    this.render()
  }

  private apply(objs: FabricObject[], fn: (o: FabricObject) => void): void {
    objs.forEach((o) => {
      fn(o)
      o.setCoords()
      o.dirty = true
    })
    this.ed.canvas.requestRenderAll()
    this.ed.history.record()
    this.render()
  }

  private async editChart(chart: FabricObject & { chart?: import('../charts/chart').ChartSpec }): Promise<void> {
    const spec = await editChart(chart.chart!)
    if (!spec) return
    const next = await chartObject(spec)
    const c = this.ed.canvas
    next.set({ angle: chart.angle, opacity: chart.opacity })
    next.scaleToWidth(chart.getScaledWidth())
    next.setPositionByOrigin(chart.getCenterPoint(), 'center', 'center')
    await this.ed.history.transaction(() => {
      const index = c.getObjects().indexOf(chart)
      c.remove(chart)
      c.insertAt(index, next)
      c.setActiveObject(next)
    })
    c.requestRenderAll()
  }

  // --- Petits composants -------------------------------------------------------------------

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text) e.textContent = text
    return e
  }

  private section(title: string): void {
    this.root.append(this.el('h3', 'prop-title', title))
  }

  private label(text: string): void {
    this.root.append(this.el('div', 'prop-label', text))
  }

  private hint(text: string): void {
    this.root.append(this.el('p', 'prop-hint', text))
  }

  private row(): HTMLElement {
    const r = this.el('div', 'prop-row')
    this.root.append(r)
    return r
  }

  private button(text: string, onClick: () => void, cls = ''): void {
    const b = this.el('button', cls, text)
    b.type = 'button'
    b.addEventListener('click', onClick)
    this.root.append(b)
  }

  private miniButton(row: HTMLElement, text: string, title: string, onClick: () => void): void {
    const b = this.el('button', 'prop-mini', text)
    b.type = 'button'
    b.title = title
    b.addEventListener('click', onClick)
    row.append(b)
  }

  private iconToggle(row: HTMLElement, text: string, title: string, on: boolean, onChange: (on: boolean) => void, cls = ''): void {
    const b = this.el('button', `prop-icon ${cls} ${on ? 'active' : ''}`, text)
    b.type = 'button'
    b.title = title
    b.setAttribute('aria-pressed', String(on))
    // mousedown + preventDefault : garde la sélection de texte en cours d'édition.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => onChange(!on))
    row.append(b)
  }

  private colors(current: string, onPick: (c: string) => void, swatches = SWATCHES, allowNone = false): void {
    const wrap = this.el('div', 'swatches')
    const all = allowNone ? ['transparent', ...swatches] : swatches
    for (const c of all) {
      const b = this.el('button', `swatch ${c.toLowerCase() === current.toLowerCase() ? 'active' : ''} ${c === 'transparent' ? 'none' : ''}`)
      b.type = 'button'
      b.title = c === 'transparent' ? 'Aucun' : c
      if (c !== 'transparent') b.style.background = c
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => onPick(c))
      wrap.append(b)
    }
    const custom = this.el('input', 'swatch-custom')
    custom.type = 'color'
    custom.title = 'Autre couleur…'
    custom.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'
    custom.addEventListener('change', () => onPick(custom.value))
    wrap.append(custom)
    this.root.append(wrap)
  }

  private slider(label: string, min: number, max: number, value: number, onChange: (v: number) => void, unit: string, step = 1): void {
    const wrap = this.el('label', 'prop-slider')
    const head = this.el('span', '', label)
    const out = this.el('output', '', `${value}${unit}`)
    const input = this.el('input')
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) })
    input.addEventListener('input', () => (out.textContent = `${input.value}${unit}`))
    input.addEventListener('change', () => onChange(Number(input.value)))
    head.append(out)
    wrap.append(head, input)
    this.root.append(wrap)
  }

  private select(label: string, options: string[], value: string, onChange: (v: string) => void, editable = false): void {
    const wrap = this.el('label', 'prop-field', label)
    const sel = this.el('select')
    const list = options.includes(value) || !value ? options : [value, ...options]
    sel.innerHTML = list.map((o) => `<option ${o === value ? 'selected' : ''} style="font-family:'${o}'">${o}</option>`).join('')
    sel.addEventListener('change', () => onChange(sel.value))
    wrap.append(sel)
    if (editable) {
      sel.title = 'Choisissez une taille'
    }
    this.root.append(wrap)
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void): void {
    const wrap = this.el('label', 'prop-check')
    const input = this.el('input')
    input.type = 'checkbox'
    input.checked = value
    input.addEventListener('change', () => onChange(input.checked))
    wrap.append(input, document.createTextNode(label))
    this.root.append(wrap)
  }

  private choice<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void): void {
    this.label(label)
    const row = this.row()
    row.classList.add('wrap')
    for (const [id, text] of options) {
      const b = this.el('button', `prop-chip ${id === value ? 'active' : ''}`, text)
      b.type = 'button'
      b.addEventListener('click', () => {
        onChange(id)
        this.render()
      })
      row.append(b)
    }
  }

  private lineStyle(value: LineStyle, onChange: (s: LineStyle) => void): void {
    this.choice<LineStyle>('Style de trait', value, [['solid', '━ Plein'], ['dashed', '╍ Tirets'], ['dotted', '┈ Pointillés']], onChange)
  }
}
