/**
 * Décodage de la sortie du modèle d'écriture (CTC) en texte.
 *
 * - `bestPath` : lecture brute, caractère le plus probable à chaque colonne ;
 * - `beamSearch` : recherche en faisceau « mot à mot » (word beam search, Scheidl 2018) :
 *   les lettres doivent former des mots du dictionnaire français (pondérés par leur
 *   fréquence), les chiffres, la ponctuation et les symboles mathématiques restent libres.
 *   La même recherche sans dictionnaire donne la lecture « telle qu'écrite » ; on la garde
 *   quand l'écriture la soutient nettement mieux (nom propre, abréviation, mot rare…).
 */

export interface Candidate {
  text: string
  /** Log-probabilité de l'écriture seule (sans le dictionnaire). */
  score: number
  /** Le texte a-t-il été corrigé par le dictionnaire ? */
  lexicon: boolean
  /** Somme des log10 fréquences des mots (dictionnaire). */
  lm: number
  /** Confiance 0..1 donnée par le moteur (moteur précis) ; sinon la note ci-dessus sert. */
  conf?: number
}

export interface TrieNode {
  /** Enfants par lettre (minuscule). */
  c: Record<string, TrieNode>
  /** Log10 de la fréquence si un mot se termine ici. */
  w?: number
}

const LETTERS = /^[a-zàâäçéèêëîïôöùûüÿœæ]$/

export function buildTrie(words: [string, number][]): TrieNode {
  const root: TrieNode = { c: {} }
  for (const [word, freq] of words) {
    if (![...word].every((ch) => LETTERS.test(ch))) continue
    let n = root
    for (const ch of word) n = n.c[ch] ??= { c: {} }
    n.w = Math.max(n.w ?? -99, freq)
  }
  return root
}

const logAdd = (a: number, b: number): number => {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const m = Math.max(a, b)
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m))
}

/** Log-softmax de chaque colonne (T × C). */
export function logSoftmax(logits: Float32Array, T: number, C: number): Float32Array {
  const out = new Float32Array(T * C)
  for (let t = 0; t < T; t++) {
    let m = -Infinity
    for (let c = 0; c < C; c++) m = Math.max(m, logits[t * C + c])
    let s = 0
    for (let c = 0; c < C; c++) s += Math.exp(logits[t * C + c] - m)
    const l = m + Math.log(s)
    for (let c = 0; c < C; c++) out[t * C + c] = logits[t * C + c] - l
  }
  return out
}

export function bestPath(lp: Float32Array, T: number, C: number, charset: string[]): string {
  let s = ''
  let prev = 0
  for (let t = 0; t < T; t++) {
    let k = 0
    for (let c = 1; c < C; c++) if (lp[t * C + c] > lp[t * C + k]) k = c
    if (k !== 0 && k !== prev) s += charset[k - 1]
    prev = k
  }
  return s
}

interface Beam {
  text: string
  last: number
  pb: number // fin par un blanc
  pnb: number // fin par un caractère
  node: TrieNode | null // mot en cours (null : hors mot)
  lm: number // somme des log10 fréquences des mots terminés
}

const total = (b: Beam): number => logAdd(b.pb, b.pnb)

/**
 * Recherche en faisceau CTC. Avec `trie`, les lettres doivent former des mots du dictionnaire.
 * `lmWeight` : poids de la fréquence des mots (log10 → log naturel).
 */
