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

/**
 * Hauteur d'écriture de référence : 70e centile des hauteurs de traits (hors points et
 * accents) — une lettre haute ou un mot entier, pas un petit morceau de lettre.
 */
export function textHeight(strokes: Stroke[]): number {
  const hs = strokes.map((s) => {
    const b = boxOf(s)
    return b.y1 - b.y0
  }).sort((a, b) => a - b)
  if (!hs.length) return 1
  const max = hs[hs.length - 1]
  const real = hs.filter((h) => h > max * 0.2)
  const v = real.length ? real : hs
  return v[Math.floor(v.length * 0.7)] || 1
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
  /** Bande de hauteur de la ligne là où elle arrive (derniers traits) : suit pente et ondulation. */
  const band = (l: Line, x: number): [number, number] => {
    const near = l.members.filter((m) => !small(m) && m.x1 > x - H * 4)
    const ms = near.length ? near : l.members.filter((m) => !small(m)).slice(-4)
    if (!ms.length) return [l.members[0].y0, l.members[0].y1]
    return [median(ms.map((m) => m.y0)), median(ms.map((m) => m.y1))]
  }
  const expected = (l: Line, x: number): number => {
    const [a, b] = band(l, x)
    return (a + b) / 2
  }
  for (const s of text.filter((t) => !small(t)).sort((a, b) => a.x0 - b.x0)) {
    let best: Line | null = null
    let bestScore = 0
    for (const l of lines) {
      if (s.x0 - l.x1 > H * 3.2) continue // trop loin : nouveau morceau
      const [b0, b1] = band(l, s.x0)
      const overlap = Math.min(b1, s.y1) - Math.max(b0, s.y0)
      const ratio = overlap / Math.max(1e-6, Math.min(b1 - b0, s.y1 - s.y0))
      if (ratio > 0.3 && ratio > bestScore) {
        bestScore = ratio
        best = l
      }
    }
    if (best) {
      best.members.push(s)
      best.x1 = Math.max(best.x1, s.x1)
    } else lines.push({ members: [s], x1: s.x1 })
  }
  // Morceaux d'une même ligne séparés au départ (lettre en deux traits, début de ligne) :
  // côte à côte et à la même hauteur → une seule ligne. Deux lignes l'une sous l'autre ne
  // se chevauchent pas en hauteur et restent distinctes.
  const ext = (l: Line): Box => l.members.reduce((b, m) => ({ x0: Math.min(b.x0, m.x0), y0: Math.min(b.y0, m.y0), x1: Math.max(b.x1, m.x1), y1: Math.max(b.y1, m.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  for (let merged = true; merged; ) {
    merged = false
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = ext(lines[i]), b = ext(lines[j])
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        const union = Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0)
        // Même hauteur (chevauchement), ou l'un juste au-dessus de l'autre au même endroit
        // (lettre coupée en deux) sans dépasser la hauteur d'une seule ligne d'écriture.
        const sameBand = oy > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5
        const ha = a.y1 - a.y0, hb = b.y1 - b.y0
        // Morceau nettement plus petit collé dessous / dessus (queue de « q », barre de « t »)
        const fragment = Math.min(ha, hb) < Math.max(ha, hb) * 0.6 && union < H * 2.8
        const stacked = gap < H * 0.5 && oy > -H * 0.2 && (union < H * 2.1 || fragment)
        if (gap < H * 3.2 && (sameBand || stacked)) {
          lines[i].members.push(...lines[j].members)
          lines[i].x1 = Math.max(lines[i].x1, lines[j].x1)
          lines.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
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
    const ids = l.members.map((s) => s.i).sort((a, b) => a - b)
    // Angle de la ligne : celui où l'écriture forme la bande la plus fine (profil de
    // projection) ; seulement pour une ligne assez longue (un mot court reste tel quel).
    const angle = box.x1 - box.x0 > H * 4 ? skewOf(ids.map((i) => input[i].points)) : 0
    out.push({ strokes: ids, box, angle })
  }
  out.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
  return { lines: out, drawings: [...drawings] }
}


/** Fait tourner des traits autour d'un point (redressement d'une ligne penchée). */
export function rotate(strokes: Stroke[], angle: number, cx: number, cy: number): Stroke[] {
  if (Math.abs(angle) < 1e-3) return strokes
  const c = Math.cos(angle), s = Math.sin(angle)
  return strokes.map((st) => st.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] as [number, number]))
}

/**
 * Inclinaison d'une ligne d'écriture : on essaie les angles de −25° à +25° et on garde celui où
 * la moitié centrale des points tient dans la bande la plus fine (les jambages et majuscules,
 * en dehors de cette moitié, ne faussent pas la mesure). 0 si la ligne est droite à 2° près.
 */
export function skewOf(strokes: Stroke[]): number {
  const pts = strokes.flat()
  if (pts.length < 8) return 0
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length
  const band = (a: number): number => {
    const c = Math.cos(a), s = Math.sin(a)
    const ys = pts.map(([x, y]) => (x - cx) * s * -1 + (y - cy) * c).sort((p, q) => p - q)
    return ys[Math.floor(ys.length * 0.75)] - ys[Math.floor(ys.length * 0.25)]
  }
  let best = 0
  let bestBand = band(0)
  for (let deg = -25; deg <= 25; deg += 1) {
    const a = (deg * Math.PI) / 180
    const b = band(a)
    if (b < bestBand - 1e-9) {
      bestBand = b
      best = a
    }
  }
  // Affinage au demi-degré
  for (const d of [-0.5, 0.5]) {
    const a = best + (d * Math.PI) / 180
    if (band(a) < bestBand) best = a
  }
  return Math.abs(best) < (2 * Math.PI) / 180 ? 0 : best
}
