import { FabricText, IText, Textbox, util } from 'fabric'

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
    for (const prop of ['paragraphSpacing', 'firstIndent']) {
      if (!cls.textLayoutProperties.includes(prop)) cls.textLayoutProperties.push(prop)
      if (!cls.cacheProperties.includes(prop)) cls.cacheProperties.push(prop)
    }
  }
  installFirstIndent()
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

// --- Retrait de première ligne (comme Word : Paragraphe › Retrait › Première ligne) -----------

type Indented = T & {
  firstIndent?: number
  width: number
  dynamicMinWidth: number
  splitByGrapheme: boolean
  _getWidthOfCharSpacing(): number
  _measureWord(word: string[], lineIndex: number, offset: number): number
}

/** Retrait de la ligne `i` : `firstIndent` sur la première ligne de chaque paragraphe. */
export function indentOfLine(t: Indented, i: number): number {
  const v = t.firstIndent ?? 0
  if (!v || t.contour) return 0
  // Textbox : une ligne commence un paragraphe si la précédente finissait par un retour.
  return i === 0 || !t._styleMap || t.isEndOfWrapping(i - 1) ? v : 0
}

function installFirstIndent(): void {
  const proto = FabricText.prototype as unknown as Record<string, (...a: never[]) => unknown>
  // Largeur de ligne = texte + retrait : la justification, le centrage et l'alignement à
  // droite en tiennent compte d'eux-mêmes.
  const lineWidth = proto.getLineWidth
  proto.getLineWidth = function (this: Indented, i: number) {
    return (lineWidth.call(this, i as never) as number) + indentOfLine(this, i)
  } as never
  const leftOffset = proto._getLineLeftOffset
  proto._getLineLeftOffset = function (this: Indented, i: number) {
    return (leftOffset.call(this, i as never) as number) + indentOfLine(this, i)
  } as never

  // Texte justifié : Fabric dessine « mot + espace » d'un bloc avec le style de l'espace ; un
  // mot d'une lettre en italique (« G », « n ») sortait donc droit. Ici, chaque mot est dessiné
  // avec son propre style, l'espace à part. (Copie de FabricText._renderChars de Fabric 7.)
  type Box = { kernedWidth: number; width: number; renderLeft: number; renderTop: number; angle: number }
  type Self = {
    textAlign: string
    path?: unknown
    direction: string
    charSpacing: number
    __charBounds: Box[][]
    _reSpaceAndTab: RegExp
    getHeightOfLineImpl(i: number): number
    _fontSizeFraction: number
    isEmptyStyles(i: number): boolean
    getCompleteStyleDeclaration(l: number, c: number): Record<string, unknown>
    _renderChar(m: string, ctx: CanvasRenderingContext2D, l: number, c: number, chars: string, left: number, top: number): void
  }
  const renderChars = proto._renderChars
  proto._renderChars = function (this: Self, method: string, ctx: CanvasRenderingContext2D, line: string[], left: number, top: number, lineIndex: number) {
    if (!this.textAlign.includes('justify') || this.path || this.direction !== 'ltr') {
      return renderChars.call(this, method as never, ctx as never, line as never, left as never, top as never, lineIndex as never)
    }
    const space = this._reSpaceAndTab
    let actualStyle: Record<string, unknown> | undefined
    let chars = ''
    let boxWidth = 0
    ctx.save()
    top -= this.getHeightOfLineImpl(lineIndex) * this._fontSizeFraction
    for (let i = 0, len = line.length - 1; i <= len; i++) {
      // Fin de bloc : fin de ligne, espacement des lettres, une espace, ou juste avant une espace.
      let time = i === len || !!this.charSpacing || space.test(line[i]) || space.test(line[i + 1] ?? '')
      chars += line[i]
      const box = this.__charBounds[lineIndex][i]
      if (boxWidth === 0) {
        left += box.kernedWidth - box.width
        boxWidth += box.width
      } else boxWidth += box.kernedWidth
      if (!time) {
        actualStyle ??= this.getCompleteStyleDeclaration(lineIndex, i)
        time = util.hasStyleChanged(actualStyle as never, this.getCompleteStyleDeclaration(lineIndex, i + 1) as never, false)
      }
      if (time) {
        this._renderChar(method, ctx, lineIndex, i, chars, left, top)
        chars = ''
        actualStyle = undefined
        left += boxWidth
        boxWidth = 0
      }
    }
    ctx.restore()
  } as never

  // Retrait négatif (étiquette de liste « (d) » qui dépasse à gauche) : le texte sort du cadre
  // de l'objet ; sans image en cache, rien n'est rogné.
  const shouldCache = proto.shouldCache
  proto.shouldCache = function (this: Indented & { ownCaching?: boolean }) {
    if ((this.firstIndent ?? 0) < 0) {
      this.ownCaching = false
      return false
    }
    return shouldCache.call(this)
  } as never

  // Retour à la ligne automatique : la première ligne d'un paragraphe a moins de place.
  // (Copie de Textbox._wrapLine de Fabric 7, avec la largeur réduite de la première ligne.)
  const tproto = Textbox.prototype as unknown as Record<string, (...a: never[]) => unknown>
  const wrapLine = tproto._wrapLine
  tproto._wrapLine = function (
    this: Indented,
    lineIndex: number,
    desiredWidth: number,
    data: { largestWordWidth: number; wordsData: { word: string[]; width: number }[][] },
    reservedSpace = 0
  ) {
    const indent = this.firstIndent ?? 0
    if (!indent || this.contour) return wrapLine.call(this, lineIndex as never, desiredWidth as never, data as never, reservedSpace as never)
    const { largestWordWidth, wordsData } = data
    const additionalSpace = this._getWidthOfCharSpacing()
    const splitByGrapheme = this.splitByGrapheme
    const graphemeLines: string[][] = []
    const infix = splitByGrapheme ? '' : ' '
    let lineWidth = 0
    let line: string[] = []
    let offset = 0
    let infixWidth = 0
    let lineJustStarted = true
    desiredWidth -= reservedSpace
    const maxWidth = Math.max(desiredWidth, largestWordWidth, this.dynamicMinWidth)
    const words = wordsData[lineIndex]
    let i: number
    for (i = 0; i < words.length; i++) {
      const { word, width: wordWidth } = words[i]
      offset += word.length
      lineWidth += infixWidth + wordWidth - additionalSpace
      const limit = graphemeLines.length === 0 ? Math.max(maxWidth - indent, largestWordWidth) : maxWidth
      if (lineWidth > limit && !lineJustStarted) {
        graphemeLines.push(line)
        line = []
        lineWidth = wordWidth
        lineJustStarted = true
      } else lineWidth += additionalSpace
      if (!lineJustStarted && !splitByGrapheme) line.push(infix)
      line = line.concat(word)
      infixWidth = splitByGrapheme ? 0 : this._measureWord([infix], lineIndex, offset)
      offset++
      lineJustStarted = false
    }
    if (i) graphemeLines.push(line)
    if (largestWordWidth + reservedSpace > this.dynamicMinWidth) this.dynamicMinWidth = largestWordWidth - additionalSpace + reservedSpace
    return graphemeLines
  } as never
}
