/**
 * Graphiques vectoriels (SVG) : rendu net à tout zoom et export PDF vectoriel.
 * La description (ChartSpec) est conservée sur l'objet pour pouvoir le rééditer.
 */
export type ChartType = 'bar' | 'barh' | 'stacked' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'radar'

export interface ChartSeries {
  name: string
  values: number[]
  color: string
}

export interface ChartSpec {
  type: ChartType
  title: string
  labels: string[]
  series: ChartSeries[]
  legend: boolean
  showValues: boolean
  width: number
  height: number
}

export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'bar', label: 'Histogramme' },
  { id: 'barh', label: 'Barres horizontales' },
  { id: 'stacked', label: 'Histogramme empilé' },
  { id: 'line', label: 'Courbes' },
  { id: 'area', label: 'Aires' },
  { id: 'pie', label: 'Secteurs (camembert)' },
  { id: 'doughnut', label: 'Anneau' },
  { id: 'scatter', label: 'Nuage de points' },
  { id: 'radar', label: 'Radar' }
]

export const PALETTE = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300']

export function defaultChart(): ChartSpec {
  return {
    type: 'bar',
    title: 'Titre du graphique',
    labels: ['Janv.', 'Févr.', 'Mars', 'Avr.'],
    series: [
      { name: 'Série 1', values: [4.3, 2.5, 3.5, 4.5], color: PALETTE[0] },
      { name: 'Série 2', values: [2.4, 4.4, 1.8, 2.8], color: PALETTE[1] },
      { name: 'Série 3', values: [2, 2, 3, 5], color: PALETTE[2] }
    ],
    legend: true,
    showValues: false,
    width: 420,
    height: 280
  }
}

const FONT = 'Helvetica'
const TEXT = '#404040'
const GRID = '#d9d9d9'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n: number): string => (Math.abs(n) >= 1000 ? n.toLocaleString('fr-FR') : String(Math.round(n * 100) / 100).replace('.', ','))

function text(x: number, y: number, s: string, size = 10, anchor: 'start' | 'middle' | 'end' = 'middle', weight = 'normal'): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${TEXT}" text-anchor="${anchor}">${esc(s)}</text>`
}

/** Graduation « jolie » : 0, 1, 2, 5 × 10^n. */
function niceScale(min: number, max: number, ticks = 5): { min: number; max: number; step: number } {
  if (min === max) max = min + 1
  const span = max - min
  const raw = span / ticks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= ticks) ?? 10 * mag
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step }
}

interface Plot {
  x: number
  y: number
  w: number
  h: number
}

