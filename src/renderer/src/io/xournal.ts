import { FabricImage, IText, Path, type FabricObject } from 'fabric'
import { assets } from '../core/assets'
import type { DocumentModel, Page } from '../core/document'
import type { Obj } from '../core/props'
import { platform } from '../platform'
import type { PaperStyle } from '../core/paper'
import { pdfEngine } from '../pdf/engine'

/**
 * Import des carnets Xournal++ (.xopp) et Xournal (.xoj) : XML compressé gzip.
 * Traits (stylo, surligneur), textes, images, fonds papier et PDF de fond.
 */

const NAMED_COLORS: Record<string, string> = {
  black: '#000000ff', blue: '#3333ccff', red: '#ff0000ff', green: '#008000ff', gray: '#808080ff',
  lightblue: '#00c0ffff', lightgreen: '#00ff00ff', magenta: '#ff00ffff', orange: '#ff8000ff',
  yellow: '#ffff00ff', white: '#ffffffff'
}

function parseColor(value: string | null, fallback = '#000000ff'): { color: string; alpha: number } {
  const raw = NAMED_COLORS[value ?? ''] ?? value ?? fallback
  const hex = raw.startsWith('#') ? raw.slice(1) : raw
  const alpha = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return { color: '#' + hex.slice(0, 6), alpha }
}

async function gunzip(data: Uint8Array): Promise<string> {
  // Les .xoj très anciens peuvent être du XML non compressé.
  if (data[0] !== 0x1f || data[1] !== 0x8b) return new TextDecoder().decode(data)
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

export async function importXournal(
  data: Uint8Array,
  sourcePath: string | undefined,
  doc: DocumentModel,
  add: (o: FabricObject) => void
): Promise<Page[]> {
  const xml = new DOMParser().parseFromString(await gunzip(data), 'application/xml')
  if (xml.querySelector('parsererror')) throw new Error('Fichier Xournal illisible')

  let pdf: { pages: number; assetId: string } | null = null
  const pages: Page[] = []

  for (const pageEl of Array.from(xml.querySelectorAll('xournal > page'))) {
    const size = { width: Number(pageEl.getAttribute('width')), height: Number(pageEl.getAttribute('height')) }
    const bg = pageEl.querySelector('background')
    let page: Page

    if (bg?.getAttribute('type') === 'pdf') {
      const filename = bg.getAttribute('filename')
      if (filename && !pdf) pdf = await loadReferencedPdf(filename, sourcePath)
      const index = parseInt(bg.getAttribute('pageno') ?? '1', 10) - 1
      if (pdf && index < pdf.pages) {
        page = doc.addPage(size, { bg: { kind: 'pdf', assetId: pdf.assetId, index } })
      } else {
        page = await doc.addPage(size)
      }
    } else if (bg?.getAttribute('type') === 'pixmap') {
      page = await doc.addPage(size)
    } else {
      const style = (bg?.getAttribute('style') ?? 'plain') as PaperStyle
      const { color } = parseColor(bg?.getAttribute('color') ?? '#ffffffff')
      page = doc.addPage(size, style === 'plain' && color === '#ffffff' ? {} : { bg: { kind: 'paper', style, color } })
    }
    pages.push(page)

    for (const layer of Array.from(pageEl.querySelectorAll(':scope > layer'))) {
      const layerName = layer.getAttribute('name') ?? undefined
      for (const el of Array.from(layer.children)) {
        const obj = await convertElement(el, page)
        if (!obj) continue
        ;(obj as Obj).layerName = layerName
        add(obj)
      }
    }
  }
  return pages
}

async function loadReferencedPdf(
  filename: string,
  sourcePath: string | undefined
): Promise<{ pages: number; assetId: string } | null> {
  const candidates = [filename]
  if (sourcePath) {
    const dir = sourcePath.replace(/[\\/][^\\/]*$/, '')
    const base = filename.split(/[\\/]/).pop()!
    candidates.push(`${dir}/${base}`, sourcePath.replace(/\.(xopp|xoj)$/i, '.pdf'))
  }
  for (const path of candidates) {
    const bytes = await platform.readReferencedPdf(path)
    if (!bytes) continue
    const asset = assets.add(bytes, 'application/pdf')
    return { pages: (await pdfEngine.open(asset.id, bytes)).length, assetId: asset.id }
  }
  return null
}

async function convertElement(el: Element, page: Page): Promise<FabricObject | null> {
  const dx = page.left
  const dy = page.top
  switch (el.tagName) {
    case 'stroke': {
      const nums = (el.textContent ?? '').trim().split(/\s+/).map(Number)
      if (nums.length < 4) return null
      const widths = (el.getAttribute('width') ?? '1').trim().split(/\s+/).map(Number)
      // Xournal++ : 1re valeur = épaisseur nominale, les suivantes = épaisseur par point (pression).
      const width = widths.length > 1 ? widths.slice(1).reduce((a, b) => a + b, 0) / (widths.length - 1) : widths[0]
      let d = `M ${nums[0] + dx} ${nums[1] + dy}`
      for (let i = 2; i + 1 < nums.length; i += 2) d += ` L ${nums[i] + dx} ${nums[i + 1] + dy}`
      const tool = el.getAttribute('tool')
      const { color, alpha } = parseColor(el.getAttribute('color'))
      return new Path(d, {
        fill: '',
        stroke: color,
        strokeWidth: width,
        strokeLineCap: el.getAttribute('capStyle') === 'butt' ? 'butt' : 'round',
        strokeLineJoin: 'round',
        opacity: tool === 'highlighter' ? Math.min(alpha, 0.5) : alpha,
        globalCompositeOperation: tool === 'highlighter' ? 'multiply' : 'source-over'
      })
    }
    case 'text': {
      const { color, alpha } = parseColor(el.getAttribute('color'))
      return new IText(el.textContent ?? '', {
        left: Number(el.getAttribute('x')) + dx,
        top: Number(el.getAttribute('y')) + dy,
        fontFamily: el.getAttribute('font') ?? 'Sans',
        fontSize: Number(el.getAttribute('size') ?? 12),
        fill: color,
        opacity: alpha
      })
    }
    case 'image': {
      const b64 = (el.textContent ?? '').trim()
      if (!b64) return null
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const asset = assets.add(bytes, 'image/png')
      const img = await FabricImage.fromURL(asset.url)
      const [l, t, r, b] = ['left', 'top', 'right', 'bottom'].map((k) => Number(el.getAttribute(k)))
      img.set({ left: l + dx, top: t + dy, scaleX: (r - l) / img.width, scaleY: (b - t) / img.height, assetId: asset.id } as Partial<Obj>)
      return img
    }
    default:
      return null
  }
}
