import { Path, Point, util, type FabricObject } from 'fabric'
import { getStroke } from 'perfect-freehand'
import type { Obj } from '../core/props'
import { dashArray, type LineStyle } from './settings'

/** Point d'encre : x, y (coordonnées document), pression 0..1. */
export type InkPoint = [number, number, number]

export interface InkData {
  tool: 'pen' | 'highlighter'
  /** Points dans le repère du tracé (celui des coordonnées du chemin SVG). */
  points: InkPoint[]
  size: number
  color: string
  style: LineStyle
  pressure: boolean
}

export type InkObject = Path & Obj & { ink?: InkData }

/**
 * Construit un trait :
 *  - plein : contour lissé à épaisseur variable (perfect-freehand, comme tldraw / Excalidraw) ;
 *  - tirets / pointillés / surligneur : ligne centrale de largeur constante.
 */
export function buildInk(data: InkData): InkObject {
  const { points, size, color, style, tool } = data
  let path: InkObject
  if (tool === 'pen' && style === 'solid') {
    const outline = getStroke(points, {
      size: size * 1.6,
      thinning: data.pressure ? 0.55 : 0,
      smoothing: 0.5,
      streamline: 0.45,
      simulatePressure: false,
      last: true
    })
    path = new Path(outlineToSvg(outline.length > 2 ? outline : dot(points[0], size)), {
      fill: color,
      stroke: undefined,
      strokeWidth: 0
    }) as InkObject
  } else {
    const d = points.length === 1 ? `M ${points[0][0]} ${points[0][1]} L ${points[0][0] + 0.01} ${points[0][1]}` : centerline(points)
    path = new Path(d, {
      fill: '',
      stroke: color,
      strokeWidth: size,
      strokeLineCap: tool === 'highlighter' ? 'butt' : 'round',
      strokeLineJoin: 'round',
      strokeDashArray: tool === 'pen' ? dashArray(style, size) : null
    }) as InkObject
    if (tool === 'highlighter') path.set({ opacity: 0.45, globalCompositeOperation: 'multiply' })
  }
  path.ink = data
  path.set({ perPixelTargetFind: true })
  return path
}

function dot(p: InkPoint, size: number): number[][] {
  const r = size / 2
  return Array.from({ length: 12 }, (_, i) => [p[0] + r * Math.cos((i / 12) * Math.PI * 2), p[1] + r * Math.sin((i / 12) * Math.PI * 2)])
}

function outlineToSvg(pts: number[][]): string {
  if (pts.length === 0) return ''
  const [first, ...rest] = pts
  let d = `M ${first[0]} ${first[1]} Q`
  for (let i = 0; i < rest.length; i++) {
    const [x0, y0] = rest[i]
    const [x1, y1] = rest[(i + 1) % rest.length]
    d += ` ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`
  }
  return d + ' Z'
}

function centerline(pts: InkPoint[]): string {
  if (pts.length < 3) return `M ${pts[0][0]} ${pts[0][1]} L ${pts.at(-1)![0]} ${pts.at(-1)![1]}`
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    d += ` Q ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`
  }
  const last = pts.at(-1)!
  return d + ` L ${last[0]} ${last[1]}`
}

/** Points du trait en coordonnées document, en tenant compte des déplacements / redimensionnements. */
export function scenePoints(obj: InkObject): InkPoint[] {
  const m = obj.calcTransformMatrix()
  const off = obj.pathOffset
  return obj.ink!.points.map(([x, y, p]) => {
    const q = util.transformPoint(new Point(x - off.x, y - off.y), m)
    return [q.x, q.y, p]
  })
}

/**
 * Gomme partielle : retire les points proches de `at` et coupe le trait en morceaux.
 * Renvoie les nouveaux traits (vide si tout est effacé) ou null si rien n'est touché.
 */
export function eraseInk(obj: InkObject, at: Point, radius: number): InkObject[] | null {
  // Densifie le trait : une ligne droite n'a que 2 points, mais doit pouvoir être coupée au milieu.
  const pts = densify(scenePoints(obj), Math.max(0.5, radius / 2))
  const scale = (Math.abs(obj.scaleX) + Math.abs(obj.scaleY)) / 2
  const reach = radius + (obj.ink!.size * scale) / 2
  const hit = pts.map(([x, y]) => Math.hypot(x - at.x, y - at.y) <= reach)
  if (!hit.some(Boolean)) return null
  const runs: InkPoint[][] = []
  let current: InkPoint[] = []
  pts.forEach((p, i) => {
    if (hit[i]) {
      if (current.length) runs.push(current)
      current = []
    } else current.push(p)
  })
  if (current.length) runs.push(current)
  return runs
    .filter((r) => r.length > 1)
    .map((r) => {
      const piece = buildInk({ ...obj.ink!, points: r, size: obj.ink!.size * scale })
      piece.set({ opacity: obj.opacity, globalCompositeOperation: obj.globalCompositeOperation })
      return piece
    })
}

function densify(pts: InkPoint[], step: number): InkPoint[] {
  const out: InkPoint[] = []
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i])
    const next = pts[i + 1]
    if (!next) break
    const d = Math.hypot(next[0] - pts[i][0], next[1] - pts[i][1])
    for (let k = 1; k < d / step; k++) {
      const t = (k * step) / d
      out.push([pts[i][0] + (next[0] - pts[i][0]) * t, pts[i][1] + (next[1] - pts[i][1]) * t, pts[i][2] + (next[2] - pts[i][2]) * t])
    }
  }
  return out
}

/** Distance d'un point à un segment (gomme « trait entier » pour les formes). */
export function nearObject(obj: FabricObject, at: Point, radius: number): boolean {
  const r = obj.getBoundingRect()
  if (at.x < r.left - radius || at.x > r.left + r.width + radius || at.y < r.top - radius || at.y > r.top + r.height + radius) return false
  if ((obj as InkObject).ink) return scenePoints(obj as InkObject).some(([x, y]) => Math.hypot(x - at.x, y - at.y) <= radius + 2)
  return true
}
