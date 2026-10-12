import { cache, type Canvas } from 'fabric'

/**
 * Polices de secours aux dimensions identiques (Liberation, Carlito, Caladea), déclarées
 * sous les noms usuels : si « Arial » ou « Calibri » n'est pas installé (Linux, Android),
 * l'écran utilise la police équivalente et la mise en page reste exactement celle du PDF.
 * Les fichiers ne sont téléchargés par le moteur que s'ils servent réellement.
 */
const FONT_URLS = import.meta.glob('../fonts/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>

const FAMILIES: [string[], string, string[]][] = [
  [['Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Comic Sans MS'], 'LiberationSans', ['Arial', 'ArialMT', 'Helvetica']],
  [['Times New Roman', 'Georgia', 'Garamond'], 'LiberationSerif', ['Times New Roman', 'TimesNewRomanPSMT', 'Times']],
  [['Courier New'], 'LiberationMono', ['Courier New', 'CourierNewPSMT', 'Courier']],
  [['Calibri'], 'Carlito', ['Calibri']],
  [['Cambria'], 'Caladea', ['Cambria']]
]

const STYLES: [string, string, string][] = [
  ['Regular', 'normal', 'normal'],
  ['Bold', 'bold', 'normal'],
  ['Italic', 'normal', 'italic'],
  ['BoldItalic', 'bold', 'italic']
]

export function installFonts(canvas: Canvas): void {
  const rules: string[] = []
  for (const [names, file, locals] of FAMILIES) {
    for (const name of names) {
      for (const [style, weight, slant] of STYLES) {
        const url = FONT_URLS[`../fonts/${file}-${style}.ttf`]
        if (!url) continue
        // La police installée a la priorité (local) ; sinon l'équivalent libre.
        const own = name === names[0] ? locals : [name]
        const src = [...own.map((l) => `local("${l}${style === 'Regular' ? '' : ' ' + style.replace('BoldItalic', 'Bold Italic')}")`), `url("${url}") format("truetype")`]
        rules.push(`@font-face{font-family:"${name}";font-weight:${weight};font-style:${slant};font-display:swap;src:${src.join(',')}}`)
      }
    }
  }
  const style = document.createElement('style')
  style.textContent = rules.join('\n')
  document.head.append(style)
  // Chaque texte ajouté (ou rechargé) : ses polices sont chargées, puis il est remis en page.
  canvas.on('object:added', ({ target }) => {
    void ensureFonts([target as TextLike]).then((changed) => changed && canvas.requestRenderAll())
  })
  // Une police arrive après coup : on recalcule la mise en page des textes affichés.
  document.fonts?.addEventListener('loadingdone', () => {
    cache.clearFontCache()
    for (const o of canvas.getObjects() as { initDimensions?(): void; dirty?: boolean }[]) {
      if (typeof o.initDimensions === 'function') {
        o.initDimensions()
        o.dirty = true
      }
    }
    canvas.requestRenderAll()
  })
}

type TextLike = { fontFamily?: string; fontWeight?: string | number; fontStyle?: string; styles?: Record<string, Record<string, Record<string, unknown>>>; initDimensions?(): void; dirty?: boolean }

/** Variantes de police utilisées par un texte (style global + styles par caractère). */
function variantsOf(o: TextLike): string[] {
  const out = new Set<string>()
  const add = (family?: unknown, weight?: unknown, style?: unknown): void => {
    if (!family) return
    const bold = weight === 'bold' || Number(weight) >= 600
    out.add(`${style === 'italic' ? 'italic ' : ''}${bold ? 'bold ' : ''}16px "${String(family).replace(/"/g, '')}"`)
  }
  add(o.fontFamily, o.fontWeight, o.fontStyle)
  for (const line of Object.values(o.styles ?? {})) for (const c of Object.values(line)) add(c.fontFamily ?? o.fontFamily, c.fontWeight ?? o.fontWeight, c.fontStyle ?? o.fontStyle)
  return [...out]
}

/**
 * Charge les polices d'un texte puis refait sa mise en page : la mesure se fait toujours
 * avec la police définitive (celle qui sera intégrée au PDF), jamais avec une police provisoire.
 */
export async function ensureFonts(objects: TextLike[]): Promise<boolean> {
  if (!document.fonts?.load) return false
  const texts = objects.filter((o) => typeof o.initDimensions === 'function' && o.fontFamily)
  const variants = [...new Set(texts.flatMap(variantsOf))]
  const pending = variants.filter((v) => !document.fonts.check(v))
  if (!pending.length) return false
  await Promise.all(pending.map((v) => document.fonts.load(v).catch(() => [])))
  // Fabric garde en cache les largeurs de caractères par police : on les oublie, sinon les
  // mesures faites avec la police provisoire resteraient en place.
  cache.clearFontCache()
  for (const o of texts) {
    o.initDimensions!()
    o.dirty = true
  }
  return true
}