export function renderChart(spec: ChartSpec): string {
  const { width: W, height: H } = spec
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`]
  let top = 12
  if (spec.title) {
    parts.push(text(W / 2, top + 12, spec.title, 14, 'middle', 'bold'))
    top += 26
  }
  const legendItems = spec.type === 'pie' || spec.type === 'doughnut' ? spec.labels : spec.series.map((s) => s.name)
  const legendH = spec.legend && legendItems.length > 0 ? 22 : 0
  const area: Plot = { x: 12, y: top, w: W - 24, h: H - top - 10 - legendH }

  switch (spec.type) {
    case 'pie':
    case 'doughnut':
      parts.push(pie(spec, area))
      break
    case 'radar':
      parts.push(radar(spec, area))
      break
    case 'barh':
      parts.push(barsHorizontal(spec, area))
      break
    default:
      parts.push(cartesian(spec, area))
  }

  if (legendH) {
    const colors = spec.type === 'pie' || spec.type === 'doughnut' ? spec.labels.map((_, i) => PALETTE[i % PALETTE.length]) : spec.series.map((s) => s.color)
    const widths = legendItems.map((l) => 18 + l.length * 5.6 + 12)
    let x = (W - widths.reduce((a, b) => a + b, 0)) / 2
    const y = H - 14
    legendItems.forEach((label, i) => {
      parts.push(`<rect x="${x}" y="${y - 8}" width="10" height="10" fill="${colors[i]}"/>`)
      parts.push(text(x + 15, y + 1, label, 10, 'start'))
      x += widths[i]
    })
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

/** Axes + grille communs aux graphiques verticaux. Renvoie la zone de tracé et l'échelle. */
function axes(spec: ChartSpec, area: Plot, min: number, max: number, parts: string[]): { plot: Plot; y: (v: number) => number } {
  const scale = niceScale(Math.min(0, min), Math.max(0, max))
  const labelW = Math.max(...[scale.min, scale.max].map((v) => fmt(v).length)) * 6 + 8
  const plot: Plot = { x: area.x + labelW, y: area.y + 4, w: area.w - labelW - 4, h: area.h - 22 }
  const y = (v: number): number => plot.y + plot.h - ((v - scale.min) / (scale.max - scale.min)) * plot.h
  for (let v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) {
    parts.push(`<line x1="${plot.x}" y1="${y(v)}" x2="${plot.x + plot.w}" y2="${y(v)}" stroke="${GRID}" stroke-width="0.75"/>`)
    parts.push(text(plot.x - 6, y(v) + 3.5, fmt(v), 9, 'end'))
  }
  const n = spec.labels.length
  spec.labels.forEach((l, i) => parts.push(text(plot.x + (plot.w * (i + 0.5)) / n, plot.y + plot.h + 14, l, 9)))
  return { plot, y }
}

function cartesian(spec: ChartSpec, area: Plot): string {
  const parts: string[] = []
  const n = spec.labels.length
  const all = spec.series.flatMap((s) => s.values.slice(0, n))
  const stackedTotals = spec.labels.map((_, i) => spec.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0))
  const max = spec.type === 'stacked' ? Math.max(...stackedTotals, 0) : Math.max(...all, 0)
  const { plot, y } = axes(spec, area, Math.min(...all, 0), max, parts)
  const slot = plot.w / Math.max(1, n)
  const cx = (i: number): number => plot.x + slot * (i + 0.5)

  if (spec.type === 'bar') {
    const k = spec.series.length
    const bw = (slot * 0.7) / Math.max(1, k)
    spec.series.forEach((s, j) =>
      s.values.slice(0, n).forEach((v, i) => {
        const x = plot.x + slot * i + slot * 0.15 + bw * j
        const y0 = y(0)
        const y1 = y(v)
        parts.push(`<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw * 0.92}" height="${Math.abs(y1 - y0)}" fill="${s.color}"/>`)
        if (spec.showValues) parts.push(text(x + bw / 2, Math.min(y0, y1) - 3, fmt(v), 8))
      })
    )
  } else if (spec.type === 'stacked') {
    const base = spec.labels.map(() => 0)
    spec.series.forEach((s) =>
      s.values.slice(0, n).forEach((v, i) => {
        const val = Math.max(0, v)
        const y0 = y(base[i])
        const y1 = y(base[i] + val)
        parts.push(`<rect x="${plot.x + slot * i + slot * 0.2}" y="${y1}" width="${slot * 0.6}" height="${y0 - y1}" fill="${s.color}"/>`)
        if (spec.showValues && val) parts.push(text(cx(i), (y0 + y1) / 2 + 3, fmt(v), 8))
        base[i] += val
      })
    )
  } else {
    spec.series.forEach((s) => {
      const pts = s.values.slice(0, n).map((v, i) => [cx(i), y(v)] as const)
      if (pts.length === 0) return
      const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'} ${px} ${py}`).join(' ')
      if (spec.type === 'area') {
        parts.push(`<path d="${d} L ${pts.at(-1)![0]} ${y(0)} L ${pts[0][0]} ${y(0)} Z" fill="${s.color}" fill-opacity="0.35" stroke="none"/>`)
      }
      if (spec.type !== 'scatter') parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round"/>`)
      for (const [px, py] of pts) parts.push(`<circle cx="${px}" cy="${py}" r="${spec.type === 'scatter' ? 4 : 3}" fill="${s.color}"/>`)
      if (spec.showValues) s.values.slice(0, n).forEach((v, i) => parts.push(text(cx(i), y(v) - 7, fmt(v), 8)))
    })
  }
  parts.push(`<line x1="${plot.x}" y1="${y(0)}" x2="${plot.x + plot.w}" y2="${y(0)}" stroke="#7f7f7f" stroke-width="1"/>`)
  return parts.join('')
}

function barsHorizontal(spec: ChartSpec, area: Plot): string {
  const parts: string[] = []
  const n = spec.labels.length
  const all = spec.series.flatMap((s) => s.values.slice(0, n))
  const scale = niceScale(Math.min(0, ...all), Math.max(0, ...all))
  const labelW = Math.max(0, ...spec.labels.map((l) => l.length)) * 5.6 + 10
  const plot: Plot = { x: area.x + labelW, y: area.y + 4, w: area.w - labelW - 10, h: area.h - 20 }
  const x = (v: number): number => plot.x + ((v - scale.min) / (scale.max - scale.min)) * plot.w
  for (let v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) {
    parts.push(`<line x1="${x(v)}" y1="${plot.y}" x2="${x(v)}" y2="${plot.y + plot.h}" stroke="${GRID}" stroke-width="0.75"/>`)
    parts.push(text(x(v), plot.y + plot.h + 13, fmt(v), 9))
  }
  const slot = plot.h / Math.max(1, n)
  const k = spec.series.length
  const bh = (slot * 0.7) / Math.max(1, k)
  spec.labels.forEach((l, i) => parts.push(text(plot.x - 6, plot.y + slot * (i + 0.5) + 3, l, 9, 'end')))
  spec.series.forEach((s, j) =>
    s.values.slice(0, n).forEach((v, i) => {
      const yy = plot.y + slot * i + slot * 0.15 + bh * j
      parts.push(`<rect x="${Math.min(x(0), x(v))}" y="${yy}" width="${Math.abs(x(v) - x(0))}" height="${bh * 0.92}" fill="${s.color}"/>`)
      if (spec.showValues) parts.push(text(Math.max(x(0), x(v)) + 4, yy + bh / 2 + 3, fmt(v), 8, 'start'))
    })
  )
  parts.push(`<line x1="${x(0)}" y1="${plot.y}" x2="${x(0)}" y2="${plot.y + plot.h}" stroke="#7f7f7f" stroke-width="1"/>`)
  return parts.join('')
}

