/**
 * Graphes (théorie des graphes) : nœuds nommés, arêtes (orientées ou non), poids.
 * Mise en page automatique qui cherche le moins de croisements possible, puis des arêtes de
 * longueurs régulières et des nœuds bien espacés ; dessin vectoriel (SVG) pour le document.
 */

export interface GraphNode {
  id: string
  label: string
  x: number
  y: number
}

export interface GraphEdge {
  from: string
  to: string
  weight?: string
}

export interface GraphSpec {
  nodes: GraphNode[]
  edges: GraphEdge[]
  directed: boolean
  weighted: boolean
  /** Diamètre des nœuds (px). */
  nodeSize: number
  color: string
}

export function defaultGraph(): GraphSpec {
  const g: GraphSpec = { nodes: [], edges: [], directed: false, weighted: true, nodeSize: 34, color: '#2f6bff' }
  applyText(g, 'A - B 4\nA - C 2\nB - C 1\nB - D 5\nC - D 8\nC - E 10\nD - E 2\nD - F 6\nE - F 3')
  layout(g)
  return g
}

/** Prochain nom libre : A, B, … Z, AA, AB… */
export function nextLabel(g: GraphSpec): string {
  const used = new Set(g.nodes.map((n) => n.label))
  for (let i = 0; ; i++) {
    let s = ''
    let k = i
    do {
      s = String.fromCharCode(65 + (k % 26)) + s
      k = Math.floor(k / 26) - 1
    } while (k >= 0)
    if (!used.has(s)) return s
  }
}

export const newId = (): string => Math.random().toString(36).slice(2, 10)

/**
 * Saisie rapide, une arête par ligne : « A - B 4 », « A B », « A -> B : 3 », « Paris – Lyon 465 ».
 * Un nom seul ajoute un nœud isolé. Les nœuds manquants sont créés ; le poids est le dernier
 * élément s'il est numérique (ou après « : »). « -> » rend le graphe orienté.
 */
export function applyText(g: GraphSpec, text: string): void {
  const byLabel = new Map(g.nodes.map((n) => [n.label, n]))
  const node = (label: string): GraphNode => {
    let n = byLabel.get(label)
    if (!n) {
      n = { id: newId(), label, x: Math.random() * 4, y: Math.random() * 4 }
      g.nodes.push(n)
      byLabel.set(label, n)
    }
    return n
  }
  for (const raw of text.split(/\n|;/)) {
    const line = raw.trim()
    if (!line) continue
    let weight: string | undefined
    let body = line
    const colon = /^(.*?)\s*:\s*(\S.*)$/.exec(line)
    if (colon) {
      body = colon[1]
      weight = colon[2].trim()
    }
    const directed = /->|→/.test(body)
    const parts = body.split(/\s*(?:->|→|<->|—|–|-(?!\d)|,)\s*|\s+/).filter(Boolean)
    if (!weight && parts.length >= 3 && /^-?\d+([.,]\d+)?$/.test(parts[parts.length - 1])) weight = parts.pop()
    if (parts.length === 1) {
      node(parts[0])
      continue
    }
    if (parts.length < 2) continue
    if (directed) g.directed = true
    const a = node(parts[0])
    const b = node(parts[1])
    const same = g.edges.find((e) => (e.from === a.id && e.to === b.id) || (!g.directed && e.from === b.id && e.to === a.id))
    if (same) {
      if (weight !== undefined) same.weight = weight
    } else g.edges.push({ from: a.id, to: b.id, weight })
    if (weight !== undefined) g.weighted = true
  }
}

/** Texte de saisie rapide décrivant le graphe (pour l'afficher et le modifier). */
export function toText(g: GraphSpec): string {
  const label = new Map(g.nodes.map((n) => [n.id, n.label]))
  const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]))
  const lines = g.edges.map((e) => `${label.get(e.from)} ${g.directed ? '->' : '-'} ${label.get(e.to)}${e.weight !== undefined && e.weight !== '' ? ' ' + e.weight : ''}`)
  for (const n of g.nodes) if (!linked.has(n.id)) lines.push(n.label)
  return lines.join('\n')
}

