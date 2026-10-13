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
    // PC : moteur précis (TrOCR) s'il est installé
    if (await precise.ready()) {
      try {
        return await precise.recognize(lines)
      } catch (e) {
        console.warn('Écriture : moteur précis indisponible, modèle intégré utilisé', e)
      }
    }
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

/**
 * Moteur précis du PC (TrOCR, téléchargé une fois depuis Hugging Face) : chargé dans son propre
 * worker. Entraîné en anglais : les accents sont rétablis avec le dictionnaire français.
 */
class PreciseEngine {
  private worker: Worker | null = null
  private loading: Promise<boolean> | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (r: Candidate[][]) => void; reject: (e: Error) => void }>()
  private accents: Promise<Map<string, string>> | null = null

  get available(): boolean {
    return 'feuillet' in window && typeof window.feuillet.hwrInstalled === 'function'
  }

  async installed(): Promise<boolean> {
    return this.available && !!(await window.feuillet.hwrInstalled())
  }

  /** Installé et chargé (le chargement se fait au premier appel). */
  ready(): Promise<boolean> {
    if (!this.available) return Promise.resolve(false)
    this.loading ??= (async () => {
      const list = await window.feuillet.hwrInstalled()
      if (!list) return false
      const files: Record<string, ArrayBuffer> = {}
      for (const f of list) {
        const data = await window.feuillet.hwrRead(f)
        files[f] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      }
      const w = new Worker(new URL('./trocr.worker.ts', import.meta.url), { type: 'module' })
      const ok = await new Promise<boolean>((resolve) => {
        w.onmessage = (e: MessageEvent<{ type?: string; error?: string; id?: number; results?: Candidate[][] }>) => {
          if (e.data.type === 'loaded') {
            if (e.data.error) console.warn('Écriture : moteur précis non chargé', e.data.error)
            resolve(!e.data.error)
            return
          }
          const p = this.pending.get(e.data.id!)
          if (!p) return
          this.pending.delete(e.data.id!)
          if (e.data.error) p.reject(new Error(e.data.error))
          else p.resolve(e.data.results ?? [])
        }
        w.postMessage({ type: 'load', wasm: new URL(wasmUrl, document.baseURI).href, files }, Object.values(files))
      })
      if (ok) this.worker = w
      else w.terminate()
      return ok
    })()
    // Échec (fichiers abîmés…) : on pourra réessayer après un nouveau téléchargement
    void this.loading.then((ok) => {
      if (!ok) this.loading = null
    })
    return this.loading
  }

  /** Télécharge le moteur (≈ 60 Mo, une fois) ; `progress` reçoit 0..1. */
  async download(progress?: (f: number) => void): Promise<boolean> {
    if (!this.available) return false
    window.feuillet.onHwrProgress((p) => progress?.(p.total ? Math.min(1, ((p.step - 1) + p.loaded / p.total) / p.steps) : (p.step - 1) / p.steps))
    await window.feuillet.hwrDownload()
    this.loading = null
    return this.ready()
  }

  async recognize(lines: Stroke[][]): Promise<Candidate[][]> {
    const w = this.worker
    if (!w) throw new Error('Moteur précis non chargé')
    const id = ++this.seq
    const raw = await new Promise<Candidate[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage({ type: 'recognize', id, lines })
    })
    const acc = await this.accentMap()
    return raw.map((cands) => cands.map((c) => ({ ...c, text: restoreAccents(c.text, acc) })))
  }

  /** Mot sans accents → forme française la plus fréquente (« ete » → « été »). */
  accentMap(): Promise<Map<string, string>> {
    this.accents ??= fetch(new URL('hwr/fr-lexicon.json', document.baseURI))
      .then((r) => r.json() as Promise<[string, number][]>)
      .then((list) => {
        const map = new Map<string, string>()
        const freq = new Map(list.map(([w, f]) => [w, f]))
        // Liste triée du plus fréquent au moins fréquent : la forme accentuée la plus courante
        // gagne, sauf si le mot sans accent est lui-même courant (« a » / « à », « ou » / « où ») ;
        // les fautes fréquentes (« ete », « deja ») ne comptent pas face au vrai mot.
        for (const [w, f] of list) {
          const key = stripAccents(w)
          if (key === w || map.has(key)) continue
          const plain = freq.get(key)
          if (plain === undefined || f - plain > 0.7) map.set(key, w)
        }
        return map
      })
      .catch(() => new Map())
    return this.accents
  }
}

const stripAccents = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae')

/** Rétablit les accents d'un texte lu sans accents, mot par mot, en gardant les majuscules. */
export function restoreAccents(text: string, map: Map<string, string>): string {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const fixed = map.get(w.toLowerCase())
    if (!fixed) return w
    if (w === w.toUpperCase() && w.length > 1) return fixed.toUpperCase()
    if (w[0] === w[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1)
    return fixed
  })
}

export const precise = new PreciseEngine()

export const handwriting = new HandwritingEngine()
