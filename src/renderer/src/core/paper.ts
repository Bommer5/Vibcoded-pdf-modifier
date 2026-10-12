import type { Size } from './document'

/** Fonds « papier » vectoriels (mêmes styles que Xournal++) : nets à tout zoom, sans image. */
export type PaperStyle = 'plain' | 'lined' | 'ruled' | 'graph' | 'dotted' | 'isodotted' | 'isograph' | 'staves'

export const PAPER_STYLES: { id: PaperStyle; label: string }[] = [
  { id: 'plain', label: 'Uni' },
  { id: 'ruled', label: 'Ligné' },
  { id: 'lined', label: 'Ligné avec marge' },
  { id: 'graph', label: 'Petits carreaux' },
  { id: 'dotted', label: 'Pointillés' },
  { id: 'isodotted', label: 'Points isométriques' },
  { id: 'isograph', label: 'Grille isométrique' },
  { id: 'staves', label: 'Portées (musique)' }
]

interface Primitives {
  lines: [number, number, number, number, string][]
  dots: [number, number][]
}

const BLUE = '#a8c4e6'
const STEP = 14.17 // 5 mm

/** Géométrie du motif (partagée par l'écran, les images exportées, le SVG et le PDF). */
export function paperPrimitives(size: Size, style: PaperStyle): Primitives {
  const { width: W, height: H } = size
  const lines: Primitives['lines'] = []
  const dots: Primitives['dots'] = []
  switch (style) {
    case 'lined':
    case 'ruled':
      for (let y = 80; y < H - 20; y += 24) lines.push([0, y, W, y, BLUE])
      if (style === 'lined') lines.push([72, 0, 72, H, '#ff7f7f'])
      break
    case 'graph':
      for (let x = STEP; x < W; x += STEP) lines.push([x, 0, x, H, BLUE])
      for (let y = STEP; y < H; y += STEP) lines.push([0, y, W, y, BLUE])
      break
    case 'dotted':
      for (let x = STEP; x < W; x += STEP) for (let y = STEP; y < H; y += STEP) dots.push([x, y])
      break
    case 'isodotted': {
      const h = (STEP * Math.sqrt(3)) / 2
      for (let row = 0, y = h; y < H; y += h, row++) for (let x = row % 2 ? STEP / 2 : STEP; x < W; x += STEP) dots.push([x, y])
      break
    }
    case 'isograph': {
      const h = (STEP * Math.sqrt(3)) / 2
      for (let y = 0; y < H; y += h) lines.push([0, y, W, y, BLUE])
      const dx = H / Math.sqrt(3)
      for (let x = -dx; x < W + dx; x += STEP) {
        lines.push([x, 0, x + dx, H, BLUE])
        lines.push([x, 0, x - dx, H, BLUE])
      }
      break
    }
    case 'staves':
      for (let top = 60; top + 40 < H - 40; top += 70) for (let i = 0; i < 5; i++) lines.push([40, top + i * 8, W - 40, top + i * 8, '#7f7f7f'])
      break
  }
  return { lines, dots }
}

export function drawPaper(ctx: CanvasRenderingContext2D, size: Size, style: PaperStyle, color: string): void {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, size.width, size.height)
  const { lines, dots } = paperPrimitives(size, style)
  ctx.lineWidth = 0.5
  let current = ''
  ctx.beginPath()
  for (const [x1, y1, x2, y2, c] of lines) {
    if (c !== current) {
      ctx.stroke()
      ctx.beginPath()
      ctx.strokeStyle = current = c
    }
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
  }
  ctx.stroke()
  ctx.fillStyle = '#9ab0cc'
  for (const [x, y] of dots) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
}

export function paperSvg(size: Size, style: PaperStyle, color: string): string {
  const { lines, dots } = paperPrimitives(size, style)
  return (
    `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${color}"/>` +
    lines.map(([a, b, c, d, s]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${s}" stroke-width="0.5"/>`).join('') +
    dots.map(([x, y]) => `<rect x="${x - 0.75}" y="${y - 0.75}" width="1.5" height="1.5" fill="#9ab0cc"/>`).join('')
  )
}