// --- Géométrie -------------------------------------------------------------------------

type P = { x: number; y: number }

function cross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d)
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

/** Nombre de croisements entre arêtes (celles qui partagent un nœud ne comptent pas). */
export function crossings(g: GraphSpec, pos?: Map<string, P>): number {
  const at = pos ?? new Map(g.nodes.map((n) => [n.id, n]))
  const es = uniqueEdges(g)
  let n = 0
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const [a, b] = es[i], [c, d] = es[j]
      if (a === c || a === d || b === c || b === d) continue
      if (cross(at.get(a)!, at.get(b)!, at.get(c)!, at.get(d)!)) n++
    }
  }
  return n
}

/** Arêtes sans doublon de sens (A→B et B→A comptent une fois pour la géométrie). */
function uniqueEdges(g: GraphSpec): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const e of g.edges) {
    if (e.from === e.to) continue
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([e.from, e.to])
  }
  return out
}

// --- Mise en page --------------------------------------------------------------------

/** Générateur pseudo-aléatoire reproductible (même graphe → même dessin). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

/**
 * Range les nœuds : plusieurs dessins candidats (équilibre des distances, cercle ordonné,
 * arbre, couches pour un graphe orienté sans cycle), chacun affiné, et on garde celui qui a le
 * moins de croisements, puis les longueurs d'arêtes les plus régulières sans nœuds collés.
 * Les morceaux non reliés entre eux sont rangés côte à côte.
 */
export function layout(g: GraphSpec): void {
  if (!g.nodes.length) return
  const comps = components(g)
  let offset = 0
  for (const comp of comps) {
    const sub: GraphSpec = { ...g, nodes: comp, edges: g.edges.filter((e) => comp.some((n) => n.id === e.from)) }
    const pos = bestLayout(sub)
    // Normalisation : arête médiane = 1, puis à la suite des morceaux précédents
    const xs = comp.map((n) => pos.get(n.id)!.x)
    const ys = comp.map((n) => pos.get(n.id)!.y)
    const minX = Math.min(...xs), minY = Math.min(...ys)
    for (const n of comp) {
      const p = pos.get(n.id)!
      n.x = p.x - minX + offset
      n.y = p.y - minY
    }
    offset += Math.max(...xs) - minX + 1.4
  }
}

function components(g: GraphSpec): GraphNode[][] {
  const adj = adjacency(g)
  const seen = new Set<string>()
  const out: GraphNode[][] = []
  for (const n of g.nodes) {
    if (seen.has(n.id)) continue
    const comp: GraphNode[] = []
    const stack = [n.id]
    seen.add(n.id)
    while (stack.length) {
      const id = stack.pop()!
      comp.push(g.nodes.find((x) => x.id === id)!)
      for (const m of adj.get(id) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m) }
    }
    out.push(comp)
  }
  return out.sort((a, b) => b.length - a.length)
}

function adjacency(g: GraphSpec): Map<string, string[]> {
  const adj = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]))
  for (const [a, b] of uniqueEdges(g)) {
    adj.get(a)?.push(b)
    adj.get(b)?.push(a)
  }
  return adj
}

function distances(g: GraphSpec): Map<string, Map<string, number>> {
  const adj = adjacency(g)
  const all = new Map<string, Map<string, number>>()
  for (const n of g.nodes) {
    const d = new Map([[n.id, 0]])
    const q = [n.id]
    while (q.length) {
      const id = q.shift()!
      for (const m of adj.get(id) ?? []) if (!d.has(m)) { d.set(m, d.get(id)! + 1); q.push(m) }
    }
    all.set(n.id, d)
  }
  return all
}

