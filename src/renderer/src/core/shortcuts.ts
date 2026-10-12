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
  | 'new'
  | 'open'
  | 'insert'
  | 'save'
  | 'export'
  | 'duplicate'
  | 'selectAll'
  | 'group'
  | 'ungroup'
  | 'front'
  | 'back'
  | 'delete'
  | 'deselect'
  | 'nudge.left'
  | 'nudge.right'
  | 'nudge.up'
  | 'nudge.down'
  | 'nudge.left.big'
  | 'nudge.right.big'
  | 'nudge.up.big'
  | 'nudge.down.big'
  | 'find'
  | 'saveAs'
  | 'print'
  | 'fullscreen'
  | 'preferences'
  | 'goto'
  | 'sidebar'
  | 'pageNext'
  | 'pagePrev'
  | 'pageFirst'
  | 'pageLast'
  | 'zoomWidth'
  | 'zoomActual'
  | 'tool.select'
  | 'tool.lasso'
  | 'tool.textselect'
  | 'tool.edittext'
  | 'tool.pen'
  | 'tool.highlighter'
  | 'tool.eraser'
  | 'tool.shape'
  | 'tool.text'
  | 'tool.hand'

/** Copier / Couper / Coller passent par les évènements presse-papiers du système (voir editing.ts). */
export const DEFAULT_BINDINGS: Record<ActionId, string[]> = {
  // « key:x » = caractère produit : fonctionne en AZERTY comme en QWERTY.
  zoomIn: ['key:+', 'key:=', 'NumpadAdd', 'Ctrl+key:+', 'Ctrl+key:=', 'Ctrl+NumpadAdd'],
  zoomOut: ['key:-', 'NumpadSubtract', 'Ctrl+key:-', 'Ctrl+NumpadSubtract'],
  zoomReset: ['Ctrl+Digit0', 'Ctrl+Numpad0'],
  undo: ['Ctrl+KeyZ'],
  redo: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'],
  new: ['Ctrl+KeyN'],
  open: ['Ctrl+KeyO'],
  insert: ['Ctrl+KeyI'],
  save: ['Ctrl+KeyS'],
  export: ['Ctrl+KeyE'],
  duplicate: ['Ctrl+KeyD'],
  selectAll: ['Ctrl+KeyA'],
  group: ['Ctrl+KeyG'],
  ungroup: ['Ctrl+Shift+KeyG'],
  front: ['Ctrl+Shift+BracketRight'],
  back: ['Ctrl+Shift+BracketLeft'],
  delete: ['Delete', 'Backspace'],
  deselect: ['Escape'],
  'nudge.left': ['ArrowLeft'],
  'nudge.right': ['ArrowRight'],
  'nudge.up': ['ArrowUp'],
  'nudge.down': ['ArrowDown'],
  'nudge.left.big': ['Shift+ArrowLeft'],
  'nudge.right.big': ['Shift+ArrowRight'],
  'nudge.up.big': ['Shift+ArrowUp'],
  'nudge.down.big': ['Shift+ArrowDown'],
  find: ['Ctrl+KeyF'],
  saveAs: ['Ctrl+Shift+KeyS'],
  print: ['Ctrl+KeyP'],
  fullscreen: ['F11'],
  preferences: ['Ctrl+Comma'],
  goto: ['KeyG', 'Ctrl+Shift+KeyN'],
  sidebar: ['F9'],
  pageNext: ['PageDown'],
  pagePrev: ['PageUp'],
  pageFirst: ['Home'],
  pageLast: ['End'],
  zoomWidth: ['Ctrl+Digit2'],
  zoomActual: ['Ctrl+Digit1'],
  'tool.select': ['KeyV'],
  'tool.lasso': ['KeyL'],
  'tool.textselect': ['KeyX'],
  'tool.edittext': ['KeyM'],
  'tool.pen': ['KeyP'],
  'tool.highlighter': ['KeyS'],
  'tool.eraser': ['KeyE'],
  'tool.shape': ['KeyR'],
  'tool.text': ['KeyT'],
  'tool.hand': ['KeyH']
}

const STORAGE_KEY = 'feuillet.shortcuts.v3'

/** Combinaison normalisée à partir d'un évènement clavier (indépendante de la disposition AZERTY/QWERTY). */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.code)
  return parts.join('+')
}

/** Combinaison par caractère (Maj ignorée car elle change déjà le caractère). */
export function keyComboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  parts.push('key:' + e.key)
  return parts.join('+')
}

/** Libellé lisible d'une combinaison, pour l'interface. */
export function prettyCombo(combo: string): string {
  return combo
    .replace(/key:(.)/g, '$1')
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace('Equal', '+')
    .replace('Minus', '−')
    .replace('NumpadAdd', 'Pavé +')
    .replace('NumpadSubtract', 'Pavé −')
    .replace('Shift', 'Maj')
    .replace('Comma', ',')
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

  /** Rétablit tous les raccourcis par défaut. */
  reset(): void {
    this.bindings = { ...DEFAULT_BINDINGS }
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // sans importance
    }
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
    const keyCombo = keyComboFromEvent(e)
    for (const [action, combos] of Object.entries(this.bindings) as [ActionId, string[]][]) {
      if (!combos.includes(combo) && !combos.includes(keyCombo)) continue
      const handler = this.handlers.get(action)
      if (!handler) continue
      e.preventDefault()
      handler()
      return
    }
  }
}
