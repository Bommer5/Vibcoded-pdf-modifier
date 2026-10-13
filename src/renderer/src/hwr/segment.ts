import type { Stroke } from './ink-image'

/**
 * Traits écrits → lignes de texte à reconnaître, et traits à laisser tels quels (dessin).
 *
 * Restent des dessins : les longs traits droits (soulignement, séparation, flèche, barre de
 * fraction), les traits beaucoup plus hauts que l'écriture voisine (schéma, accolade géante),
 * les contours fermés qui entourent d'autres traits (cadre, bulle) et les gribouillis très
 * larges et denses. Le reste est rangé en lignes (bandes horizontales), les petits traits
 * (points des i, accents, apostrophes) rejoignant la ligne sous ou à côté d'eux ; une ligne est
 * coupée en morceaux quand un grand blanc sépare deux groupes (deux colonnes, deux notes).
 */

export interface InkStroke {
  id: number
  points: Stroke
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Segmentation {
  /** Morceaux de ligne à reconnaître (indices des traits, dans l'ordre d'écriture). */
  lines: { strokes: number[]; box: Box; angle: number }[]
  /** Traits gardés comme dessin. */
  drawings: number[]
}

interface Info extends Box {
  i: number
  len: number
  chord: number
  closed: boolean
}

const boxOf = (pts: Stroke): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}

const median = (v: number[]): number => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Hauteur d'écriture de référence : médiane des traits « lettres » (ni points, ni dessins). */
export function textHeight(strokes: Stroke[]): number {
  const hs = strokes.map((s) => {
    const b = boxOf(s)
    return Math.max(b.y1 - b.y0, Math.min(b.x1 - b.x0, (b.y1 - b.y0) * 3))
  })
  const big = hs.filter((h) => h > median(hs) * 0.35)
  return median(big.length ? big : hs) || 1
}