/** Note d'un dessin (plus petit = mieux) : croisements d'abord, puis régularité et espacement. */
function score(g: GraphSpec, pos: Map<string, P>, dist: Map<string, Map<string, number>>): number {
  const ids = g.nodes.map((n) => n.id)
  // Taille réelle des nœuds (pilules des noms longs), en unités de dessin
  const half = new Map(g.nodes.map((n) => {
    const b = nodeBox(g, n)
    return [n.id, { w: b.w / 2 / UNIT, h: b.h / 2 / UNIT }]
  }))
  let stress = 0
  let close = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i])!, b = pos.get(ids[j])!
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      // Étiquettes qui se touchent : il faut de l'air autour de chaque nœud
      const ha = half.get(ids[i])!, hb = half.get(ids[j])!
      const ox = ha.w + hb.w + 0.3 - Math.abs(a.x - b.x)
      const oy = ha.h + hb.h + 0.3 - Math.abs(a.y - b.y)
      if (ox > 0 && oy > 0) close += Math.min(ox, oy) * 200
      const t = dist.get(ids[i])!.get(ids[j]) ?? ids.length
      stress += ((d - t) * (d - t)) / (t * t)
      if (d < 0.55) close += (0.55 - d) * 40
      if (d < 0.25) close += 1500 // nœuds l'un sur l'autre : pire qu'un croisement
    }
  }
  // Nœud posé sur une arête qui ne le concerne pas : illisible
  let onEdge = 0
  for (const [a, b] of uniqueEdges(g)) {
    const p = pos.get(a)!, q = pos.get(b)!
    for (const id of ids) {
      if (id === a || id === b) continue
      const r = pos.get(id)!
      const dx = q.x - p.x, dy = q.y - p.y
      const L = dx * dx + dy * dy || 1
      const u = Math.max(0, Math.min(1, ((r.x - p.x) * dx + (r.y - p.y) * dy) / L))
      const dd = Math.hypot(r.x - (p.x + u * dx), r.y - (p.y + u * dy))
      if (dd < 0.3) onEdge += (0.3 - dd) * 60
      if (dd < 0.08) onEdge += 1500 // arête qui traverse un nœud : pire qu'un croisement
    }
  }
  // Poids d'une arête (écrit en son milieu) posé sur un autre nœud
  if (g.weighted) {
    for (const e of g.edges) {
      if (!e.weight) continue
      const p = pos.get(e.from), q = pos.get(e.to)
      if (!p || !q) continue
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2
      for (const id of ids) {
        if (id === e.from || id === e.to) continue
        const r = pos.get(id)!, h = half.get(id)!
        if (Math.abs(mx - r.x) < h.w + 0.25 && Math.abs(my - r.y) < h.h + 0.15) onEdge += 60
      }
    }
  }
  return crossings(g, pos) * 1000 + stress / Math.max(1, ids.length) + close + onEdge
}

function bestLayout(g: GraphSpec): Map<string, P> {
  const n = g.nodes.length
  const ids = g.nodes.map((x) => x.id)
  if (n === 1) return new Map([[ids[0], { x: 0, y: 0 }]])
  if (n === 2) return new Map([[ids[0], { x: 0, y: 0 }], [ids[1], { x: 1.6, y: 0 }]])
  const dist = distances(g)
  const cands: Map<string, P>[] = []
  for (let s = 0; s < 6; s++) cands.push(stressLayout(g, dist, rng(17 + s * 101)))
  cands.push(circular(g))
  if (n <= 60) cands.push(...tutte(g))
  const E = uniqueEdges(g).length
  if (E === n - 1) cands.push(tree(g))
  if (g.directed && acyclic(g)) cands.push(layered(g))
  let best = cands[0]
  let bestScore = Infinity
  const ranked = cands.map((c) => ({ c, s: score(g, c, dist) })).sort((a, b) => a.s - b.s)
  for (const { c } of ranked.slice(0, n > 16 ? 2 : 3)) {
    const refined = anneal(g, c, dist, rng(7))
    const s = score(g, refined, dist)
    if (s < bestScore) {
      bestScore = s
      best = refined
    }
  }
  return best
}

