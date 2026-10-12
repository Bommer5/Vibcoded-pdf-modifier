import { FabricObject, util, type Canvas } from 'fabric'
import './props'

type Uid = string
type Tracked = FabricObject & { uid?: Uid; __histDirty?: boolean; group?: FabricObject; parent?: FabricObject }

/** Une étape = différence entre deux états (et non une copie complète du document). */
interface Step {
  added: [Uid, string][]
  removed: [Uid, string][]
  modified: [Uid, string, string][]
  orderBefore?: Uid[]
  orderAfter?: Uid[]
}

// Toute modification d'un objet (set, déplacement, style…) le marque « à re-sérialiser ».
const originalSet = FabricObject.prototype._set
FabricObject.prototype._set = function (this: Tracked, key: string, value: unknown) {
  let o: Tracked | undefined = this
  while (o && !o.__histDirty) {
    o.__histDirty = true
    o = (o.group ?? o.parent) as Tracked | undefined
  }
  return originalSet.call(this, key, value)
} as typeof originalSet

FabricObject.customProperties.push('uid')

/**
 * Historique annuler / rétablir incrémental :
 * - seuls les objets modifiés depuis la dernière étape sont re-sérialisés ;
 * - une étape ne stocke que les objets ajoutés, supprimés ou modifiés ;
 * - annuler ne recrée que ces objets (pas de rechargement complet du document).
 * Coût d'un trait sur un document de 100 pages : quelques microsecondes au lieu de tout recopier.
 */
export class History {
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private current = new Map<Uid, string>()
  private order: Uid[] = []
  private suspended = 0
  private readonly limit = 200
  /** Les restaurations s'enchaînent : Ctrl+Z maintenu ne mélange jamais deux états. */
  private queue: Promise<void> = Promise.resolve()
  private live = new Map<Uid, Tracked>()

  constructor(
    private canvas: Canvas,
    private onChange: () => void = () => {}
  ) {
    canvas.on('object:added', ({ target }) => {
      const t = target as Tracked
      if (!t.uid || (this.live.has(t.uid) && this.live.get(t.uid) !== t)) t.uid = crypto.randomUUID()
      this.live.set(t.uid, t)
      this.record()
    })
    canvas.on('object:removed', ({ target }) => {
      const t = target as Tracked
      if (t.uid && this.live.get(t.uid) === t) this.live.delete(t.uid)
      this.record()
    })
    canvas.on('object:modified', () => this.record())
    canvas.on('text:changed', ({ target }) => ((target as Tracked).__histDirty = true))
    this.snapshotAll()
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

  /** Marque un objet comme modifié (changement fait sans passer par `set`). */
  touch(obj: FabricObject): void {
    ;(obj as Tracked).__histDirty = true
  }

  private serialize(o: Tracked): string {
    // _toObject replace les objets d'une sélection multiple dans le repère du document.
    const json = JSON.stringify((this.canvas as unknown as { _toObject(o: FabricObject, m: string, p: string[]): object })._toObject(o, 'toObject', []))
    o.__histDirty = false
    return json
  }

  private uidOf(o: Tracked): Uid {
    if (!o.uid) o.uid = crypto.randomUUID()
    this.live.set(o.uid, o)
    return o.uid
  }

  private snapshotAll(): void {
    this.current.clear()
    this.order = []
    for (const o of this.canvas.getObjects() as Tracked[]) {
      const uid = this.uidOf(o)
      this.order.push(uid)
      this.current.set(uid, this.serialize(o))
    }
  }

  /** Enregistre l'état courant comme nouvelle étape (si quelque chose a changé). */
  record(): void {
    if (this.suspended > 0) return
    const active = new Set(this.canvas.getActiveObjects())
    const objects = this.canvas.getObjects() as Tracked[]
    const order: Uid[] = []
    const next = new Map<Uid, string>()
    const step: Step = { added: [], removed: [], modified: [] }
    for (const o of objects) {
      const uid = this.uidOf(o)
      order.push(uid)
      const before = this.current.get(uid)
      const json = before === undefined || o.__histDirty || active.has(o) ? this.serialize(o) : before
      next.set(uid, json)
      if (before === undefined) step.added.push([uid, json])
      else if (before !== json) step.modified.push([uid, before, json])
    }
    for (const [uid, json] of this.current) if (!next.has(uid)) step.removed.push([uid, json])
    const orderChanged = order.length !== this.order.length || order.some((u, i) => u !== this.order[i])
    if (orderChanged) {
      step.orderBefore = this.order
      step.orderAfter = order
    }
    this.current = next
    this.order = order
    if (!step.added.length && !step.removed.length && !step.modified.length && !orderChanged) return
    this.undoStack.push(step)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.onChange()
  }

  /** Réinitialise l'historique (nouveau document). */
  reset(): void {
    this.undoStack = []
    this.redoStack = []
    this.snapshotAll()
    this.onChange()
  }

  /** Attend la fin des annulations / rétablissements en cours. */
  idle(): Promise<void> {
    return this.queue
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      const step = this.undoStack.pop()
      if (!step) return
      await this.apply(step, 'back')
      this.redoStack.push(step)
    })
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      const step = this.redoStack.pop()
      if (!step) return
      await this.apply(step, 'forward')
      this.undoStack.push(step)
    })
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((e) => console.error(e))
    return this.queue
  }

  /** Applique une étape dans un sens, en ne touchant que les objets concernés. */
  private async apply(step: Step, dir: 'back' | 'forward'): Promise<void> {
    const back = dir === 'back'
    const toRemove = (back ? step.added : step.removed).map(([uid]) => uid)
    const toAdd = back ? step.removed : step.added
    const toReplace = step.modified.map(([uid, before, after]) => [uid, back ? before : after] as [Uid, string])
    const order = back ? step.orderBefore : step.orderAfter

    this.suspended++
    try {
      this.canvas.discardActiveObject()
      const fresh = (await util.enlivenObjects([...toAdd, ...toReplace].map(([, json]) => JSON.parse(json)))) as Tracked[]
      const byUid = new Map<Uid, Tracked>()
      fresh.forEach((o, i) => {
        o.uid = (i < toAdd.length ? toAdd[i] : toReplace[i - toAdd.length])[0]
        byUid.set(o.uid, o)
      })
      const objects = this.canvas.getObjects() as Tracked[]
      for (const o of objects) {
        if (!o.uid) continue
        if (toRemove.includes(o.uid) || byUid.has(o.uid)) this.canvas.remove(o)
      }
      for (const o of fresh) this.canvas.add(o)
      // Ordre d'empilement : celui de l'état visé, ou on remet les objets remplacés à leur place.
      const target = order ?? this.order.filter((u) => !toRemove.includes(u)).concat(toAdd.map(([u]) => u).filter((u) => !this.order.includes(u)))
      const live = new Map((this.canvas.getObjects() as Tracked[]).map((o) => [o.uid!, o]))
      const sorted = target.map((u) => live.get(u)).filter((o): o is Tracked => !!o)
      const internal = this.canvas as unknown as { _objects: FabricObject[] }
      if (sorted.length === internal._objects.length) internal._objects = sorted

      for (const uid of toRemove) this.current.delete(uid)
      for (const [uid, json] of [...toAdd, ...toReplace]) this.current.set(uid, json)
      for (const o of fresh) o.__histDirty = false
      this.order = (this.canvas.getObjects() as Tracked[]).map((o) => o.uid!)
      this.canvas.requestRenderAll()
    } finally {
      this.suspended--
    }
    this.onChange()
  }
}
