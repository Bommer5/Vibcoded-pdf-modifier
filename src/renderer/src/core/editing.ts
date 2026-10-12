import { ActiveSelection, Group, Point, util, type FabricObject } from 'fabric'
import type { Editor } from './editor'
import type { Importer } from '../io/importer'
import { isPageLayer } from './props'

const CLIP_MIME = 'application/x-feuillet+json'
const PASTE_OFFSET = 16

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/**
 * Commandes d'édition de la sélection, pensées pour « juste marcher » :
 * - Ctrl+C / Ctrl+X / Ctrl+V : la copie est collée sous le pointeur,
 *   déjà sélectionnée, et se déplace immédiatement à la souris ou au stylet.
 * - Coller plusieurs fois au même endroit décale chaque copie (pas d'empilement invisible).
 * - Les images et le texte venant d'autres applications se collent aussi.
 * - Toute opération composée = une seule étape d'annulation.
 */
export class Editing {
  private clip: object | null = null
  private pasteAnchor: Point | null = null
  private pasteCount = 0

  constructor(
    private ed: Editor,
    private importer: Importer
  ) {
    document.addEventListener('copy', (e) => this.onCopy(e, false))
    document.addEventListener('cut', (e) => this.onCopy(e, true))
    document.addEventListener('paste', (e) => void this.onPaste(e))
  }

  private get canvas() {
    return this.ed.canvas
  }

  get selection(): FabricObject[] {
    return this.canvas.getActiveObjects()
  }

  // --- Presse-papiers --------------------------------------------------------

  /** Copie la sélection dans le presse-papiers interne (boutons, mobile). */
  copy(): boolean {
    const active = this.canvas.getActiveObject()
    if (!active) return false
    this.clip = active.toObject()
    this.pasteCount = 0
    this.pasteAnchor = null
    return true
  }

  cut(): void {
    if (this.copy()) void this.deleteSelection()
  }

  async paste(): Promise<void> {
    if (this.clip) await this.pasteJson(this.clip)
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (isEditable(e.target) || !this.copy()) return
    e.preventDefault()
    e.clipboardData?.setData(CLIP_MIME, JSON.stringify(this.clip))
    // Texte brut pour les autres applications quand la sélection contient du texte.
    const text = this.selection
      .map((o) => (o as FabricObject & { text?: string }).text)
      .filter(Boolean)
      .join('\n')
    e.clipboardData?.setData('text/plain', text)
    if (cut) void this.deleteSelection()
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    if (isEditable(e.target) || !e.clipboardData) return
    e.preventDefault()
    const data = e.clipboardData
    const own = data.getData(CLIP_MIME)
    if (own) return this.pasteJson(JSON.parse(own))

    const files = [...data.files]
    if (files.length > 0) {
      const opened = await Promise.all(files.map(async (f) => ({ name: f.name || 'image.png', data: new Uint8Array(await f.arrayBuffer()) })))
      return this.importer.insert(opened, this.anchor())
    }
    const image = [...data.items].find((i) => i.type.startsWith('image/'))?.getAsFile()
    if (image) return this.importer.insertImageBlob(image, this.anchor())

    const text = data.getData('text/plain')
    if (text) {
      return this.importer.insert([{ name: 'presse-papiers.txt', data: new TextEncoder().encode(text) }], this.anchor())
    }
  }

  /** Point de collage : sous le pointeur, décalé si on colle plusieurs fois au même endroit. */
  private anchor(): Point | null {
    const at = this.ed.pointer()
    if (at && (!this.pasteAnchor || at.distanceFrom(this.pasteAnchor) > 4)) {
      this.pasteAnchor = at
      this.pasteCount = 0
    } else {
      this.pasteCount++
    }
    if (!this.pasteAnchor) return null
    const d = this.pasteCount * PASTE_OFFSET
    return new Point(this.pasteAnchor.x + d, this.pasteAnchor.y + d)
  }

