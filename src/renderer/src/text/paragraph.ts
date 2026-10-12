import { FabricText, IText, Textbox } from 'fabric'

/**
 * Espacement entre paragraphes (« Espacement après » de Word), donc aussi entre les
 * éléments d'une liste à puces : `paragraphSpacing`, en points, ajouté sous chaque
 * paragraphe sauf le dernier.
 *
 * Fabric place chaque ligne en cumulant `getHeightOfLine` : on y ajoute l'espace sous la
 * dernière ligne de chaque paragraphe. Les quelques endroits de Fabric qui déduisent la
 * hauteur des caractères de cette valeur (soulignement, curseur, SVG) sont corrigés ici
 * pour ne pas descendre avec l'espace ajouté.
 */
interface T {
  lineHeight: number
  paragraphSpacing?: number
  _textLines: string[][]
  _fontSizeFraction: number
  _styleMap?: unknown
  contour?: unknown
  getHeightOfLineImpl(i: number): number
  isEndOfWrapping(i: number): boolean
  get2DCursorLocation(i: number): { lineIndex: number; charIndex: number }
}

/** Espace ajouté sous la ligne `i` (0 si la ligne n'est pas la fin d'un paragraphe). */
export function spaceAfterLine(t: T, i: number): number {
  const s = t.paragraphSpacing ?? 0
  // Zone de texte libre (ShapedText) : les lignes suivent la forme dessinée, pas d'espacement.
  if (!s || t.contour || i >= t._textLines.length - 1) return 0
  // Textbox : une ligne peut être un retour automatique, pas une fin de paragraphe.
  return !t._styleMap || t.isEndOfWrapping(i) ? s : 0
}

let installed = false

export function installParagraphSpacing(): void {
  if (installed) return
  installed = true
  for (const cls of [FabricText, IText, Textbox] as unknown as { textLayoutProperties: string[]; cacheProperties: string[] }[]) {
    if (!cls.textLayoutProperties.includes('paragraphSpacing')) cls.textLayoutProperties.push('paragraphSpacing')
    if (!cls.cacheProperties.includes('paragraphSpacing')) cls.cacheProperties.push('paragraphSpacing')
  }
  const proto = FabricText.prototype as unknown as Record<string, (...a: never[]) => unknown>

  proto.getHeightOfLine = function (this: T, i: number) {
    return this.getHeightOfLineImpl(i) * this.lineHeight + spaceAfterLine(this, i)
  } as never

  // Soulignement / barré : Fabric les place d'après getHeightOfLine.
  const decoration = proto._renderTextDecoration
  proto._renderTextDecoration = function (this: T, ctx: CanvasRenderingContext2D, type: string) {
    if (!this.paragraphSpacing) return decoration.call(this, ctx as never, type as never)
    decorationsByParagraph(this, ctx, type, decoration)
  } as never

  // Curseur : même correction.
  const cursor = proto.getCursorRenderingData
  proto.getCursorRenderingData = function (this: T, ...args: never[]) {
    const data = cursor.apply(this, args) as { top: number }
    if (this.paragraphSpacing) {
      const start = (args[0] as number | undefined) ?? (this as unknown as { selectionStart: number }).selectionStart
      const line = this.get2DCursorLocation(start).lineIndex
      data.top -= (spaceAfterLine(this, line) * (1 - this._fontSizeFraction)) / this.lineHeight
    }
    return data
  } as never

  // Export SVG : position verticale du texte et du surlignage de chaque ligne.
  const svgText = proto._setSVGTextLineText
  proto._setSVGTextLineText = function (this: T, spans: never, i: number, left: number, top: number) {
    return svgText.call(this, spans, i as never, left as never, (top - (spaceAfterLine(this, i) * (1 - this._fontSizeFraction)) / this.lineHeight) as never)
  } as never
}

/**
 * Soulignement avec espacement de paragraphes : un appel par paragraphe, sans l'espace
 * ajouté, décalé de l'espace cumulé au-dessus ; les autres lignes sont neutralisées.
 */
function decorationsByParagraph(t: T, ctx: CanvasRenderingContext2D, type: string, original: (...a: never[]) => unknown): void {
  const self = t as unknown as Record<string, unknown>
  const getHeight = self.getHeightOfLine
  const getValue = self.getValueOfPropertyAt as (l: number, c: number, p: string) => unknown
  const last = t._textLines.length - 1
  let from = 0
  let offset = 0
  try {
    self.getHeightOfLine = (i: number) => t.getHeightOfLineImpl(i) * t.lineHeight
    for (let i = 0; i <= last; i++) {
      const after = spaceAfterLine(t, i)
      if (!after && i < last) continue
      const [a, b] = [from, i]
      self.getValueOfPropertyAt = (l: number, c: number, p: string) => (p === type && (l < a || l > b) ? false : getValue.call(t, l, c, p))
      ctx.save()
      ctx.translate(0, offset)
      original.call(t, ctx as never, type as never)
      ctx.restore()
      offset += after
      from = i + 1
    }
  } finally {
    self.getHeightOfLine = getHeight
    self.getValueOfPropertyAt = getValue
  }
}
