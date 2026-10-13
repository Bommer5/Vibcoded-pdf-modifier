/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import type { Candidate } from './decode'
import type { Stroke } from './ink-image'

/**
 * Moteur d'écriture précis : TrOCR (Microsoft, licence MIT), un modèle « image → texte »
 * entraîné sur de vraies écritures manuscrites. Fichiers téléchargés une fois (au format ONNX
 * de Hugging Face), exécutés ici par onnxruntime (WebAssembly), hors ligne.
 *
 * Chaque ligne de traits est dessinée à l'encre noire sur fond blanc, comme une ligne d'écriture
 * scannée, puis ramenée à 384 × 384 (le format d'entrée du modèle) ; le texte est produit mot
 * à mot (décodage glouton) avec la confiance moyenne de chaque morceau.
 */

interface LoadMsg {
  type: 'load'
  wasm: string
  files: Record<string, ArrayBuffer>
}
interface RunMsg {
  type: 'recognize'
  id: number
  lines: Stroke[][]
}

interface Model {
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  merged: boolean
  heads: number
  headDim: number
  layers: number
  start: number
  eos: number
  size: number
  mean: number[]
  std: number[]
  pieces: string[]
  special: Set<number>
  byteLevel: boolean
}

let model: Promise<Model> | null = null

const json = (b: ArrayBuffer): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b))

async function load(msg: LoadMsg): Promise<Model> {
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { wasm: msg.wasm }
  const file = (prefix: string): ArrayBuffer => {
    const k = Object.keys(msg.files).find((f) => f.startsWith(prefix))
    if (!k) throw new Error(`Fichier manquant : ${prefix}`)
    return msg.files[k]
  }
  const decName = Object.keys(msg.files).find((f) => f.startsWith('onnx/decoder'))!
  const config = json(file('config.json')) as { decoder?: Record<string, number>; decoder_start_token_id?: number; eos_token_id?: number }
  const pre = json(file('preprocessor_config.json')) as { size?: { height?: number } | number; image_mean?: number[]; image_std?: number[] }
  const tok = json(file('tokenizer.json')) as {
    model: { type: string; vocab: [string, number][] | Record<string, number> }
    added_tokens?: { id: number; content: string; special?: boolean }[]
  }
  const dec = config.decoder ?? {}
  const heads = dec.decoder_attention_heads ?? 8
  const dModel = dec.d_model ?? dec.hidden_size ?? 256
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(new Uint8Array(file('onnx/encoder')), opts),
    ort.InferenceSession.create(new Uint8Array(msg.files[decName]), opts)
  ])
  // Vocabulaire : liste « Unigram » (▁ = espace) ou dictionnaire « BPE » au niveau des octets (Ġ)
  const pieces: string[] = []
  if (Array.isArray(tok.model.vocab)) tok.model.vocab.forEach(([p], i) => (pieces[i] = p))
  else for (const [p, i] of Object.entries(tok.model.vocab)) pieces[i] = p
  const special = new Set<number>()
  for (const t of tok.added_tokens ?? []) {
    pieces[t.id] = t.content
    if (t.special) special.add(t.id)
  }
  const size = typeof pre.size === 'number' ? pre.size : pre.size?.height ?? 384
  return {
    encoder,
    decoder,
    merged: decoder.inputNames.some((n) => n.startsWith('past_key_values')),
    heads,
    headDim: dModel / heads,
    layers: dec.decoder_layers ?? 6,
    start: config.decoder_start_token_id ?? dec.decoder_start_token_id ?? 2,
    eos: config.eos_token_id ?? dec.eos_token_id ?? 2,
    size,
    mean: pre.image_mean ?? [0.5, 0.5, 0.5],
    std: pre.image_std ?? [0.5, 0.5, 0.5],
    pieces,
    special,
    byteLevel: tok.model.type === 'BPE'
  }
}

/** Traits d'une ligne → image d'écriture (noir sur blanc) au format du modèle. */
function lineImage(m: Model, strokes: Stroke[]): ort.Tensor | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) for (const [x, y] of s) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) return null
  // Encre ramenée à 64 px de haut, avec de la marge autour (comme une ligne découpée d'une page)
  const INK = 64
  const h = Math.max(y1 - y0, (x1 - x0) * 0.2, 1e-3)
  const k = INK / h
  const pad = INK * 0.3
  const W = Math.min(2000, Math.max(INK * 2, (x1 - x0) * k + pad * 2))
  const H = INK + pad * 2
  const line = new OffscreenCanvas(Math.round(W), Math.round(H))
  const c = line.getContext('2d')!
  c.fillStyle = '#fff'
  c.fillRect(0, 0, line.width, line.height)
  c.strokeStyle = '#000'
  c.fillStyle = '#000'
  c.lineWidth = INK * 0.065
  c.lineCap = 'round'
  c.lineJoin = 'round'
  const ox = pad + (W - pad * 2 - (x1 - x0) * k) / 2
  const oy = pad + (INK - (y1 - y0) * k) / 2
  for (const s of strokes) {
    c.beginPath()
    if (s.length === 1) {
      c.arc(ox + (s[0][0] - x0) * k, oy + (s[0][1] - y0) * k, c.lineWidth / 2, 0, Math.PI * 2)
      c.fill()
      continue
    }
    s.forEach(([x, y], i) => (i ? c.lineTo : c.moveTo).call(c, ox + (x - x0) * k, oy + (y - y0) * k))
    c.stroke()
  }
  // Format d'entrée : carré, étiré comme le fait le préprocesseur du modèle
  const S = m.size
  const sq = new OffscreenCanvas(S, S)
  const q = sq.getContext('2d', { willReadFrequently: true })!
  q.imageSmoothingEnabled = true
  q.imageSmoothingQuality = 'high'
  q.drawImage(line, 0, 0, S, S)
  const px = q.getImageData(0, 0, S, S).data
  const data = new Float32Array(3 * S * S)
  for (let i = 0; i < S * S; i++) {
    for (let ch = 0; ch < 3; ch++) data[ch * S * S + i] = (px[i * 4 + ch] / 255 - m.mean[ch]) / m.std[ch]
  }
  return new ort.Tensor('float32', data, [1, 3, S, S])
}

