/**
 * Raccourcis clavier configurables. Chaque action est liée à une combinaison
 * normalisée ("Ctrl+Shift+Z", "Equal", ...). Les liaisons sont persistées
 * localement pour que l'utilisateur puisse choisir ses touches de zoom, etc.
 */
export type ActionId =
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'undo'
  | 'redo'
  | 'newPage'
  | 'delete'
  | 'tool.select'
  | 'tool.pen'
  | 'tool.hand'

export const DEFAULT_BINDINGS: Record<ActionId, string[]> = {
  zoomIn: ['Equal', 'NumpadAdd', 'Ctrl+Equal'],
  zoomOut: ['Minus', 'NumpadSubtract', 'Ctrl+Minus'],
  zoomReset: ['Ctrl+Digit0'],
  undo: ['Ctrl+KeyZ'],
  redo: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'],
  newPage: ['Ctrl+KeyN'],
  delete: ['Delete', 'Backspace'],
  'tool.select': ['KeyV'],
  'tool.pen': ['KeyP'],
  'tool.hand': ['KeyH']
}

const STORAGE_KEY = 'feuillet.shortcuts.v1'

/** Combinaison normalisée à partir d'un évènement clavier (indépendante de la disposition AZERTY/QWERTY). */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.code)
  return parts.join('+')
}

/** Libellé lisible d'une combinaison, pour l'interface. */
export function prettyCombo(combo: string): string {
  return combo
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace('Equal', '+')
    .replace('Minus', '−')
    .replace('NumpadAdd', 'Pavé +')
    .replace('NumpadSubtract', 'Pavé −')
    .replace('Shift', 'Maj')
}

export class ShortcutManager {
  private bindings: Record<ActionId, string[]>
  private handlers = new Map<ActionId, () => void>()

  constructor() {
    this.bindings = { ...DEFAULT_BINDINGS, ...this.load() }
    window.addEventListener('keydown', (e) => this.onKeyDown(e))
  }

  on(action: ActionId, handler: () => void): void {
    this.handlers.set(action, handler)
  }

  get(action: ActionId): string[] {
    return this.bindings[action]
  }

  set(action: ActionId, combos: string[]): void {
    this.bindings[action] = combos
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings))
    } catch {
      // stockage indisponible : la liaison reste valable pour la session
    }
  }

  private load(): Partial<Record<ActionId, string[]>> {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    } catch {
      return {}
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    const combo = comboFromEvent(e)
    for (const [action, combos] of Object.entries(this.bindings) as [ActionId, string[]][]) {
      if (!combos.includes(combo)) continue
      const handler = this.handlers.get(action)
      if (!handler) continue
      e.preventDefault()
      handler()
      return
    }
  }
}
