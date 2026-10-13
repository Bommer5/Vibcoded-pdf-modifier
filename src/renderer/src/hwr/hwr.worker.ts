/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import { buildTrie, decode, logSoftmax, type Candidate, type TrieNode } from './decode'
import { inkImage, type Stroke } from './ink-image'

/**
 * Reconnaissance d'écriture sur l'appareil (hors ligne) : modèle CRNN entraîné pour Feuillet
 * (lettres, accents, chiffres, ponctuation, symboles mathématiques) exécuté par onnxruntime
 * (WebAssembly), puis lecture avec le dictionnaire français.
 */

interface Req {
  id: number
  base: string
  wasm: string
  lines: Stroke[][]
}

let session: Promise<{ s: ort.InferenceSession; charset: string[]; trie: TrieNode }> | null = null

function load(base: string, wasm: string): NonNullable<typeof session> {
  session ??= (async () => {
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = { wasm }
    const [model, meta, lexicon] = await Promise.all([
      fetch(new URL('hwr/hwr.onnx', base)).then((r) => r.arrayBuffer()),
      fetch(new URL('hwr/charset.json', base)).then((r) => r.json() as Promise<{ charset: string }>),
      fetch(new URL('hwr/fr-lexicon.json', base)).then((r) => r.json() as Promise<[string, number][]>)
    ])
    const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    return { s, charset: [...meta.charset], trie: buildTrie(lexicon) }
  })()
  return session
}

async function recognize(base: string, wasm: string, strokes: Stroke[]): Promise<Candidate[]> {
  const { s, charset, trie } = await load(base, wasm)
  const img = inkImage(strokes)
  if (!img) return []
  const input = new ort.Tensor('float32', img.data, [1, 1, 40, img.width])
  const out = await s.run({ image: input })
  const logits = out.logits
  const [, T, C] = logits.dims as number[]
  const lp = logSoftmax(logits.data as Float32Array, T, C)
  return decode(lp, T, C, charset, trie)
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, base, wasm, lines } = e.data
  try {
    const results: Candidate[][] = []
    for (const line of lines) results.push(await recognize(base, wasm, line))
    self.postMessage({ id, results })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