  private async pasteJson(json: object): Promise<void> {
    const at = this.anchor()
    const [obj] = (await util.enlivenObjects([json])) as FabricObject[]
    if (!obj) return
    if (at) {
      obj.setPositionByOrigin(at, 'center', 'center')
    } else {
      // Pas de pointeur (bouton, mobile) : à côté de l'original, décalé.
      const d = (this.pasteCount + 1) * PASTE_OFFSET
      obj.set({ left: obj.left + d, top: obj.top + d })
      this.pasteCount++
    }
    await this.ed.history.transaction(() => this.addAndSelect(obj))
  }

  // --- Commandes ---------------------------------------------------------------

  async duplicate(): Promise<void> {
    const active = this.canvas.getActiveObject()
    if (!active) return
    const copy = await active.clone()
    copy.set({ left: copy.left + PASTE_OFFSET, top: copy.top + PASTE_OFFSET })
    await this.ed.history.transaction(() => this.addAndSelect(copy))
  }

  async deleteSelection(): Promise<void> {
    const objs = this.selection
    if (objs.length === 0) return
    await this.ed.history.transaction(() => {
      this.canvas.discardActiveObject()
      this.canvas.remove(...objs)
    })
    this.canvas.requestRenderAll()
  }

  selectAll(): void {
    const objs = this.canvas.getObjects().filter((o) => !isPageLayer(o) && o.selectable && o.visible)
    this.canvas.discardActiveObject()
    if (objs.length === 1) this.canvas.setActiveObject(objs[0])
    else if (objs.length > 1) this.canvas.setActiveObject(new ActiveSelection(objs, { canvas: this.canvas }))
    this.canvas.requestRenderAll()
  }

  /** Déplacement au clavier : 1 pt, ou 10 pt avec Maj. */
  nudge(dx: number, dy: number): void {
    const active = this.canvas.getActiveObject()
    if (!active) return
    active.set({ left: active.left + dx, top: active.top + dy })
    active.setCoords()
    this.canvas.requestRenderAll()
    this.canvas.fire('object:modified', { target: active })
  }

  async group(): Promise<void> {
    const active = this.canvas.getActiveObject()
    if (!(active instanceof ActiveSelection) || active.size() < 2) return
    await this.ed.history.transaction(() => {
      const objs = active.removeAll()
      this.canvas.discardActiveObject()
      this.canvas.remove(...objs)
      const group = new Group(objs)
      this.ed.add(group)
      this.canvas.setActiveObject(group)
    })
    this.canvas.requestRenderAll()
  }

  async ungroup(): Promise<void> {
    const active = this.canvas.getActiveObject()
    if (!(active instanceof Group) || active instanceof ActiveSelection) return
    await this.ed.history.transaction(() => {
      const index = this.canvas.getObjects().indexOf(active)
      const objs = active.removeAll()
      this.canvas.remove(active)
      objs.forEach((o, i) => this.canvas.insertAt(index + i, o))
      this.canvas.setActiveObject(new ActiveSelection(objs, { canvas: this.canvas }))
    })
    this.canvas.requestRenderAll()
  }

  /** Ordre d'empilement ; le contenu reste toujours au-dessus des pages. */
  async arrange(where: 'front' | 'back' | 'forward' | 'backward'): Promise<void> {
    const objs = this.selection
    if (objs.length === 0) return
    const floor = this.ed.doc.layerCount()
    const all = this.canvas.getObjects()
    const top = all.length - 1
    await this.ed.history.transaction(() => {
      const ordered = [...objs].sort((a, b) => all.indexOf(a) - all.indexOf(b))
      const list = where === 'front' || where === 'forward' ? [...ordered].reverse() : ordered
      list.forEach((o, i) => {
        const index = this.canvas.getObjects().indexOf(o)
        const target =
          where === 'front' ? top - i : where === 'back' ? floor + i : where === 'forward' ? Math.min(top - i, index + 1) : Math.max(floor + i, index - 1)
        this.canvas.moveObjectTo(o, target)
      })
    })
    this.canvas.requestRenderAll()
  }

  private addAndSelect(obj: FabricObject): void {
    this.canvas.discardActiveObject()
    if (obj instanceof ActiveSelection) {
      obj.canvas = this.canvas
      obj.forEachObject((o) => this.ed.add(o))
      obj.setCoords()
    } else {
      this.ed.add(obj)
    }
    this.canvas.setActiveObject(obj)
    this.canvas.requestRenderAll()
  }
}
