import { Capacitor, registerPlugin } from '@capacitor/core'
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
  async recognize(lines: Stroke[][]): Promise<Candidate[][]> {
    // Android : moteur d'écriture de Google (ML Kit), bien meilleur ; sinon le modèle intégré.
    if (Capacitor.getPlatform() === 'android') {
      try {
        const { results } = await NativeHandwriting.recognize({ lang: 'fr', lines })
        // Moteur sûr de lui : note neutre pour la première proposition (acceptée), puis en retrait
        return results.map((cands) => cands.map((c, i) => ({ text: c.text, score: -0.2 * i, lexicon: false, lm: 0 })))
      } catch (e) {
        console.warn('Écriture : moteur Android indisponible, modèle intégré utilisé', e)
      }
    }
    return this.local(lines)
  }

  private local(lines: Stroke[][]): Promise<Candidate[][]> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.w.postMessage({ id, base: document.baseURI, wasm: new URL(wasmUrl, document.baseURI).href, lines })
    })
  }
}

interface NativeHandwritingPlugin {
  recognize(o: { lang: string; lines: Stroke[][] }): Promise<{ results: { text: string; score: number }[][] }>
}
const NativeHandwriting = registerPlugin<NativeHandwritingPlugin>('Handwriting')

export const handwriting = new HandwritingEngine()
