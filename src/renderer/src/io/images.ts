import { readPsd } from 'ag-psd'
import * as UTIF from 'utif2'
import { assets, type Asset } from '../core/assets'
import { canvasToBlob } from './pdf'

/** Formats décodés nativement par le moteur (Chromium / WebView). */
export const NATIVE_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur', 'apng']
/** Formats décodés par une bibliothèque embarquée. */
export const DECODED_IMAGE_EXT = ['tif', 'tiff', 'psd']

const MIME: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  pjpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  svg: 'image/svg+xml'
}

export function mimeFor(ext: string): string {
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Convertit n'importe quelle image prise en charge en ressources affichables.
 * Un TIFF multipage donne plusieurs images.
 */
export async function decodeImage(ext: string, data: Uint8Array): Promise<Asset[]> {
  if (NATIVE_IMAGE_EXT.includes(ext)) return [assets.add(data, mimeFor(ext))]
  if (ext === 'tif' || ext === 'tiff') return decodeTiff(data)
  if (ext === 'psd') return [await decodePsd(data)]
  throw new Error(`Format d'image non pris en charge : .${ext}`)
}

async function decodeTiff(data: Uint8Array): Promise<Asset[]> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const ifds = UTIF.decode(buffer).filter((ifd) => ifd['t256'] && ifd['t257'])
  const out: Asset[] = []
  for (const ifd of ifds) {
    UTIF.decodeImage(buffer, ifd)
    const rgba = UTIF.toRGBA8(ifd)
    const canvas = document.createElement('canvas')
    canvas.width = ifd.width
    canvas.height = ifd.height
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0)
    out.push(await assets.addBlob(await canvasToBlob(canvas, 'image/png')))
  }
  if (out.length === 0) throw new Error('TIFF illisible')
  return out
}

async function decodePsd(data: Uint8Array): Promise<Asset> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const psd = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: true })
  if (!psd.canvas) throw new Error('Ce PSD ne contient pas d’image composite (enregistrez-le avec « Maximiser la compatibilité »)')
  return assets.addBlob(await canvasToBlob(psd.canvas as HTMLCanvasElement, 'image/png'))
}
