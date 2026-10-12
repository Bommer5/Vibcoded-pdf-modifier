import type { FabricObject } from 'fabric'
import type { Editor } from './editor'
import { isPageLayer } from './props'

export interface Layer {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

type Obj = FabricObject & { layer?: string }

/**
 * Calques : chaque objet appartient à un calque. On peut masquer, verrouiller,
 * renommer, réordonner les calques ; les nouveaux objets vont dans le calque actif.
 * L'ordre d'empilement des objets suit l'ordre des calques.
 */
export class Layers {
  list: Layer[] = []
  active = ''
  private listeners = new Set<() => void>()

  constructor(private ed: Editor) {
    this.reset()
    ed.canvas.on('object:added', ({ target }) => {
      const o = target as Obj
      if (isPageLayer(o)) return
      if (!o.layer || !this.get(o.layer)) o.layer = this.active
      this.applyState(o)
      this.applyOrder()
    })
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn)
  }

  private changed(): void {
    this.ed.canvas.requestRenderAll()
    this.listeners.forEach((l) => l())
  }

  get(id: string): Layer | undefined {
    return this.list.find((l) => l.id === id)
  }

  reset(): void {
    this.list = [{ id: crypto.randomUUID(), name: 'Calque 1', visible: true, locked: false }]
    this.active = this.list[0].id
    this.changed()
  }

  /** Restaure les calques d'un projet (ou en crée à partir des noms trouvés dans les objets). */
  load(list: Layer[] | undefined, objects: FabricObject[] = this.ed.doc.content): void {
    if (list?.length) this.list = list
    else {
      const names = [...new Set(objects.map((o) => (o as Obj & { layerName?: string }).layerName ?? 'Calque 1'))]
      this.list = names.map((name) => ({ id: crypto.randomUUID(), name, visible: true, locked: false }))
      for (const o of objects as (Obj & { layerName?: string })[]) {
        o.layer = this.list.find((l) => l.name === (o.layerName ?? 'Calque 1'))!.id
      }
    }
    this.active = this.list.at(-1)!.id
    for (const o of objects as Obj[]) {
      if (!o.layer || !this.get(o.layer)) o.layer = this.list[0].id
      this.applyState(o)
    }
    this.applyOrder()
    this.changed()
  }

  add(): void {
    const layer = { id: crypto.randomUUID(), name: `Calque ${this.list.length + 1}`, visible: true, locked: false }
    this.list.push(layer)
    this.active = layer.id
    this.changed()
  }

  remove(id: string): void {
    if (this.list.length <= 1) return
    const index = this.list.findIndex((l) => l.id === id)
    const fallback = this.list[index === 0 ? 1 : index - 1]
    for (const o of this.objectsOf(id)) o.layer = fallback.id
    this.list.splice(index, 1)
    if (this.active === id) this.active = fallback.id
    for (const o of this.objectsOf(fallback.id)) this.applyState(o)
    this.applyOrder()
    this.ed.history.record()
    this.changed()
  }

  move(id: string, dir: 1 | -1): void {
    const i = this.list.findIndex((l) => l.id === id)
    const j = i + dir
    if (j < 0 || j >= this.list.length) return
    ;[this.list[i], this.list[j]] = [this.list[j], this.list[i]]
    this.applyOrder()
    this.ed.history.record()
    this.changed()
  }

  setVisible(id: string, visible: boolean): void {
    this.get(id)!.visible = visible
    for (const o of this.objectsOf(id)) this.applyState(o)
    if (!visible) this.ed.canvas.discardActiveObject()
    this.changed()
  }

  setLocked(id: string, locked: boolean): void {
    this.get(id)!.locked = locked
    for (const o of this.objectsOf(id)) this.applyState(o)
    if (locked) this.ed.canvas.discardActiveObject()
    this.changed()
  }

  rename(id: string, name: string): void {
    this.get(id)!.name = name.trim() || this.get(id)!.name
    this.changed()
  }

  /** Déplace la sélection vers un calque. */
  moveSelection(id: string): void {
    const sel = this.ed.canvas.getActiveObjects() as Obj[]
    this.ed.canvas.discardActiveObject()
    for (const o of sel) {
      o.set({ layer: id } as never)
      this.applyState(o)
    }
    this.applyOrder()
    this.ed.history.record()
    this.changed()
  }

  private objectsOf(id: string): Obj[] {
    return (this.ed.doc.content as Obj[]).filter((o) => o.layer === id)
  }

  private applyState(o: Obj): void {
    const layer = this.get(o.layer ?? '') ?? this.list[0]
    o.visible = layer.visible
    o.selectable = layer.visible && !layer.locked
    o.evented = layer.visible && !layer.locked
  }

  /** Empile les objets par calque (ordre interne à chaque calque conservé). */
  applyOrder(): void {
    const canvas = this.ed.canvas as unknown as { _objects: FabricObject[] }
    const rank = new Map(this.list.map((l, i) => [l.id, i]))
    const pages = canvas._objects.filter(isPageLayer)
    const content = canvas._objects.filter((o) => !isPageLayer(o))
    const sorted = content
      .map((o, i) => ({ o, i, r: rank.get((o as Obj).layer ?? '') ?? 0 }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.o)
    if (sorted.some((o, i) => o !== content[i])) canvas._objects = [...pages, ...sorted]
  }

  // --- Panneau ----------------------------------------------------------------------

  renderPanel(root: HTMLElement): void {
    const wrap = document.createElement('div')
    wrap.className = 'layers'
    const bar = document.createElement('div')
    bar.className = 'prop-row'
    const btn = (text: string, title: string, fn: () => void, parent: HTMLElement = bar): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'prop-mini'
      b.textContent = text
      b.title = title
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fn()
      })
      parent.append(b)
      return b
    }
    btn('+ Calque', 'Nouveau calque', () => this.add())
    btn('Sélection ici', 'Déplacer la sélection dans le calque actif', () => this.moveSelection(this.active))
    wrap.append(bar)
    const list = document.createElement('ul')
    list.className = 'layer-list'
    for (const layer of [...this.list].reverse()) {
      const li = document.createElement('li')
      li.className = `layer ${layer.id === this.active ? 'active' : ''}`
      li.addEventListener('click', () => {
        this.active = layer.id
        this.changed()
      })
      btn(layer.visible ? '👁' : '◌', layer.visible ? 'Masquer' : 'Afficher', () => this.setVisible(layer.id, !layer.visible), li)
      btn(layer.locked ? '🔒' : '🔓', layer.locked ? 'Déverrouiller' : 'Verrouiller', () => this.setLocked(layer.id, !layer.locked), li)
      const name = document.createElement('span')
      name.className = 'layer-name'
      name.textContent = `${layer.name} (${this.objectsOf(layer.id).length})`
      name.title = 'Double-clic pour renommer'
      name.addEventListener('dblclick', () => {
        const value = prompt('Nom du calque', layer.name)
        if (value) this.rename(layer.id, value)
      })
      li.append(name)
      btn('↑', 'Monter', () => this.move(layer.id, 1), li)
      btn('↓', 'Descendre', () => this.move(layer.id, -1), li)
      btn('✕', 'Supprimer le calque (son contenu passe dans le calque inférieur)', () => this.remove(layer.id), li)
      list.append(li)
    }
    wrap.append(list)
    root.replaceChildren(wrap)
  }
}
