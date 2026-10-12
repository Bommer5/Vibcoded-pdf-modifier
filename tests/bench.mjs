// Banc d'essai : noyau natif (Rust/WASM) contre JavaScript. node tests/bench.mjs
import { existsSync, readFileSync } from 'node:fs'
import UTIF from 'utif2'

const wasm = await WebAssembly.instantiate(readFileSync('src/renderer/src/native/feuillet_core.wasm'), {})
const api = wasm.instance.exports
const time = (label, fn, runs = 5) => {
  fn()
  const t = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const ms = (performance.now() - t) / runs
  console.log(`${label.padEnd(44)} ${ms.toFixed(2)} ms`)
  return ms
}

// 1. Gomme sur un trait de 20 000 points (≈ une longue page d'écriture)
const n = 20000
const flat = new Float32Array(n * 3)
for (let i = 0; i < n; i++) { flat[i * 3] = i * 0.5; flat[i * 3 + 1] = 100 + Math.sin(i / 30) * 40; flat[i * 3 + 2] = 0.5 }
const jsErase = () => {
  const pts = []
  for (let i = 0; i < n; i++) {
    pts.push([flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]])
    if (i + 1 < n) {
      const d = Math.hypot(flat[i * 3 + 3] - flat[i * 3], flat[i * 3 + 4] - flat[i * 3 + 1])
      for (let k = 1; k < d / 2; k++) { const t = (k * 2) / d; pts.push([flat[i * 3] + (flat[i * 3 + 3] - flat[i * 3]) * t, flat[i * 3 + 1] + (flat[i * 3 + 4] - flat[i * 3 + 1]) * t, 0.5]) }
    }
  }
  const runs = []; let cur = []
  for (const p of pts) { if (Math.hypot(p[0] - 5000, p[1] - 100) <= 8) { if (cur.length) runs.push(cur); cur = [] } else cur.push(p) }
  if (cur.length) runs.push(cur)
  return runs
}
const nativeErase = () => {
  const ptr = api.alloc(flat.byteLength)
  new Float32Array(api.memory.buffer, ptr, flat.length).set(flat)
  const res = api.erase(ptr, n, 3, 5000, 100, 8, 2)
  if (res) { const total = new DataView(api.memory.buffer, res, 4).getUint32(0, true); api.dealloc(res, total) }
  api.dealloc(ptr, flat.byteLength)
}
const a = time('Gomme, trait de 20 000 points — JavaScript', jsErase)
const b = time('Gomme, trait de 20 000 points — Rust/WASM', nativeErase)
console.log(`  → gain ×${(a / b).toFixed(1)}`)

// 2. Décodage TIFF (scan A4 300 ppp)
for (const file of ['scan-rgb-lzw.tif', 'scan-g4.tif']) {
  if (!existsSync(`test-results/bench/${file}`)) {
    console.log(`(${file} absent : générez-le avec Pillow pour mesurer le TIFF)`)
    continue
  }
  const data = new Uint8Array(readFileSync(`test-results/bench/${file}`))
  const js = () => { const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); const ifd = UTIF.decode(buf)[0]; UTIF.decodeImage(buf, ifd); return UTIF.toRGBA8(ifd) }
  const native = () => { const ptr = api.alloc(data.length); new Uint8Array(api.memory.buffer, ptr, data.length).set(data); const r = api.tiff_decode(ptr, data.length); const total = new DataView(api.memory.buffer, r, 4).getUint32(0, true); api.dealloc(r, total); api.dealloc(ptr, data.length) }
  const x = time(`TIFF ${file} — JavaScript (utif2)`, js, 3)
  const y = time(`TIFF ${file} — Rust/WASM`, native, 3)
  console.log(`  → gain ×${(x / y).toFixed(1)}`)
}
