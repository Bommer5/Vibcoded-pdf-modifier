import type { Canvas } from 'fabric'

/**
 * Historique annuler/rétablir par instantanés JSON du canevas.
 * Simple et fiable ; sera remplacé par des commandes différentielles
 * quand les documents deviendront volumineux.
 */
export class History {
  private undoStack: string[] = []
  private redoStack: string[] = []
  private current = ''
  private restoring = false
  private readonly limit = 100

  constructor(
    private canvas: Canvas,
    private onChange: () => void = () => {}
  ) {
    this.current = this.serialize()
    const record = (): void => this.record()
    canvas.on('object:added', record)
    canvas.on('object:removed', record)
    canvas.on('object:modified', record)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Enregistre l'état courant comme nouvelle étape. */
  record(): void {
    if (this.restoring) return
    const next = this.serialize()
    if (next === this.current) return
    this.undoStack.push(this.current)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.current = next
    this.onChange()
  }

  /** Réinitialise l'historique (nouveau document). */
  reset(): void {
    this.undoStack = []
    this.redoStack = []
    this.current = this.serialize()
    this.onChange()
  }

  async undo(): Promise<void> {
    const prev = this.undoStack.pop()
    if (prev === undefined) return
    this.redoStack.push(this.current)
    await this.restore(prev)
  }

  async redo(): Promise<void> {
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.undoStack.push(this.current)
    await this.restore(next)
  }

  private serialize(): string {
    return JSON.stringify(this.canvas.toObject(['selectable', 'evented', 'excludeFromExport', 'pageId']))
  }

  private async restore(state: string): Promise<void> {
    this.restoring = true
    try {
      await this.canvas.loadFromJSON(state)
      this.canvas.requestRenderAll()
      this.current = state
    } finally {
      this.restoring = false
    }
    this.onChange()
  }
}
