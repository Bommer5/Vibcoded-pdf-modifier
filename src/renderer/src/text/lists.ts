import type { TextObj } from './format'

/**
 * Listes à puces et numérotées, comme dans Word :
 * - styles de puces (• ◦ ▪ ➤ ✓ –) et de numérotation (1. 1) a. A. i.) ;
 * - niveaux (Tab / Maj+Tab), chaque niveau décalé d'un retrait ;
 * - Entrée continue la liste, Entrée sur un élément vide la termine ;
 * - numéros recalculés automatiquement.
 * Le marqueur est du texte ordinaire suivi d'une espace insécable : il reste collé
 * au texte, ne s'étire pas en justifié, et s'exporte tel quel (PDF, Word, SVG).
 */

export const BULLETS = ['•', '◦', '▪', '➤', '✓', '–'] as const
export const NUMBERINGS = ['1.', '1)', 'a.', 'A.', 'i.'] as const
export type Bullet = (typeof BULLETS)[number]
export type Numbering = (typeof NUMBERINGS)[number]
export type ListStyle = { kind: 'bullet'; style: Bullet } | { kind: 'number'; style: Numbering }

const NBSP = ' '
const INDENT = NBSP.repeat(4)
const MARKER = new RegExp(`^((?:${INDENT})*)(?:([${BULLETS.join('')}])|(\\d+|[a-z]+|[A-Z]+)([.)]))${NBSP}`)

export interface ListItem {
  level: number
  /** Longueur du préfixe (retrait + marqueur + espace), en caractères. */
  prefix: number
  list: ListStyle
}

const ROMAN = /^[ivxlc]+$/

function numberingOf(value: string, sep: string): Numbering {
  if (/^\d+$/.test(value)) return sep === ')' ? '1)' : '1.'
  if (ROMAN.test(value) && value !== 'c' && value !== 'l') return 'i.'
  return /[A-Z]/.test(value) ? 'A.' : 'a.'
}

export function parseItem(line: string): ListItem | null {
  const m = MARKER.exec(line)
  if (!m) return null
  const level = m[1].length / INDENT.length
  const list: ListStyle = m[2] ? { kind: 'bullet', style: m[2] as Bullet } : { kind: 'number', style: numberingOf(m[3], m[4]) }
  return { level, prefix: m[0].length, list }
}

function toRoman(n: number): string {
  const table: [number, string][] = [[100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, s] of table) while (n >= v) (out += s), (n -= v)
  return out
}

function toLetters(n: number): string {
  let out = ''
  while (n > 0) (out = String.fromCharCode(97 + ((n - 1) % 26)) + out), (n = Math.floor((n - 1) / 26))
  return out
}

export function marker(list: ListStyle, n = 1): string {
  if (list.kind === 'bullet') return list.style
  switch (list.style) {
    case '1.': return `${n}.`
    case '1)': return `${n})`
    case 'a.': return `${toLetters(n)}.`
    case 'A.': return `${toLetters(n).toUpperCase()}.`
    case 'i.': return `${toRoman(n)}.`
  }
}

const prefixOf = (list: ListStyle, level: number, n = 1): string => INDENT.repeat(level) + marker(list, n) + NBSP

/** Puce par défaut selon le niveau (comme Word : •, puis ◦, puis ▪). */
const bulletForLevel = (level: number): Bullet => (['•', '◦', '▪'] as const)[level % 3]

// --- Paragraphes, en positions de graphèmes (celles de Fabric) -----------------------------

interface Para {
  start: number
  text: string
}

function paragraphs(t: TextObj): Para[] {
  const g = (t as unknown as { _text: string[] })._text
  const out: Para[] = []
  let start = 0
  let text = ''
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '\n') {
      out.push({ start, text })
      start = i + 1
      text = ''
    } else text += g[i]
  }
  out.push({ start, text })
  return out
}

/** Longueur en graphèmes (le préfixe n'a que des caractères simples, mais le texte non). */
const glen = (s: string): number => [...s].length

function selectedParagraphs(t: TextObj, paras: Para[]): [number, number] {
  if (!t.isEditing) return [0, paras.length - 1]
  const index = (pos: number): number => {
    let k = 0
    while (k + 1 < paras.length && paras[k + 1].start <= pos) k++
    return k
  }
  return [index(t.selectionStart), index(t.selectionEnd)]
}

/** Remplace le préfixe du paragraphe `p` ; décale la sélection en conséquence. */
function replacePrefix(t: TextObj, p: Para, oldLen: number, next: string): void {
  const delta = glen(next) - oldLen
  if (oldLen) t.removeChars(p.start, p.start + oldLen)
  if (next) t.insertChars(next, undefined, p.start)
  const move = (pos: number): number => (pos <= p.start ? pos : Math.max(p.start + glen(next), pos + delta))
  if (t.isEditing) {
    t.selectionStart = move(t.selectionStart)
    t.selectionEnd = move(t.selectionEnd)
  }
}

