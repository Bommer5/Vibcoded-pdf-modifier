/**
 * Traits d'écriture → image pour le modèle, normalisée exactement comme à l'entraînement :
 * hauteur 40 px (36 px d'encre entre 2 px de marge), trait d'épaisseur constante, encre 1,
 * fond 0, rangée par rangée (40 × largeur).
 */

export type Stroke = [number, number][]

export const IMG_H = 40
const INK_H = IMG_H - 4
const PEN = 2.4

export interface InkImage {
  data: Float32Array
  width: number
}

export function inkImage(strokes: Stroke[]): InkImage | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) for (const [x, y] of s) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) return null
  // Trait très plat (tiret, signe moins seul) : on ne l'étire pas sur toute la hauteur.
  const h = Math.max(y1 - y0, (x1 - x0) * 0.25, 1e-3)
  const k = INK_H / h
  const w = Math.max(8, Math.round((x1 - x0) * k) + 4)
  if (w > 2400) return null
  const canvas = new OffscreenCanvas(w, IMG_H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.lineWidth = PEN
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#fff'
  ctx.fillStyle = '#fff'
  // Centré verticalement si le trait est plat
  const oy = 2 + (INK_H - (y1 - y0) * k) / 2
  for (const s of strokes) {
    ctx.beginPath()
    if (s.length === 1) {
      ctx.arc(2 + (s[0][0] - x0) * k, oy + (s[0][1] - y0) * k, PEN / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    s.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, 2 + (x - x0) * k, oy + (y - y0) * k))
    ctx.stroke()
  }
  const px = ctx.getImageData(0, 0, w, IMG_H).data
  const data = new Float32Array(w * IMG_H)
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] / 255
  return { data, width: w }
}
