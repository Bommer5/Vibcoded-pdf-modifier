/** Réglages des outils, mémorisés entre les sessions. */
export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle'
export type EraserMode = 'partial' | 'stroke'
/** Curseur des outils d'écriture : point plein (taille et couleur du trait), cercle, croix fine. */
export type CursorStyle = 'dot' | 'ring' | 'cross'
/** Ce que fait un bouton du stylet, le temps du geste. */
export type PenButtonAction = 'lasso' | 'eraser' | 'hand' | 'menu' | 'none'

export interface ToolSettings {
  penColor: string
  penWidth: number
  penStyle: LineStyle
  /** Épaisseur variable selon la pression du stylet. */
  pressure: boolean
  highlighterColor: string
  highlighterWidth: number
  /** Rond / rectangle / triangle dessinés à main levée rendus parfaits en tenant le stylet immobile. */
  shapeRecognition: boolean
  /** Style des nouvelles pages (« + Page »). */
  paper: import('../core/paper').PaperStyle
  /** Couleurs favorites (barre rapide). */
  favorites: string[]
  /** Surligneur aimanté aux lignes de texte des PDF. */
  highlightSnap: boolean
  eraserSize: number
  eraserMode: EraserMode
  shape: ShapeKind
  shapeStroke: string
  shapeFill: string
  shapeWidth: number
  shapeStyle: LineStyle
  fontFamily: string
  fontSize: number
  textColor: string
  tableRows: number
  tableCols: number
  cursor: CursorStyle
  /** Bouton du stylet le plus proche de la pointe (clic droit). */
  penButton1: PenButtonAction
  /** Second bouton du stylet (clic du milieu). */
  penButton2: PenButtonAction
  /** Bout gomme (stylet retourné). */
  penEraserEnd: PenButtonAction
  /** Écriture → texte : ce qui est écrit au stylo est remplacé par du texte après une pause. */
  handwriting: boolean
  /** Pause (ms) avant la conversion. */
  handwritingDelay: number
}

const DEFAULTS: ToolSettings = {
  penColor: '#1b1b1f',
  penWidth: 2.5,
  penStyle: 'solid',
  pressure: true,
  highlighterColor: '#ffe600',
  highlighterWidth: 14,
  highlightSnap: true,
  shapeRecognition: true,
  paper: 'plain',
  favorites: ['#1b1b1f', '#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6'],
  eraserSize: 16,
  eraserMode: 'partial',
  shape: 'rect',
  shapeStroke: '#1b1b1f',
  shapeFill: 'transparent',
  shapeWidth: 2,
  shapeStyle: 'solid',
  fontFamily: 'Helvetica',
  fontSize: 14,
  textColor: '#1b1b1f',
  tableRows: 3,
  tableCols: 3,
  cursor: 'dot',
  penButton1: 'lasso',
  penButton2: 'hand',
  penEraserEnd: 'eraser',
  handwriting: false,
  handwritingDelay: 1200
}

const KEY = 'feuillet.tools.v1'

class SettingsStore {
  value: ToolSettings
  private listeners = new Set<() => void>()

  constructor() {
    let saved: Partial<ToolSettings> = {}
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    } catch {
      // réglages par défaut
    }
    this.value = { ...DEFAULTS, ...saved }
  }

  set<K extends keyof ToolSettings>(key: K, v: ToolSettings[K]): void {
    this.value[key] = v
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      // non persistant
    }
    this.listeners.forEach((l) => l())
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn)
  }
}

export const settings = new SettingsStore()

/** Motif de tirets proportionnel à l'épaisseur (les points s'appuient sur les extrémités rondes). */
export function dashArray(style: LineStyle, width: number): number[] | null {
  if (style === 'dashed') return [width * 3, width * 2]
  if (style === 'dotted') return [0.001, width * 2]
  return null
}

export const SWATCHES = [
  '#1b1b1f', '#ffffff', '#7f7f7f', '#e5484d', '#f76b15', '#ffc53d', '#ffe600', '#30a46c',
  '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#a18072'
]