/** Recalcule les numéros de toutes les listes numérotées du texte. */
export function renumber(t: TextObj): void {
  const counters: number[] = []
  const styles: ListStyle[] = []
  for (const p of paragraphs(t)) {
    const item = parseItem(p.text)
    if (!item) {
      counters.length = styles.length = 0
      continue
    }
    counters.length = styles.length = item.level + 1
    counters[item.level] = (counters[item.level] ?? 0) + 1
    // « i. » au 9e élément d'une liste a, b, c… : c'est une lettre, pas un chiffre romain.
    const prev = styles[item.level]
    if (prev?.kind === 'number' && item.list.kind === 'number' && item.list.style === 'i.' && prev.style === 'a.') item.list = prev
    styles[item.level] = item.list
    if (item.list.kind !== 'number') continue
    const want = prefixOf(item.list, item.level, counters[item.level])
    if (p.text.slice(0, item.prefix) !== want) replacePrefix(t, p, glen(p.text.slice(0, item.prefix)), want)
  }
}

/** État de la liste au début de la sélection (pour l'affichage des boutons). */
export function currentItem(t: TextObj): ListItem | null {
  const paras = paragraphs(t)
  return parseItem(paras[selectedParagraphs(t, paras)[0]].text)
}

/** Applique un style de liste (ou `null` = plus de liste) aux paragraphes sélectionnés. */
export function setList(t: TextObj, list: ListStyle | null): void {
  const paras = paragraphs(t)
  const [first, last] = selectedParagraphs(t, paras)
  // De la fin vers le début : les positions des paragraphes précédents restent valables.
  for (let i = last; i >= first; i--) {
    const p = paras[i]
    const item = parseItem(p.text)
    const level = item?.level ?? 0
    replacePrefix(t, p, item?.prefix ?? 0, list ? prefixOf(list, level) : '')
  }
  renumber(t)
  finish(t)
}

/** Bouton Puces / Numérotation : bascule avec le style par défaut (ou le dernier choisi). */
export function toggleList(t: TextObj, kind: 'bullet' | 'number', style?: Bullet | Numbering): void {
  const paras = paragraphs(t)
  const [first, last] = selectedParagraphs(t, paras)
  const all = paras.slice(first, last + 1).every((p) => parseItem(p.text)?.list.kind === kind)
  if (all && !style) return setList(t, null)
  setList(t, kind === 'bullet' ? { kind, style: (style as Bullet) ?? '•' } : { kind, style: (style as Numbering) ?? '1.' })
}

/** Augmenter (+1) ou diminuer (−1) le niveau des éléments de liste sélectionnés. */
export function changeLevel(t: TextObj, dir: 1 | -1): boolean {
  const paras = paragraphs(t)
  const [first, last] = selectedParagraphs(t, paras)
  let changed = false
  for (let i = last; i >= first; i--) {
    const p = paras[i]
    const item = parseItem(p.text)
    if (!item) continue
    const level = Math.max(0, Math.min(8, item.level + dir))
    if (level === item.level) continue
    // Les puces changent de forme avec le niveau ; la numérotation garde son style.
    const list: ListStyle = item.list.kind === 'bullet' && item.list.style === bulletForLevel(item.level) ? { kind: 'bullet', style: bulletForLevel(level) } : item.list
    replacePrefix(t, p, item.prefix, prefixOf(list, level))
    changed = true
  }
  if (changed) {
    renumber(t)
    finish(t)
  }
  return changed
}

/**
 * Entrée dans une liste : nouvel élément du même style, ou fin de la liste si l'élément
 * est vide. Renvoie false si le curseur n'est pas dans une liste (Entrée normale).
 */
export function enterInList(t: TextObj): boolean {
  const paras = paragraphs(t)
  const [first, last] = selectedParagraphs(t, paras)
  if (first !== last) return false
  const p = paras[first]
  const item = parseItem(p.text)
  if (!item || t.selectionStart < p.start + item.prefix) return false
  if (glen(p.text) === item.prefix) {
    // Élément vide : on remonte d'un niveau, ou on sort de la liste.
    if (item.level > 0) changeLevel(t, -1)
    else setList(t, null)
    return true
  }
  const start = t.selectionStart
  const insert = '\n' + prefixOf(item.list, item.level)
  t.insertChars(insert, undefined, start, t.selectionEnd)
  t.selectionStart = t.selectionEnd = start + glen(insert)
  renumber(t)
  finish(t)
  return true
}

/** Retour arrière juste après une puce : enlève la puce (comme Word). */
export function backspaceInList(t: TextObj): boolean {
  if (t.selectionStart !== t.selectionEnd) return false
  const paras = paragraphs(t)
  const [i] = selectedParagraphs(t, paras)
  const p = paras[i]
  const item = parseItem(p.text)
  if (!item || t.selectionStart !== p.start + item.prefix) return false
  if (item.level > 0) changeLevel(t, -1)
  else setList(t, null)
  return true
}

/** Après une modification par programme : dimensions, et zone de saisie cachée à jour. */
function finish(t: TextObj): void {
  t.initDimensions()
  t.setCoords()
  t.dirty = true
  const ta = t.hiddenTextarea
  if (t.isEditing && ta) {
    ta.value = t.text
    ;(t as unknown as { _updateTextarea(): void })._updateTextarea()
  }
}