export function beamSearch(
  lp: Float32Array,
  T: number,
  C: number,
  charset: string[],
  opts: { trie?: TrieNode; width?: number; lmWeight?: number; unknownWord?: number } = {}
): Candidate[] {
  const width = opts.width ?? 24
  const lmW = (opts.lmWeight ?? 0.35) * Math.LN10
  const trie = opts.trie
  const lower = charset.map((ch) => ch.toLowerCase())
  const isLetter = charset.map((ch) => LETTERS.test(ch.toLowerCase()))
  let beams = new Map<string, Beam>()
  beams.set('', { text: '', last: 0, pb: 0, pnb: -Infinity, node: null, lm: 0 })
  const rank = (b: Beam): number => total(b) + lmW * (b.lm + (b.node && b.node !== trie ? bestBelow(b.node) : 0))
  for (let t = 0; t < T; t++) {
    const row = t * C
    // Caractères plausibles à cet instant (élagage : les autres ne changeront rien).
    const cand: number[] = []
    for (let c = 1; c < C; c++) if (lp[row + c] > -9) cand.push(c)
    const next = new Map<string, Beam>()
    const put = (key: string, mk: () => Beam, pb: number, pnb: number): void => {
      let n = next.get(key)
      if (!n) next.set(key, (n = mk()))
      n.pb = logAdd(n.pb, pb)
      n.pnb = logAdd(n.pnb, pnb)
    }
    for (const b of beams.values()) {
      const tot = total(b)
      // Blanc : le texte ne change pas
      put(b.text, () => ({ ...b, pb: -Infinity, pnb: -Infinity }), tot + lp[row], -Infinity)
      // Même caractère répété sans blanc : le texte ne change pas
      if (b.last) put(b.text, () => ({ ...b, pb: -Infinity, pnb: -Infinity }), -Infinity, b.pnb + lp[row + b.last])
      for (const c of cand) {
        const ch = charset[c - 1]
        let node: TrieNode | null = b.node
        let lm = b.lm
        let glue = ''
        let penalty = 0
        if (trie) {
          if (isLetter[c]) {
            const from = b.node ?? trie
            let child = from.c[lower[c]]
            if (!child && b.node && b.node.w !== undefined && trie.c[lower[c]]) {
              // Mots collés (espace minuscule) : le mot précédent est complet, un autre commence.
              child = trie.c[lower[c]]
              lm += b.node.w
              glue = ' '
              penalty = -1.6
            }
            if (!child) continue // pas de mot du dictionnaire qui continue ainsi
            node = child
          } else {
            if (b.node) {
              if (b.node.w === undefined) continue // mot inachevé : pas de ponctuation au milieu
              lm += b.node.w
            }
            node = null
          }
        }
        const p = lp[row + c] + (c === b.last && !glue ? b.pb : tot) + penalty
        const text = b.text + glue + ch
        put(text, () => ({ text, last: c, pb: -Infinity, pnb: -Infinity, node, lm }), -Infinity, p)
      }
    }
    // On garde les meilleurs faisceaux
    const sorted = [...next.values()].sort((a, b) => rank(b) - rank(a)).slice(0, width)
    beams = new Map(sorted.map((b) => [b.text, b]))
  }
  const out: Candidate[] = []
  for (const b of beams.values()) {
    let lm = b.lm
    if (trie && b.node) {
      if (b.node.w === undefined) continue // dernier mot inachevé
      lm += b.node.w
    }
    out.push({ text: b.text, score: total(b), lexicon: !!trie, lm })
  }
  return out.sort((a, b) => b.score + lmW * b.lm - (a.score + lmW * a.lm))
}

/** Meilleure fréquence d'un mot qui commence par ce préfixe (estimation optimiste, mise en cache). */
const bestCache = new WeakMap<TrieNode, number>()
function bestBelow(n: TrieNode): number {
  const c = bestCache.get(n)
  if (c !== undefined) return c
  let best = n.w ?? -99
  for (const k in n.c) best = Math.max(best, bestBelow(n.c[k]))
  bestCache.set(n, best)
  return best
}

/**
 * Lecture finale : dictionnaire d'abord ; la lecture libre l'emporte si l'écriture la soutient
 * nettement mieux (marge en log-probabilité). Renvoie les propositions, la meilleure en tête.
 */
export function decode(lp: Float32Array, T: number, C: number, charset: string[], trie?: TrieNode): Candidate[] {
  const free = beamSearch(lp, T, C, charset, { width: 16 })
  const dict = trie ? beamSearch(lp, T, C, charset, { trie, width: 24 }) : []
  const margin = 4.5
  const out: Candidate[] = []
  if (dict.length && (!free.length || free[0].score - dict[0].score < margin)) out.push(...dict.slice(0, 3), ...free.slice(0, 2))
  else out.push(...free.slice(0, 2), ...dict.slice(0, 3))
  const seen = new Set<string>()
  return out.filter((c) => !seen.has(c.text) && seen.add(c.text))
}
