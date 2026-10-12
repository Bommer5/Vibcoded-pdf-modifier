import type { Canvas } from 'fabric'
import { assets } from '../core/assets'

/**
 * Format projet natif « .feuillet » : archive ZIP lisible
 *   manifest.json   version du format
 *   document.json   scène (pages, calques, objets) — tout reste modifiable
 *   assets/<id>     images et PDF d'origine, octet pour octet
 */
const FORMAT_VERSION = 2

interface Manifest {
  app: 'Feuillet'
  format: number
  assets: { id: string; mime: string }[]
}

type JsonObject = Record<string, unknown> & {
  objects?: JsonObject[]
  src?: string
  assetId?: string
  bg?: { assetId?: string }
  pdfPage?: { assetId?: string }
  pdfFonts?: { asset?: string }[]
}

function walk(objects: JsonObject[] | undefined, fn: (o: JsonObject) => void): void {
  for (const o of objects ?? []) {
    fn(o)
    walk(o.objects, fn)
  }
}

export async function saveProject(
  canvas: Canvas,
  extra: Record<string, unknown> = {},
  opts: { exclude?: Set<string> } = {}
): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip')
  const scene = canvas.toObject() as JsonObject
  const used = new Set<string>()
  walk(scene.objects, (o) => {
    if (o.assetId) used.add(o.assetId)
    if (o.bg?.assetId) used.add(o.bg.assetId)
    // Page de PDF insérée comme image : on garde aussi le PDF d'origine (export vectoriel).
    if (o.pdfPage?.assetId) used.add(o.pdfPage.assetId)
    // Polices d'origine reconstruites d'un texte de PDF modifié.
    for (const f of o.pdfFonts ?? []) if (f.asset) used.add(f.asset)
    if (o.assetId) delete o.src // l'URL blob n'a pas de sens hors de la session
  })
  const zip = new JSZip()
  const manifest: Manifest = { app: 'Feuillet', format: FORMAT_VERSION, assets: [] }
  for (const id of used) {
    if (opts.exclude?.has(id)) continue
    const asset = assets.get(id)
    if (!asset) continue
    manifest.assets.push({ id, mime: asset.mime })
    zip.file(`assets/${id}`, asset.bytes, { compression: 'STORE' })
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  zip.file('document.json', JSON.stringify({ ...scene, ...extra }))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export async function loadProject(
  canvas: Canvas,
  data: Uint8Array,
  remap?: (scene: Record<string, unknown> & { objects?: Record<string, unknown>[] }) => void
): Promise<Record<string, unknown>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(data)
  const manifest = JSON.parse((await zip.file('manifest.json')?.async('string')) ?? 'null') as Manifest | null
  if (manifest?.app !== 'Feuillet') throw new Error('Ce fichier n’est pas un projet Feuillet')
  if (manifest.format > FORMAT_VERSION) throw new Error('Projet créé par une version plus récente de Feuillet')
  for (const { id, mime } of manifest.assets) {
    const bytes = await zip.file(`assets/${id}`)?.async('uint8array')
    if (bytes) assets.add(bytes, mime, id)
  }
  const scene = JSON.parse((await zip.file('document.json')!.async('string')) ?? '{}') as JsonObject
  if (manifest.format < 2) migrateV1(scene)
  remap?.(scene)
  walk(scene.objects, (o) => {
    if (o.assetId) o.src = assets.get(o.assetId)?.url ?? ''
  })
  await canvas.loadFromJSON(scene)
  canvas.requestRenderAll()
  return scene
}

/**
 * Format 1 : les fonds de page étaient des images séparées (role 'page-bg').
 * Format 2 : la page porte la description de son fond, rendue à la demande.
 */
function migrateV1(scene: JsonObject): void {
  const objects = scene.objects ?? []
  const backgrounds = new Map(objects.filter((o) => o.role === 'page-bg').map((o) => [o.pageId as string, o]))
  for (const o of objects) {
    if (o.role !== 'page') continue
    o.type = 'Page'
    const bgObj = backgrounds.get(o.pageId as string)
    if (typeof o.pdfAssetId === 'string') o.bg = { kind: 'pdf', assetId: o.pdfAssetId, index: o.pdfPageIndex ?? 0 } as never
    else if (bgObj?.assetId) o.bg = { kind: 'image', assetId: bgObj.assetId } as never
    else o.bg = { kind: 'blank' } as never
  }
  scene.objects = objects.filter((o) => o.role !== 'page-bg')
}
