import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import type { Candidate } from './decode'
import type { Stroke } from './ink-image'

/** Reconnaissance d'écriture dans un worker (le modèle se charge à la première utilisation). */
class HandwritingEngine {
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (r: Candidate[][]) => void; reject: (e: Error) => void }>()

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./hwr.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<{ id: number; results?: Candidate[][]; error?: string }>) => {
        const p = this.pending.get(e.data.id)
        if (!p) return
        this.pending.delete(e.data.id)
        if (e.data.error) p.reject(new Error(e.data.error))
        else p.resolve(e.data.results ?? [])
      }
    }
    return this.worker
  }

  /** Une liste de propositions (la meilleure en tête) pour chaque ligne de traits. */
  recognize(lines: Stroke[][]): Promise<Candidate[][]> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.w.postMessage({ id, base: document.baseURI, wasm: new URL(wasmUrl, document.baseURI).href, lines })
    })
  }
}

export const handwriting = new HandwritingEngine()
