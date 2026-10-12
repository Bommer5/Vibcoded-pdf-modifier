import { CHART_TYPES, PALETTE, renderChart, type ChartSpec } from './chart'

/**
 * Fenêtre d'édition d'un graphique : type, titre, tableau de données
 * (on peut coller directement depuis Excel / LibreOffice Calc), couleurs, aperçu en direct.
 */
export function editChart(initial: ChartSpec): Promise<ChartSpec | null> {
  const spec: ChartSpec = structuredClone(initial)
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog chart-dialog'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Graphique</h2>
      <div class="chart-layout">
        <div class="chart-side">
          <div class="chart-types" role="radiogroup" aria-label="Type de graphique"></div>
          <label>Titre <input name="title" /></label>
          <div class="row">
            <label class="check"><input type="checkbox" name="legend" /> Légende</label>
            <label class="check"><input type="checkbox" name="values" /> Valeurs</label>
          </div>
          <p class="muted small">Données : cliquez dans une case pour la modifier, ou collez un tableau copié depuis Excel.</p>
          <div class="chart-grid-wrap"><table class="chart-grid"></table></div>
          <div class="row">
            <button type="button" data-do="add-row">+ Ligne</button>
            <button type="button" data-do="del-row">− Ligne</button>
            <button type="button" data-do="add-series">+ Série</button>
            <button type="button" data-do="del-series">− Série</button>
          </div>
        </div>
        <div class="chart-preview" aria-label="Aperçu"></div>
      </div>
      <menu>
        <button value="cancel" formnovalidate>Annuler</button>
        <button value="ok" class="primary">Valider</button>
      </menu>
    </form>`
  document.body.append(dialog)

  const $ = <T extends Element>(sel: string): T => dialog.querySelector(sel) as T
  const preview = $<HTMLElement>('.chart-preview')
  const grid = $<HTMLTableElement>('.chart-grid')
  const title = $<HTMLInputElement>('[name=title]')
  const legend = $<HTMLInputElement>('[name=legend]')
  const values = $<HTMLInputElement>('[name=values]')
  title.value = spec.title
  legend.checked = spec.legend
  values.checked = spec.showValues

  const types = $<HTMLElement>('.chart-types')
  for (const t of CHART_TYPES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = t.label
    b.dataset.type = t.id
    b.addEventListener('click', () => {
      spec.type = t.id
      refresh()
    })
    types.append(b)
  }

  const num = (s: string): number => {
    const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(n) ? n : 0
  }

  function renderGrid(): void {
    const head = `<tr><th></th>${spec.series
      .map(
        (s, j) =>
          `<th><input type="color" data-color="${j}" value="${s.color}" title="Couleur"/><input data-series="${j}" value="${escapeAttr(s.name)}"/></th>`
      )
      .join('')}</tr>`
    const rows = spec.labels
      .map(
        (l, i) =>
          `<tr><th><input data-label="${i}" value="${escapeAttr(l)}"/></th>${spec.series
            .map((s, j) => `<td><input data-cell="${i},${j}" inputmode="decimal" value="${String(s.values[i] ?? '').replace('.', ',')}"/></td>`)
            .join('')}</tr>`
      )
      .join('')
    grid.innerHTML = head + rows
  }

  function refresh(): void {
    preview.innerHTML = renderChart(spec)
    types.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.type === spec.type))
  }

  grid.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.label) spec.labels[+el.dataset.label] = el.value
    else if (el.dataset.series) spec.series[+el.dataset.series].name = el.value
    else if (el.dataset.color) spec.series[+el.dataset.color].color = el.value
    else if (el.dataset.cell) {
      const [i, j] = el.dataset.cell.split(',').map(Number)
      spec.series[j].values[i] = num(el.value)
    }
    refresh()
  })

  // Collage d'un bloc de cellules (Excel, Calc, Google Sheets : tabulations + retours à la ligne).
  grid.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!/[\t\n]/.test(text.trim())) return
    e.preventDefault()
    const rows = text.replace(/\r/g, '').split('\n').filter((r) => r.length).map((r) => r.split('\t'))
    const isNumber = (c: string): boolean => c.trim() !== '' && !Number.isNaN(parseFloat(c.replace(/\s/g, '').replace(',', '.')))
    const hasHeader = rows[0].slice(1).some((c) => c.trim() !== '' && !isNumber(c))
    const header = hasHeader ? rows.shift()! : null
    const cols = Math.max(...rows.map((r) => r.length)) - 1
    spec.labels = rows.map((r) => r[0] ?? '')
    spec.series = Array.from({ length: Math.max(1, cols) }, (_, j) => ({
      name: header?.[j + 1] || spec.series[j]?.name || `Série ${j + 1}`,
      color: spec.series[j]?.color ?? PALETTE[j % PALETTE.length],
      values: rows.map((r) => num(r[j + 1] ?? '0'))
    }))
    renderGrid()
    refresh()
  })

  dialog.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).dataset.do
    if (!action) return
    if (action === 'add-row') {
      spec.labels.push(`Catégorie ${spec.labels.length + 1}`)
      spec.series.forEach((s) => s.values.push(0))
    } else if (action === 'del-row' && spec.labels.length > 1) {
      spec.labels.pop()
      spec.series.forEach((s) => s.values.pop())
    } else if (action === 'add-series') {
      const j = spec.series.length
      spec.series.push({ name: `Série ${j + 1}`, color: PALETTE[j % PALETTE.length], values: spec.labels.map(() => 0) })
    } else if (action === 'del-series' && spec.series.length > 1) {
      spec.series.pop()
    }
    renderGrid()
    refresh()
  })

  title.addEventListener('input', () => {
    spec.title = title.value
    refresh()
  })
  legend.addEventListener('change', () => {
    spec.legend = legend.checked
    refresh()
  })
  values.addEventListener('change', () => {
    spec.showValues = values.checked
    refresh()
  })

  renderGrid()
  refresh()
  dialog.showModal()

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? spec : null)
      dialog.remove()
    })
  })
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
