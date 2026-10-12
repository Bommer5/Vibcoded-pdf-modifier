import type { IText } from 'fabric'

/**
 * Mise en forme du texte, comme dans Word :
 * - texte sélectionné (en cours d'écriture) → la sélection ;
 * - curseur dans un mot, sans sélection → ce mot ;
 * - zone de texte sélectionnée (sans écrire) ou curseur hors d'un mot → tout le texte.
 */
export type TextObj = IText & {
  underline: boolean
  linethrough: boolean
  setSuperscript(start: number, end: number): void
  setSubscript(start: number, end: number): void
}

export const WORD_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

/** Plage concernée : [début, fin[ ou null = tout le texte (style de l'objet). */
export function targetRange(t: TextObj): [number, number] | null {
  if (!t.isEditing) return null
  if (t.selectionStart !== t.selectionEnd) return [t.selectionStart, t.selectionEnd]
  // Curseur dans un mot : le mot entier (comportement de Word).
  const text = (t as unknown as { _text: string[] })._text
  let a = t.selectionStart
  let b = t.selectionStart
  while (a > 0 && /[\p{L}\p{N}'’-]/u.test(text[a - 1])) a--
  while (b < text.length && /[\p{L}\p{N}'’-]/u.test(text[b])) b++
  return b > a ? [a, b] : null
}

/** Valeur d'un style à l'endroit concerné (premier caractère de la plage). */
export function styleValue<K extends string>(t: TextObj, key: K): unknown {
  const range = targetRange(t)
  if (range) {
    const s = (t.getSelectionStyles(range[0], range[0] + 1)[0] ?? {}) as Record<string, unknown>
    if (s[key] !== undefined) return s[key]
  }
  return (t as unknown as Record<string, unknown>)[key]
}

/** Applique un style à la plage concernée (ou à tout le texte). */
export function applyStyle(t: TextObj, props: Record<string, unknown>): void {
  const range = targetRange(t)
  if (range) t.setSelectionStyles(props, range[0], range[1])
  else {
    for (const k of Object.keys(props)) t.removeStyle(k as never)
    t.set(props)
  }
  t.initDimensions()
  t.setCoords()
  t.dirty = true
}

export function toggleBold(t: TextObj): void {
  const v = styleValue(t, 'fontWeight')
  applyStyle(t, { fontWeight: v === 'bold' || Number(v) >= 600 ? 'normal' : 'bold' })
}
export function toggleItalic(t: TextObj): void {
  applyStyle(t, { fontStyle: styleValue(t, 'fontStyle') === 'italic' ? 'normal' : 'italic' })
}
export function toggleUnderline(t: TextObj): void {
  applyStyle(t, { underline: !styleValue(t, 'underline') })
}
export function toggleStrike(t: TextObj): void {
  applyStyle(t, { linethrough: !styleValue(t, 'linethrough') })
}

/** Exposant / indice (bascule ; recliquer revient au texte normal). */
export function toggleScript(t: TextObj, kind: 'super' | 'sub'): void {
  const range = targetRange(t) ?? [0, t.text.length]
  const dy = Number(styleValue(t, 'deltaY') ?? 0)
  const active = kind === 'super' ? dy < 0 : dy > 0
  if (active) {
    // Revenir à la taille d'avant (Fabric réduit la police de `size` en exposant / indice).
    const factor = (dy < 0 ? t.superscript : t.subscript).size
    const size = Math.round((Number(styleValue(t, 'fontSize')) / factor) * 100) / 100
    t.setSelectionStyles({ deltaY: 0, fontSize: size }, range[0], range[1])
  } else if (kind === 'super') t.setSuperscript(range[0], range[1])
  else t.setSubscript(range[0], range[1])
  t.initDimensions()
  t.dirty = true
}

/** Taille suivante / précédente dans la liste de Word (A+ / A−). */
export function stepSize(t: TextObj, dir: 1 | -1): void {
  const current = Number(styleValue(t, 'fontSize'))
  const next = dir > 0 ? (WORD_SIZES.find((s) => s > current + 0.01) ?? Math.round(current * 1.2)) : ([...WORD_SIZES].reverse().find((s) => s < current - 0.01) ?? Math.max(1, Math.round(current / 1.2)))
  applyStyle(t, { fontSize: next })
}

/** Effacer la mise en forme : retour au style de base (police et taille conservées). */
export function clearFormatting(t: TextObj): void {
  const range = targetRange(t)
  const base = { fontWeight: 'normal', fontStyle: 'normal', underline: false, linethrough: false, textBackgroundColor: '', deltaY: 0 }
  if (range) t.setSelectionStyles({ ...base, fill: t.fill, fontSize: t.fontSize, fontFamily: t.fontFamily }, range[0], range[1])
  else {
    t.styles = {}
    t.set(base)
  }
  t.initDimensions()
  t.dirty = true
}