/** Octets ↔ caractères du BPE « byte-level » (GPT-2 / RoBERTa). */
const byteDecoder = ((): Map<string, number> => {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i)
  for (let i = 161; i <= 172; i++) bs.push(i)
  for (let i = 174; i <= 255; i++) bs.push(i)
  const cs = [...bs]
  let n = 0
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) {
    bs.push(b)
    cs.push(256 + n++)
  }
  return new Map(cs.map((c, i) => [String.fromCharCode(c), bs[i]]))
})()

function detokenize(m: Model, ids: number[]): string {
  const parts = ids.filter((i) => !m.special.has(i) && i !== m.eos && i !== m.start).map((i) => m.pieces[i] ?? '')
  if (m.byteLevel) {
    const bytes = [...parts.join('')].map((ch) => byteDecoder.get(ch) ?? 32)
    return new TextDecoder().decode(new Uint8Array(bytes)).trim()
  }
  return parts.join('').replace(/▁/g, ' ').replace(/\s+/g, ' ').trim()
}

function argmaxLogSoftmax(logits: Float32Array, offset: number, V: number, banned: number): [number, number] {
  let best = 0, max = -Infinity
  for (let v = 0; v < V; v++) if (v !== banned && logits[offset + v] > max) {
    max = logits[offset + v]
    best = v
  }
  let sum = 0
  for (let v = 0; v < V; v++) if (v !== banned) sum += Math.exp(logits[offset + v] - max)
  return [best, -Math.log(sum)]
}

async function recognizeLine(m: Model, strokes: Stroke[]): Promise<Candidate[]> {
  const img = lineImage(m, strokes)
  if (!img) return []
  const enc = await m.encoder.run({ [m.encoder.inputNames[0]]: img })
  const hidden = enc[m.encoder.outputNames[0]]
  const ids = [m.start]
  const lps: number[] = []
  let past: Record<string, ort.Tensor> = {}
  for (let step = 0; step < 64; step++) {
    const feeds: Record<string, ort.Tensor> = {}
    if (m.merged) {
      const first = step === 0
      feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from([BigInt(ids[ids.length - 1])]), [1, 1])
      feeds.encoder_hidden_states = hidden
      feeds.use_cache_branch = new ort.Tensor('bool', [!first], [1])
      for (const name of m.decoder.inputNames) {
        if (!name.startsWith('past_key_values')) continue
        feeds[name] = first ? new ort.Tensor('float32', new Float32Array(0), [1, m.heads, 0, m.headDim]) : past[name]
      }
    } else {
      feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
      feeds.encoder_hidden_states = hidden
    }
    const out = await m.decoder.run(feeds)
    const logits = out.logits
    const [, T, V] = logits.dims as number[]
    // Au moins un morceau de texte : une fin immédiate ne lirait rien
    const [next, lp] = argmaxLogSoftmax(logits.data as Float32Array, (T - 1) * V, V, step === 0 ? m.eos : -1)
    if (m.merged) {
      const nextPast: Record<string, ort.Tensor> = {}
      for (const [name, t] of Object.entries(out)) {
        if (!name.startsWith('present')) continue
        const key = name.replace('present', 'past_key_values')
        // Les clés de l'encodeur ne sont calculées qu'au premier pas : on les garde
        nextPast[key] = step > 0 && key.includes('.encoder.') ? past[key] : t
      }
      past = nextPast
    }
    lps.push(lp)
    if (next === m.eos) break
    ids.push(next)
  }
  const text = detokenize(m, ids)
  if (!text) return []
  const mean = lps.reduce((a, b) => a + b, 0) / Math.max(1, lps.length)
  return [{ text, score: mean * Math.max(1, text.length), lexicon: false, lm: 0, conf: Math.exp(mean) }]
}

self.onmessage = async (e: MessageEvent<LoadMsg | RunMsg>) => {
  const msg = e.data
  if (msg.type === 'load') {
    model = load(msg)
    model.then(() => self.postMessage({ type: 'loaded' }), (err) => self.postMessage({ type: 'loaded', error: String(err?.message ?? err) }))
    return
  }
  try {
    if (!model) throw new Error('Moteur non chargé')
    const m = await model
    const results: Candidate[][] = []
    for (const line of msg.lines) results.push(await recognizeLine(m, line))
    self.postMessage({ id: msg.id, results })
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err as Error)?.message ?? err) })
  }
}