/**
 * Plongement de Tutte : un cycle du graphe sur un cercle, chaque autre nœud au centre de ses
 * voisins. Pour un graphe planaire bien relié (cube, roue, prisme…), aucun croisement n'est
 * possible quand le cycle choisi est une face : on essaie les plus courts cycles du graphe.
 */
function tutte(g: GraphSpec): Map<string, P>[] {
  const adj = adjacency(g)
  const ids = g.nodes.map((n) => n.id)
  const cycles = new Map<string, string[]>()
  // Plus court cycle passant par chaque arête (chemin le plus court sans cette arête)
  for (const [a, b] of uniqueEdges(g)) {
    const prev = new Map<string, string>([[a, '']])
    const q = [a]
    while (q.length && !prev.has(b)) {
      const u = q.shift()!
      for (const v of adj.get(u) ?? []) {
        if (prev.has(v) || (u === a && v === b)) continue
        prev.set(v, u)
        q.push(v)
      }
    }
    if (!prev.has(b)) continue
    const cyc: string[] = []
    for (let x = b; x; x = prev.get(x)!) cyc.push(x)
    if (cyc.length < 3) continue
    const key = [...cyc].sort().join('|')
    if (!cycles.has(key)) cycles.set(key, cyc)
  }
  // Grands cycles d'abord (souvent la face extérieure), quelques-uns seulement
  const list = [...cycles.values()].sort((x, y) => y.length - x.length).slice(0, 10)
  return list.map((cyc) => {
    const R = Math.max(1.2, (cyc.length * 1.3) / (2 * Math.PI)) * Math.max(1, Math.sqrt(ids.length / cyc.length))
    const pos = new Map<string, P>()
    cyc.forEach((id, i) => pos.set(id, { x: R * Math.cos((2 * Math.PI * i) / cyc.length), y: R * Math.sin((2 * Math.PI * i) / cyc.length) }))
    const fixed = new Set(cyc)
    for (const id of ids) if (!fixed.has(id)) pos.set(id, { x: 0, y: 0 })
    for (let it = 0; it < 300; it++) {
      for (const id of ids) {
        if (fixed.has(id)) continue
        const nb = adj.get(id) ?? []
        if (!nb.length) continue
        let x = 0, y = 0
        for (const m of nb) {
          x += pos.get(m)!.x
          y += pos.get(m)!.y
        }
        pos.set(id, { x: x / nb.length, y: y / nb.length })
      }
    }
    return pos
  })
}

/** Équilibre des distances (stress majorization) : chaque paire à sa distance dans le graphe. */
function stressLayout(g: GraphSpec, dist: Map<string, Map<string, number>>, rand: () => number): Map<string, P> {
  const ids = g.nodes.map((n) => n.id)
  const n = ids.length
  const pos = new Map<string, P>(ids.map((id) => [id, { x: rand() * n, y: rand() * n }]))
  for (let it = 0; it < 300; it++) {
    for (const i of ids) {
      let sx = 0, sy = 0, sw = 0
      const pi = pos.get(i)!
      for (const j of ids) {
        if (i === j) continue
        const pj = pos.get(j)!
        const d = dist.get(i)!.get(j) ?? n
        const w = 1 / (d * d)
        const dx = pi.x - pj.x, dy = pi.y - pj.y
        const len = Math.hypot(dx, dy) || 1e-6
        sx += w * (pj.x + (d * dx) / len)
        sy += w * (pj.y + (d * dy) / len)
        sw += w
      }
      pos.set(i, { x: sx / sw, y: sy / sw })
    }
  }
  return pos
}