function pie(spec: ChartSpec, area: Plot): string {
  const parts: string[] = []
  const values = (spec.series[0]?.values ?? []).slice(0, spec.labels.length).map((v) => Math.max(0, v))
  const total = values.reduce((a, b) => a + b, 0) || 1
  const r = Math.min(area.w, area.h) / 2 - 4
  const cx = area.x + area.w / 2
  const cy = area.y + area.h / 2
  const inner = spec.type === 'doughnut' ? r * 0.55 : 0
  let angle = -Math.PI / 2
  values.forEach((v, i) => {
    const a = (v / total) * Math.PI * 2
    const color = PALETTE[i % PALETTE.length]
    const end = angle + a
    const large = a > Math.PI ? 1 : 0
    const p = (rad: number, t: number): string => `${cx + rad * Math.cos(t)} ${cy + rad * Math.sin(t)}`
    if (a >= Math.PI * 2 - 1e-9) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`)
    } else if (a > 0) {
      const d = inner
        ? `M ${p(r, angle)} A ${r} ${r} 0 ${large} 1 ${p(r, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, angle)} Z`
        : `M ${cx} ${cy} L ${p(r, angle)} A ${r} ${r} 0 ${large} 1 ${p(r, end)} Z`
      parts.push(`<path d="${d}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`)
    }
    if (spec.showValues && v > 0) {
      const mid = angle + a / 2
      const lr = inner ? (r + inner) / 2 : r * 0.62
      parts.push(`<text x="${cx + lr * Math.cos(mid)}" y="${cy + lr * Math.sin(mid) + 3.5}" font-family="${FONT}" font-size="10" font-weight="bold" fill="#ffffff" text-anchor="middle">${Math.round((v / total) * 100)} %</text>`)
    }
    angle = end
  })
  if (inner) parts.push(`<circle cx="${cx}" cy="${cy}" r="${inner}" fill="#ffffff"/>`)
  return parts.join('')
}

function radar(spec: ChartSpec, area: Plot): string {
  const parts: string[] = []
  const n = spec.labels.length
  if (n < 3) return text(area.x + area.w / 2, area.y + area.h / 2, 'Le radar demande au moins 3 catégories', 10)
  const all = spec.series.flatMap((s) => s.values.slice(0, n))
  const scale = niceScale(0, Math.max(...all, 1), 4)
  const r = Math.min(area.w, area.h) / 2 - 16
  const cx = area.x + area.w / 2
  const cy = area.y + area.h / 2
  const pt = (i: number, v: number): [number, number] => {
    const t = -Math.PI / 2 + (i / n) * Math.PI * 2
    const rr = (v / scale.max) * r
    return [cx + rr * Math.cos(t), cy + rr * Math.sin(t)]
  }
  for (let v = scale.step; v <= scale.max + 1e-9; v += scale.step) {
    parts.push(`<path d="${spec.labels.map((_, i) => `${i ? 'L' : 'M'} ${pt(i, v).join(' ')}`).join(' ')} Z" fill="none" stroke="${GRID}" stroke-width="0.75"/>`)
  }
  spec.labels.forEach((l, i) => {
    const [x, y] = pt(i, scale.max)
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${GRID}" stroke-width="0.75"/>`)
    const [lx, ly] = pt(i, scale.max * 1.12)
    parts.push(text(lx, ly + 3, l, 9, Math.abs(lx - cx) < 4 ? 'middle' : lx > cx ? 'start' : 'end'))
  })
  spec.series.forEach((s) => {
    const d = s.values.slice(0, n).map((v, i) => `${i ? 'L' : 'M'} ${pt(i, Math.max(0, v)).join(' ')}`).join(' ')
    parts.push(`<path d="${d} Z" fill="${s.color}" fill-opacity="0.2" stroke="${s.color}" stroke-width="2"/>`)
  })
  return parts.join('')
}
