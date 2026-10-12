import type { Canvas } from 'fabric'

/**
 * Historique annuler/rétablir par instantanés JSON du canevas.
 * Les opérations composées (coller plusieurs objets, importer un PDF…)
 * passent par `transaction()` pour ne former qu'une seule étape.
 */
export class History {
  private undoStack: string[] = []
  private redoStack: string[] = []
  private current = ''
  private suspended = 0
  private readonly limit = 100
  /** Les restaurations s'enchaînent : Ctrl+Z maintenu ne mélange jamais deux états. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private canvas: Canvas,
    private onChange: () => void = () => {}
  ) {
    this.current = this.serialize()
    const record = (): void => this.record()
    canvas.on('object:added', record)
    canvas.on('object:removed', record)
    canvas.on('object:modified', record)
    canvas.on('path:created', record)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Exécute `fn` puis enregistre une seule étape d'historique. */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.suspended++
    try {
      return await fn()
    } finally {
      this.suspended--
      this.record()
    }
  }

  /** Ouvre une étape manuelle (geste de gomme…) ; à refermer par `end()`. */
  begin(): void {
    this.suspended++
  }

  end(): void {
    this.suspended = Math.max(0, this.suspended - 1)
    this.record()
  }

  /** Enregistre l'état courant comme nouvelle étape. */
  record(): void {
    if (this.suspended > 0) return
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

  /** Attend la fin des annulations / rétablissements en cours. */
  idle(): Promise<void> {
    return this.queue
  }

  undo(): Promise<void> {
    return this.enqueue(() => {
      const prev = this.undoStack.pop()
      if (prev === undefined) return
      this.redoStack.push(this.current)
      return this.restore(prev)
    })
  }

  redo(): Promise<void> {
    return this.enqueue(() => {
      const next = this.redoStack.pop()
      if (next === undefined) return
      this.undoStack.push(this.current)
      return this.restore(next)
    })
  }

  private enqueue(fn: () => Promise<void> | void): Promise<void> {
    this.queue = this.queue.then(fn).catch((e) => console.error(e))
    return this.queue
  }

  private serialize(): string {
    return JSON.stringify(this.canvas.toObject())
  }

  private async restore(state: string): Promise<void> {
    this.suspended++
    try {
      this.canvas.discardActiveObject()
      await this.canvas.loadFromJSON(state)
      this.canvas.requestRenderAll()
      this.current = state
    } finally {
      this.suspended--
    }
    this.onChange()
  }
}