export function segment(input: InkStroke[], refHeight?: number): Segmentation {
  const infos: Info[] = input.map((s, i) => {
    const b = boxOf(s.points)
    let len = 0
    for (let k = 1; k < s.points.length; k++) len += Math.hypot(s.points[k][0] - s.points[k - 1][0], s.points[k][1] - s.points[k - 1][1])
    const a = s.points[0]
    const z = s.points[s.points.length - 1]
    const chord = Math.hypot(z[0] - a[0], z[1] - a[1])
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0)
    return { ...b, i, len, chord, closed: s.points.length > 8 && chord < size * 0.18 && len > size * 2.4 }
  })
  const H = refHeight ?? textHeight(input.map((s) => s.points))
  const drawings = new Set<number>()
  for (const s of infos) {
    const w = s.x1 - s.x0
    const h = s.y1 - s.y0
    // Long trait droit : soulignement, séparation, flèche, barre de fraction…
    const straight = s.len > 0 && s.chord / s.len > 0.93
    if (straight && s.len > H * 2.6) drawings.add(s.i)
    // Bien plus haut que l'écriture : schéma, accolade, grande forme
    else if (h > H * 2.9) drawings.add(s.i)
    // Gribouillis très large et très dense (hachures, rature géante)
    else if (w > H * 4 && s.len > (w + h) * 6) drawings.add(s.i)
  }
  // Contour fermé qui entoure d'autres traits : cadre, bulle (le contenu reste du texte)
  for (const s of infos) {
    if (!s.closed || drawings.has(s.i)) continue
    const inside = infos.filter((o) => o !== s && o.x0 >= s.x0 && o.x1 <= s.x1 && o.y0 >= s.y0 && o.y1 <= s.y1)
    if (inside.length >= 2 && s.y1 - s.y0 > H * 1.3) drawings.add(s.i)
  }

  // Lignes : de gauche à droite, chaque trait rejoint la ligne qui se poursuit à sa hauteur
  // (prolongée selon sa pente) : une ligne penchée ou qui ondule reste une seule ligne.
  const text = infos.filter((s) => !drawings.has(s.i))
  const small = (s: Info): boolean => s.y1 - s.y0 < H * 0.42 && s.x1 - s.x0 < H * 0.9
  type Line = { members: Info[]; x1: number }
  const lines: Line[] = []
  const cx = (s: Box): number => (s.x0 + s.x1) / 2
  const cy = (s: Box): number => (s.y0 + s.y1) / 2
  /** Hauteur attendue de la ligne à l'abscisse x (droite des moindres carrés des derniers traits). */
  const expected = (l: Line, x: number): number => {
    const ms = l.members.filter((m) => !small(m)).slice(-6)
    if (ms.length < 3) return median(ms.map(cy))
    const fit = lineFit(ms.map((m) => [cx(m), cy(m)]))
    // Pente bornée : une majuscule ou un jambage isolé ne fait pas basculer la ligne
    const slope = Math.max(-0.45, Math.min(0.45, fit.slope))
    return fit.y + slope * (x - fit.x)
  }
  for (const s of text.filter((t) => !small(t)).sort((a, b) => a.x0 - b.x0)) {
    let best: Line | null = null
    let bestD = Infinity
    for (const l of lines) {
      if (s.x0 - l.x1 > H * 3.2) continue // trop loin : nouveau morceau
      const d = Math.abs(cy(s) - expected(l, cx(s)))
      if (d < H * 0.6 && d < bestD) {
        bestD = d
        best = l
      }
    }
    if (best) {
      best.members.push(s)
      best.x1 = Math.max(best.x1, s.x1)
    } else lines.push({ members: [s], x1: s.x1 })
  }
  // Petits traits (points, accents, apostrophes, virgules) : la ligne la plus proche
  for (const s of text.filter(small)) {
    let best: Line | null = null
    let bestD = Infinity
    for (const l of lines) {
      const lx0 = Math.min(...l.members.map((m) => m.x0))
      const dx = s.x1 < lx0 ? lx0 - s.x1 : s.x0 > l.x1 ? s.x0 - l.x1 : 0
      const dyc = cy(s) - expected(l, cx(s))
      // Un accent est au-dessus de sa ligne : la distance vers le haut compte moins.
      const d = dx * 1.5 + Math.max(0, Math.abs(dyc) - H * 0.5) * (dyc < 0 ? 0.6 : 1)
      if (d < bestD) {
        bestD = d
        best = l
      }
    }
    if (best && bestD < H * 1.6) best.members.push(s)
    else lines.push({ members: [s], x1: s.x1 })
  }

  const out: Segmentation['lines'] = []
  for (const l of lines) {
    const box = l.members.reduce((b, s) => ({ x0: Math.min(b.x0, s.x0), y0: Math.min(b.y0, s.y0), x1: Math.max(b.x1, s.x1), y1: Math.max(b.y1, s.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
    const big = l.members.filter((m) => !small(m))
    const fit = big.length >= 2 ? lineFit(big.map((m) => [cx(m), cy(m)])) : { slope: 0 }
    // Angle de la ligne (redressée avant la lecture) ; borné à ±25°
    const angle = Math.atan(Math.max(-0.47, Math.min(0.47, fit.slope)))
    out.push({ strokes: l.members.map((s) => s.i).sort((a, b) => a - b), box, angle })
  }
  out.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
  return { lines: out, drawings: [...drawings] }
}

/** Droite des moindres carrés (pente et point moyen). */
function lineFit(pts: number[][]): { slope: number; x: number; y: number } {
  const n = pts.length
  const mx = pts.reduce((a, p) => a + p[0], 0) / n
  const my = pts.reduce((a, p) => a + p[1], 0) / n
  let sxx = 0, sxy = 0
  for (const [x, y] of pts) {
    sxx += (x - mx) * (x - mx)
    sxy += (x - mx) * (y - my)
  }
  return { slope: sxx > 1e-6 ? sxy / sxx : 0, x: mx, y: my }
}

/** Fait tourner des traits autour d'un point (redressement d'une ligne penchée). */
export function rotate(strokes: Stroke[], angle: number, cx: number, cy: number): Stroke[] {
  if (Math.abs(angle) < 1e-3) return strokes
  const c = Math.cos(angle), s = Math.sin(angle)
  return strokes.map((st) => st.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] as [number, number]))
}