/** Cercle, dans l'ordre qui croise le moins (échanges successifs de deux nœuds). */
function circular(g: GraphSpec): Map<string, P> {
  const order = g.nodes.map((n) => n.id)
  const n = order.length
  const R = Math.max(1, n / (2 * Math.PI) * 1.4)
  const place = (o: string[]): Map<string, P> => new Map(o.map((id, i) => [id, { x: R * Math.cos((2 * Math.PI * i) / n), y: R * Math.sin((2 * Math.PI * i) / n) }]))
  let best = crossings(g, place(order))
  for (let pass = 0; pass < 6 && best > 0; pass++) {
    let improved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        ;[order[i], order[j]] = [order[j], order[i]]
        const c = crossings(g, place(order))
        if (c < best) {
          best = c
          improved = true
        } else [order[i], order[j]] = [order[j], order[i]]
      }
    }
    if (!improved) break
  }
  return place(order)
}

/** Arbre : racine au centre du graphe, enfants étalés sous leur parent. */
function tree(g: GraphSpec): Map<string, P> {
  const adj = adjacency(g)
  const dist = distances(g)
  // Racine : le nœud le plus central (excentricité minimale)
  let root = g.nodes[0].id
  let ecc = Infinity
  for (const n of g.nodes) {
    const e = Math.max(...dist.get(n.id)!.values())
    if (e < ecc) {
      ecc = e
      root = n.id
    }
  }
  const pos = new Map<string, P>()
  let leaf = 0
  const visit = (id: string, parent: string | null, depth: number): number => {
    const kids = (adj.get(id) ?? []).filter((k) => k !== parent)
    if (!kids.length) {
      pos.set(id, { x: leaf++ * 1.1, y: depth * 1.2 })
      return pos.get(id)!.x
    }
    const xs = kids.map((k) => visit(k, id, depth + 1))
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    pos.set(id, { x, y: depth * 1.2 })
    return x
  }
  visit(root, null, 0)
  return pos
}

function acyclic(g: GraphSpec): boolean {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]))
  for (const e of g.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const q = g.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id)
  let seen = 0
  while (q.length) {
    const id = q.shift()!
    seen++
    for (const e of g.edges) if (e.from === id) {
      indeg.set(e.to, indeg.get(e.to)! - 1)
      if (!indeg.get(e.to)) q.push(e.to)
    }
  }
  return seen === g.nodes.length
}

/** Graphe orienté sans cycle : couches de haut en bas, ordre par barycentre (méthode de Sugiyama). */
function layered(g: GraphSpec): Map<string, P> {
  const layer = new Map<string, number>()
  const order = g.nodes.map((n) => n.id)
  // Plus long chemin depuis les sources
  for (let k = 0; k < order.length; k++) {
    for (const e of g.edges) layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(e.from) ?? 0) + 1))
  }
  const layers: string[][] = []
  for (const id of order) (layers[layer.get(id) ?? 0] ??= []).push(id)
  const idx = new Map<string, number>()
  const reindex = (): void => layers.forEach((l) => l?.forEach((id, i) => idx.set(id, i)))
  reindex()
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0
    const seq = down ? layers.keys() : [...layers.keys()].reverse().values()
    for (const li of seq) {
      const l = layers[li]
      if (!l) continue
      const bary = (id: string): number => {
        const nb = g.edges.filter((e) => (down ? e.to === id : e.from === id)).map((e) => idx.get(down ? e.from : e.to)!)
        return nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : idx.get(id)!
      }
      l.sort((a, b) => bary(a) - bary(b))
      reindex()
    }
  }
  const pos = new Map<string, P>()
  const widest = Math.max(...layers.map((l) => l?.length ?? 0))
  layers.forEach((l, li) => l?.forEach((id, i) => pos.set(id, { x: (i - (l.length - 1) / 2) * 1.3 + widest, y: li * 1.3 })))
  return pos
}

