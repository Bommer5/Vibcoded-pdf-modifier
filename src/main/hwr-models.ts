import { app, net, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Moteur d'écriture précis (TrOCR, Microsoft, licence MIT, entraîné sur de vraies écritures) :
 * téléchargé une seule fois depuis Hugging Face dans les données de l'application, puis utilisé
 * hors ligne. FEUILLET_HWR_DIR (tests) : dossier local à utiliser à la place du téléchargement.
 */
export const HWR_REPO = 'Xenova/trocr-small-handwritten'

/** Fichiers nécessaires ; pour le décodeur, le premier nom qui existe dans le dépôt. */
const FILES: string[][] = [
  ['config.json'],
  ['tokenizer.json'],
  ['preprocessor_config.json'],
  ['onnx/encoder_model_quantized.onnx', 'onnx/encoder_model.onnx'],
  ['onnx/decoder_model_merged_quantized.onnx', 'onnx/decoder_model_quantized.onnx', 'onnx/decoder_model_merged.onnx', 'onnx/decoder_model.onnx']
]

const dir = (): string => join(app.getPath('userData'), 'hwr-models', HWR_REPO.replace('/', '--'))
const manifest = (): string => join(dir(), 'files.json')

/** Fichiers déjà téléchargés (chemins relatifs), ou null si le moteur n'est pas installé. */
export async function installed(): Promise<string[] | null> {
  try {
    const list = JSON.parse(await readFile(manifest(), 'utf8')) as string[]
    return list.every((f) => existsSync(join(dir(), f))) ? list : null
  } catch {
    return null
  }
}

async function fetchTo(url: string, dest: string, onBytes: (n: number, total: number) => void): Promise<boolean> {
  const local = process.env.FEUILLET_HWR_DIR
  if (local) {
    const src = join(local, url)
    if (!existsSync(src)) return false
    const data = await readFile(src)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, data)
    onBytes(data.length, data.length)
    return true
  }
  const res = await net.fetch(`https://huggingface.co/${HWR_REPO}/resolve/main/${url}`)
  if (res.status === 404) return false
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let got = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onBytes(got, total)
  }
  await mkdir(dirname(dest), { recursive: true })
  // Écriture sûre : un fichier coupé en route n'est jamais pris pour un fichier complet
  await writeFile(dest + '.part', Buffer.concat(chunks))
  await rename(dest + '.part', dest)
  return true
}

let downloading: Promise<string[]> | null = null

/** Télécharge le moteur (une fois) en signalant la progression à la fenêtre. */
export function download(wc: WebContents): Promise<string[]> {
  downloading ??= (async () => {
    const got: string[] = []
    let done = 0
    for (const options of FILES) {
      let ok = false
      for (const f of options) {
        const dest = join(dir(), f)
        if (existsSync(dest) && (await stat(dest)).size > 0) ok = true
        else ok = await fetchTo(f, dest, (n, total) => wc.send('hwr:progress', { file: f, loaded: done + n, total: total ? done + total : 0, step: got.length + 1, steps: FILES.length }))
        if (ok) {
          got.push(f)
          done += (await stat(dest)).size
          break
        }
      }
      if (!ok) throw new Error(`Fichier introuvable : ${options[0]}`)
    }
    await writeFile(manifest(), JSON.stringify(got))
    return got
  })().finally(() => (downloading = null))
  return downloading
}

export async function readModelFile(name: string): Promise<Uint8Array> {
  if (name.includes('..')) throw new Error('Chemin refusé')
  return new Uint8Array(await readFile(join(dir(), name)))
}

export async function remove(): Promise<void> {
  await rm(dir(), { recursive: true, force: true })
}
