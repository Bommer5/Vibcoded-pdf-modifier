import wasmUrl from './feuillet_core.wasm?url'

/**
 * Pont vers le noyau natif (Rust → WebAssembly, voir native/feuillet-core).
 * Chargé en arrière-plan au démarrage ; tant qu'il n'est pas prêt (ou s'il ne
 * peut pas se charger), les appelants utilisent leur version JavaScript.
 */
interface Exports {
  memory: WebAssembly.Memory
  alloc(size: number): number
  dealloc(ptr: number, size: number): void
  erase(ptr: number, n: number, stride: number, cx: number, cy: number, r: number, step: number): number
  simplify(ptr: number, n: number, stride: number, tolerance: number): number
  count_inside(poly: number, np: number, ptr: number, n: number, stride: number): number
  recognize(ptr: number, n: number, stride: number, out: number): number
  tiff_decode(ptr: number, len: number): number
}

let api: Exports | null = null

export const nativeReady: Promise<boolean> = (async () => {
  try {
    const bytes = await (await fetch(wasmUrl)).arrayBuffer()
    const { instance } = await WebAssembly.instantiate(bytes, {})
    api = instance.exports as unknown as Exports
    return true
  } catch (e) {
    console.warn('Noyau natif indisponible, repli JavaScript', e)
    return false
  }
})()

export const hasNative = (): boolean => api !== null

function putF32(values: ArrayLike<number>): [number, number] {
  const bytes = values.length * 4
  const ptr = api!.alloc(Math.max(4, bytes))
  new Float32Array(api!.memory.buffer, ptr, values.length).set(values)
  return [ptr, Math.max(4, bytes)]
}

/** Lit un tampon résultat « [taille u32][données] » puis le libère. */
function takeBuffer(ptr: number): DataView | null {
  if (!ptr) return null
  const total = new DataView(api!.memory.buffer, ptr, 4).getUint32(0, true)
  const copy = new Uint8Array(api!.memory.buffer, ptr + 4, total - 4).slice()
  api!.dealloc(ptr, total)
  return new DataView(copy.buffer)
}

/** Gomme partielle native : null = trait non touché ; sinon les morceaux restants. */
export function nativeErase(flat: Float32Array, stride: number, cx: number, cy: number, r: number, step: number): number[][][] | null {
  const n = flat.length / stride
  const [ptr, size] = putF32(flat)
  try {
    const view = takeBuffer(api!.erase(ptr, n, stride, cx, cy, r, step))
    if (!view) return null
    const runs: number[][][] = []
    let o = 4
    const count = view.getUint32(0, true)
    for (let k = 0; k < count; k++) {
      const len = view.getUint32(o, true)
      o += 4
      const run: number[][] = []
      for (let i = 0; i < len; i++) {
        const p: number[] = []
        for (let c = 0; c < stride; c++, o += 4) p.push(view.getFloat32(o, true))
        run.push(p)
      }
      runs.push(run)
    }
    return runs
  } finally {
    api!.dealloc(ptr, size)
  }
}

export function nativeSimplify(flat: Float32Array, stride: number, tolerance: number): Float32Array {
  const n = flat.length / stride
  const [ptr, size] = putF32(flat)
  try {
    const kept = api!.simplify(ptr, n, stride, tolerance)
    return new Float32Array(api!.memory.buffer, ptr, kept * stride).slice()
  } finally {
    api!.dealloc(ptr, size)
  }
}

export function nativeCountInside(poly: Float32Array, flat: Float32Array, stride: number): number {
  const [pp, ps] = putF32(poly)
  const [ptr, size] = putF32(flat)
  try {
    return api!.count_inside(pp, poly.length / 2, ptr, flat.length / stride, stride)
  } finally {
    api!.dealloc(pp, ps)
    api!.dealloc(ptr, size)
  }
}

export type Recognized =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; left: number; top: number; width: number; height: number }
  | { kind: 'polygon'; points: [number, number][] }

export function nativeRecognize(flat: Float32Array, stride: number): Recognized | null {
  const [ptr, size] = putF32(flat)
  const out = api!.alloc(32)
  try {
    const kind = api!.recognize(ptr, flat.length / stride, stride, out)
    const v = Array.from(new Float32Array(api!.memory.buffer, out, 8))
    switch (kind) {
      case 1:
        return { kind: 'line', x1: v[0], y1: v[1], x2: v[2], y2: v[3] }
      case 2:
        return { kind: 'ellipse', cx: v[0], cy: v[1], rx: v[2], ry: v[3] }
      case 3:
        return { kind: 'rect', left: v[0], top: v[1], width: v[2], height: v[3] }
      case 4:
        return { kind: 'polygon', points: [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]]] }
      case 5:
        return { kind: 'polygon', points: [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]] }
      default:
        return null
    }
  } finally {
    api!.dealloc(ptr, size)
    api!.dealloc(out, 32)
  }
}

/** Décodage TIFF natif : une image RGBA par page. */
export function nativeTiff(data: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }[] | null {
  const ptr = api!.alloc(data.length)
  new Uint8Array(api!.memory.buffer, ptr, data.length).set(data)
  try {
    const view = takeBuffer(api!.tiff_decode(ptr, data.length))
    if (!view) return null
    const pages = []
    let o = 4
    const count = view.getUint32(0, true)
    for (let k = 0; k < count; k++) {
      const width = view.getUint32(o, true)
      const height = view.getUint32(o + 4, true)
      o += 8
      const len = width * height * 4
      pages.push({ width, height, rgba: new Uint8ClampedArray(view.buffer as ArrayBuffer, o, len) })
      o += len
    }
    return pages
  } finally {
    api!.dealloc(ptr, data.length)
  }
}