/** Affinage : on bouge un nœud au hasard ; on garde si la note s'améliore (recuit simulé). */
function anneal(g: GraphSpec, start: Map<string, P>, dist: Map<string, Map<string, number>>, rand: () => number): Map<string, P> {
  // Échelle : distance moyenne entre voisins = 1
  const es = uniqueEdges(g)
  const mean = es.reduce((a, [x, y]) => a + Math.hypot(start.get(x)!.x - start.get(y)!.x, start.get(x)!.y - start.get(y)!.y), 0) / Math.max(1, es.length) || 1
  let pos = new Map([...start].map(([k, p]) => [k, { x: p.x / mean, y: p.y / mean }]))
  let cur = score(g, pos, dist)
  const ids = g.nodes.map((n) => n.id)
  const steps = ids.length > 16 ? 1800 : Math.min(4000, 300 * ids.length)
  for (let s = 0; s < steps; s++) {
    const T = 0.6 * (1 - s / steps) + 0.02
    const id = ids[Math.floor(rand() * ids.length)]
    const p = pos.get(id)!
    const next = new Map(pos)
    next.set(id, { x: p.x + (rand() - 0.5) * T * 2, y: p.y + (rand() - 0.5) * T * 2 })
    const sc = score(g, next, dist)
    if (sc < cur || rand() < Math.exp((cur - sc) / (T * 2))) {
      pos = next
      cur = sc
    }
  }
  return pos
}

// --- Dessin ----------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
let measureCtx: CanvasRenderingContext2D | null = null
const widths = new Map<string, number>()
function textWidth(s: string, size: number): number {
  const key = `${size}|${s}`
  const known = widths.get(key)
  if (known !== undefined) return known
  const w = measure(s, size)
  if (widths.size > 2000) widths.clear()
  widths.set(key, w)
  return w
}
function measure(s: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return s.length * size * 0.6
  measureCtx.font = `600 ${size}px Helvetica, Arial, sans-serif`
  return measureCtx.measureText(s).width
}

/** Taille d'un nœud : un rond, ou une pilule si le nom est long. */
export function nodeBox(g: GraphSpec, n: GraphNode): { w: number; h: number } {
  const fs = g.nodeSize * 0.42
  const w = Math.max(g.nodeSize, textWidth(n.label, fs) + fs * 1.2)
  return { w, h: g.nodeSize }
}

/** Échelle du dessin : une unité de mise en page = `UNIT` px. */
export const UNIT = 90

/** Point où une arête touche le bord du nœud (rond ou pilule). */
function border(g: GraphSpec, n: GraphNode, toward: P, at: P): P {
  const { w, h } = nodeBox(g, n)
  const dx = toward.x - at.x, dy = toward.y - at.y
  const L = Math.hypot(dx, dy) || 1
  const ux = dx / L, uy = dy / L
  if (w <= h + 0.5) return { x: at.x + (ux * h) / 2, y: at.y + (uy * h) / 2 }
  // Pilule : demi-largeur rectangulaire + bouts ronds (approximation : ellipse)
  const a = w / 2, b = h / 2
  const t = 1 / Math.sqrt((ux * ux) / (a * a) + (uy * uy) / (b * b))
  return { x: at.x + ux * t, y: at.y + uy * t }
}

/**
 * Dessin SVG du graphe. Les arêtes s'arrêtent au bord des nœuds, les flèches sont des
 * triangles pleins (pas de « marker », mieux rendus partout), les poids sont posés au milieu
 * des arêtes sur un fond blanc. A→B et B→A sont dessinées en deux courbes.
 */
