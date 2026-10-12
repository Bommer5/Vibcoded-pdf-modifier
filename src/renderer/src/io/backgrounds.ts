import { assets, type Asset } from '../core/assets'
import type { Size } from '../core/document'
import { canvasToBlob } from './pdf'

/** Fonds de page « papier » (mêmes styles que Xournal++). */
export type PaperStyle = 'plain' | 'lined' | 'ruled' | 'graph' | 'dotted' | 'isodotted' | 'isograph' | 'staves'

const SCALE = 2

/** Génère l'image d'un fond de page. Renvoie null pour un fond uni blanc. */
export async function paperBackground(size: Size, style: PaperStyle, color = '#ffffff'): Promise<Asset | null> {
  if (style === 'plain' && color.toLowerCase().startsWith('#ffffff')) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(size.width * SCALE)
  canvas.height = Math.round(size.height * SCALE)
  const ctx = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = color.slice(0, 7)
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.strokeStyle = '#a8c4e6'
  ctx.fillStyle = '#9ab0cc'
  ctx.lineWidth = 0.5

  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  const step = 14.17 // 5 mm, comme Xournal++
  switch (style) {
    case 'lined':
    case 'ruled':
      for (let y = 80; y < size.height - 20; y += 24) line(0, y, size.width, y)
      if (style === 'lined') {
        ctx.strokeStyle = '#ff7f7f'
        line(72, 0, 72, size.height)
      }
      break
    case 'graph':
      for (let x = step; x < size.width; x += step) line(x, 0, x, size.height)
      for (let y = step; y < size.height; y += step) line(0, y, size.width, y)
      break
    case 'dotted':
      for (let x = step; x < size.width; x += step)
        for (let y = step; y < size.height; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
      break
    case 'isodotted':
    case 'isograph': {
      const h = step * Math.sqrt(3) / 2
      if (style === 'isograph') {
        for (let y = 0; y < size.height; y += h) line(0, y, size.width, y)
        for (let x = -size.height; x < size.width + size.height; x += step) {
          line(x, 0, x + size.height / Math.sqrt(3), size.height)
          line(x, 0, x - size.height / Math.sqrt(3), size.height)
        }
      } else {
        for (let row = 0, y = h; y < size.height; y += h, row++)
          for (let x = row % 2 ? step / 2 : step; x < size.width; x += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
      }
      break
    }
    case 'staves':
      ctx.strokeStyle = '#7f7f7f'
      for (let top = 60; top + 40 < size.height - 40; top += 70)
        for (let i = 0; i < 5; i++) line(40, top + i * 8, size.width - 40, top + i * 8)
      break
  }
  return assets.addBlob(await canvasToBlob(canvas, 'image/png'))
}
