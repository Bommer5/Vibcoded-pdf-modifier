import type { Canvas } from 'fabric'
import JSZip from 'jszip'
import { assets } from '../core/assets'

/**
 * Format projet natif « .feuillet » : archive ZIP lisible
 *   manifest.json   version du format
 *   document.json   scène (pages, calques, objets) — tout reste modifiable
 *   assets/<id>     images et PDF d'origine, octet pour octet
 */
const FORMAT_VERSION = 1

interface Manifest {
  app: 'Feuillet'
  format: number
  assets: { id: string; mime: string }[]
}

type JsonObject = Record<string, unknown> & { objects?: JsonObject[]; src?: string; assetId?: string }

function walk(objects: JsonObject[] | undefined, fn: (o: JsonObject) => void): void {
  for (const o of objects ?? []) {
    fn(o)
    walk(o.objects, fn)
  }
}

export async function saveProject(canvas: Canvas): Promise<Uint8Array> {
  const scene = canvas.toObject() as JsonObject
  const used = new Set<string>()
  walk(scene.objects, (o) => {
    if (o.assetId) used.add(o.assetId)
    if (typeof o.pdfAssetId === 'string') used.add(o.pdfAssetId)
    if (o.assetId) delete o.src // l'URL blob n'a pas de sens hors de la session
  })
  const zip = new JSZip()
  const manifest: Manifest = { app: 'Feuillet', format: FORMAT_VERSION, assets: [] }
  for (const id of used) {
    const asset = assets.get(id)
    if (!asset) continue
    manifest.assets.push({ id, mime: asset.mime })
    zip.file(`assets/${id}`, asset.bytes, { compression: 'STORE' })
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  zip.file('document.json', JSON.stringify(scene))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export async function loadProject(canvas: Canvas, data: Uint8Array): Promise<void> {
  const zip = await JSZip.loadAsync(data)
  const manifest = JSON.parse((await zip.file('manifest.json')?.async('string')) ?? 'null') as Manifest | null
  if (manifest?.app !== 'Feuillet') throw new Error('Ce fichier n’est pas un projet Feuillet')
  if (manifest.format > FORMAT_VERSION) throw new Error('Projet créé par une version plus récente de Feuillet')
  for (const { id, mime } of manifest.assets) {
    const bytes = await zip.file(`assets/${id}`)?.async('uint8array')
    if (bytes) assets.add(bytes, mime, id)
  }
  const scene = JSON.parse((await zip.file('document.json')!.async('string')) ?? '{}') as JsonObject
  walk(scene.objects, (o) => {
    if (o.assetId) o.src = assets.get(o.assetId)?.url ?? ''
  })
  await canvas.loadFromJSON(scene)
  canvas.requestRenderAll()
}