export function renderGraph(g: GraphSpec, opts: { selected?: string | null; pending?: string | null } = {}): { svg: string; width: number; height: number; at: (n: GraphNode) => P; ox: number; oy: number } {
  const pad = g.nodeSize * 1.2
  const xs = g.nodes.map((n) => n.x * UNIT), ys = g.nodes.map((n) => n.y * UNIT)
  const minX = Math.min(0, ...xs), minY = Math.min(0, ...ys)
  const maxX = Math.max(0, ...xs), maxY = Math.max(0, ...ys)
  const at = (n: GraphNode): P => ({ x: n.x * UNIT - minX + pad, y: n.y * UNIT - minY + pad })
  const W = Math.max(g.nodeSize * 2, maxX - minX + pad * 2)
  const H = Math.max(g.nodeSize * 2, maxY - minY + pad * 2)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const color = g.color
  const fs = g.nodeSize * 0.42
  const wfs = g.nodeSize * 0.38
  const parts: string[] = []
  const labels: string[] = []
  g.edges.forEach((e, i) => {
    const a = byId.get(e.from), b = byId.get(e.to)
    if (!a || !b) return
    const pa = at(a), pb = at(b)
    const sel = opts.selected === `e${i}`
    const stroke = sel ? '#ff7a00' : '#3b3f4a'
    const sw = sel ? 3 : 1.8
    if (a === b) {
      // Boucle
      const r = g.nodeSize * 0.45
      const cx = pa.x, cy = pa.y - g.nodeSize / 2 - r * 0.7
      parts.push(`<circle data-edge="${i}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`)
      if (g.weighted && e.weight) labels.push(weightLabel(cx, cy - r - wfs * 0.6, e.weight, wfs))
      return
    }
    const reverse = g.directed && g.edges.some((f) => f.from === e.to && f.to === e.from)
    const bend = reverse ? 0.18 : 0
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2
    const dx = pb.x - pa.x, dy = pb.y - pa.y
    const L = Math.hypot(dx, dy) || 1
    // Point de contrôle (courbe pour les arêtes aller-retour)
    const c = { x: mx - (dy / L) * L * bend, y: my + (dx / L) * L * bend }
    const s = border(g, a, bend ? c : pb, pa)
    const t = border(g, b, bend ? c : pa, pb)
    const d = bend ? `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${t.x} ${t.y}` : `M ${s.x} ${s.y} L ${t.x} ${t.y}`
    parts.push(`<path data-edge="${i}" d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`)
    // Zone de clic plus large (éditeur)
    parts.push(`<path data-edge="${i}" d="${d}" fill="none" stroke="transparent" stroke-width="14" class="hit"/>`)
    if (g.directed) {
      const from = bend ? c : s
      const ux = t.x - from.x, uy = t.y - from.y
      const ul = Math.hypot(ux, uy) || 1
      const k = g.nodeSize * 0.32
      const bx = t.x - (ux / ul) * k, by = t.y - (uy / ul) * k
      const px = (-uy / ul) * k * 0.45, py = (ux / ul) * k * 0.45
      parts.push(`<polygon points="${t.x},${t.y} ${bx + px},${by + py} ${bx - px},${by - py}" fill="${stroke}"/>`)
    }
    if (g.weighted && e.weight !== undefined && e.weight !== '') {
      // Poids au milieu, légèrement à côté de l'arête
      const qx = bend ? 0.25 * s.x + 0.5 * c.x + 0.25 * t.x : mx
      const qy = bend ? 0.25 * s.y + 0.5 * c.y + 0.25 * t.y : my
      const off = wfs * 0.2
      labels.push(weightLabel(qx - (dy / L) * off, qy + (dx / L) * off, e.weight, wfs))
    }
  })
  for (const n of g.nodes) {
    const p = at(n)
    const { w, h } = nodeBox(g, n)
    const sel = opts.selected === n.id || opts.pending === n.id
    const fill = sel ? '#fff3e6' : '#ffffff'
    const stroke = sel ? '#ff7a00' : color
    parts.push(`<rect data-node="${n.id}" x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>`)
    parts.push(`<text data-node="${n.id}" x="${p.x}" y="${p.y + fs * 0.35}" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="600" text-anchor="middle" fill="#1b1c21">${esc(n.label)}</text>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}${labels.join('')}</svg>`
  return { svg, width: W, height: H, at, ox: pad - minX, oy: pad - minY }

  function weightLabel(x: number, y: number, text: string, size: number): string {
    const w = textWidth(text, size) + size * 0.6
    const h = size * 1.25
    return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h * 0.3}" fill="#ffffff" stroke="#d6d9e0" stroke-width="0.8"/><text x="${x}" y="${y + size * 0.36}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" text-anchor="middle" fill="#c2410c">${esc(text)}</text>`
  }
}
