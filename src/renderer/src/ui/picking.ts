import { ActiveSelection, Group, type FabricObject, type TPointerEvent } from 'fabric'
import { isChart } from '../charts/chart-object'
import { isGraph } from '../graph/graph-object'
import type { Editor } from '../core/editor'
import { isPageLayer } from '../core/props'
import { Table } from '../objects/table'
import type { InkObject } from '../tools/ink'
import { penGesture, type ToolManager } from '../tools/manager'
import { icon, type IconName } from './icons'

type Pickable = FabricObject & { locked?: boolean; markup?: unknown; shape?: string; text?: string; assetId?: string; pdfPage?: unknown }

const SHAPE_NAMES: Record<string, string> = { line: 'Ligne', arrow: 'Flèche', rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle' }

/** Nom lisible et icône d'un objet, pour la liste « Sélectionner ». */
export function describe(o: Pickable): { name: string; icon: IconName } {
  const ink = (o as InkObject).ink
  if (ink) return ink.tool === 'highlighter' ? { name: 'Surlignage', icon: 'highlighter' } : { name: 'Trait de stylo', icon: 'pen' }
  if (o.markup) return { name: 'Surlignage du texte', icon: 'highlighter' }
  if (o.shape) return { name: SHAPE_NAMES[o.shape] ?? 'Forme', icon: 'shape' }
  if ((o as FabricObject) instanceof Table) return { name: 'Tableau', icon: 'table' }
  if (isChart(o as FabricObject)) return { name: 'Graphique', icon: 'chart' }
  if (isGraph(o as FabricObject)) return { name: 'Graphe', icon: 'graph' }
  if (typeof o.text === 'string') {
    const t = o.text.replace(/\s+/g, ' ').trim()
    return { name: `Texte « ${t.length > 24 ? `${t.slice(0, 24)}…` : t} »`, icon: 'text' }
  }
  if (o.pdfPage) return { name: 'Page PDF (image)', icon: 'image' }
  if (o.assetId) return { name: 'Image', icon: 'image' }
  if (o instanceof Group) return { name: `Groupe (${o.size()} objets)`, icon: 'group' }
  const byType: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', circle: 'Cercle', triangle: 'Triangle', line: 'Ligne', path: 'Dessin', polyline: 'Ligne brisée', polygon: 'Polygone' }
  return { name: byType[o.type?.toLowerCase()] ?? 'Objet', icon: 'shape' }
}

/** Couleur principale d'un objet (fond, sinon trait), pour la distinguer dans la liste. */
function colorOf(o: Pickable): string | undefined {
  const ok = (v: unknown): v is string => typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v) && v !== 'transparent'
  const ink = (o as InkObject).ink as { color?: string } | undefined
  if (ink?.color && ok(ink.color)) return ink.color
  if (ok(o.fill) && !(typeof o.text === 'string')) return o.fill
  if (ok(o.stroke)) return o.stroke
  return ok(o.fill) ? o.fill : undefined
}

/**
 * Prendre l'objet voulu quand plusieurs se superposent :
 * - les traits et les formes sans fond se touchent sur leur tracé, pas sur leur cadre
 *   (le cadre d'un trait en diagonale recouvrait tout ce qui était dessous) ;
 * - Alt + clic prend l'objet du dessous, puis le suivant… (comme Inkscape) ;
 * - clic droit (ou appui long au doigt) : liste des objets sous le pointeur, survol =
 *   aperçu, plus les commandes usuelles et Verrouiller (l'objet ne se prend plus au clic).
 */
export class Picking {
  private forced: { x: number; y: number; target: FabricObject } | null = null
  private menu: HTMLElement | null = null

  constructor(
    private ed: Editor,
    private tools: ToolManager,
    private run: (action: string) => void
  ) {
    const c = ed.canvas
    // Tolérance de 6 px autour des tracés (le contexte de test au pixel est redimensionné).
    c.setTargetFindTolerance(6)
    c.on('object:added', ({ target }) => this.prepare(target as Pickable))
    // Un objet sélectionné se prend partout dans son cadre (pour le déplacer facilement).
    c.on('selection:created', () => this.refreshHit())
    c.on('selection:updated', () => this.refreshHit())
    c.on('selection:cleared', () => this.refreshHit())

    const find = c.findTarget.bind(c)
    c.findTarget = ((e: TPointerEvent) => {
      const info = find(e)
      // Fabric écoute « mousedown » ou « pointerdown » selon la plateforme : on reconnaît l'appui par sa position.
      const f = this.forced
      const pe = e as MouseEvent
      if (f && /down$/.test(e.type) && Math.abs(pe.clientX - f.x) < 1.5 && Math.abs(pe.clientY - f.y) < 1.5) return { ...info, target: f.target, subTargets: [] }
      return info
    }) as typeof c.findTarget

    const wrapper = c.wrapperEl
    wrapper.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true })
    window.addEventListener('pointerup', () => setTimeout(() => (this.forced = null)))
    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      // Clic droit venu d'un bouton du stylet utilisé pour autre chose (lasso, gomme…) : pas de menu.
      if (performance.now() < penGesture.until) return
      this.openMenu(e.clientX, e.clientY)
    })
    window.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu(true)
    }, { capture: true })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.menu) {
        e.stopPropagation()
        this.closeMenu(true)
      }
    }, { capture: true })
  }

  /** Test au pixel près pour les traits et les formes sans fond. */
  private prepare(o: Pickable): void {
    if (isPageLayer(o)) return
    const thin = !!(o as InkObject).ink || (!!o.shape && (!o.fill || o.fill === 'transparent'))
    if (thin && o !== this.ed.canvas.getActiveObject()) o.perPixelTargetFind = true
    ;(o as Pickable & { __thin?: boolean }).__thin = thin
  }

  private refreshHit(): void {
    const active = new Set(this.ed.canvas.getActiveObjects())
    for (const o of this.ed.canvas.getObjects() as (Pickable & { __thin?: boolean })[]) {
      if (o.__thin) o.perPixelTargetFind = !active.has(o)
    }
  }

  /** Objets sous un point écran, du dessus vers le dessous (verrouillés compris). */
  objectsAt(clientX: number, clientY: number): Pickable[] {
    const c = this.ed.canvas
    const fake = { clientX, clientY, target: c.upperCanvasEl } as unknown as TPointerEvent
    const p = c.getScenePoint(fake)
    const vp = p.transform(c.viewportTransform)
    const out: Pickable[] = []
    const objects = c.getObjects() as Pickable[]
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i]
      if (isPageLayer(o) || !o.visible) continue
      if (!o.containsPoint(p)) continue
      // Trait ou forme sans fond : il faut toucher le tracé (tolérance de quelques pixels).
      if ((o as { __thin?: boolean }).__thin && c.isTargetTransparent(o, vp.x, vp.y)) continue
      out.push(o)
    }
    return out
  }

  /** Alt + clic avec l'outil Sélection : objet suivant sous le pointeur. */
  private onDown(e: PointerEvent): void {
    if (!e.altKey || e.button !== 0 || this.tools.tool !== 'select') return
    const stack = this.objectsAt(e.clientX, e.clientY).filter((o) => !o.locked)
    if (stack.length < 2) return
    const active = this.ed.canvas.getActiveObject()
    const i = active ? stack.indexOf(active as Pickable) : -1
    this.forced = { x: e.clientX, y: e.clientY, target: stack[(i + 1) % stack.length] }
  }

  // --- Menu contextuel -------------------------------------------------------------------

  private previous: FabricObject[] = []

  private openMenu(x: number, y: number): void {
    this.closeMenu(false)
    const c = this.ed.canvas
    const stack = this.objectsAt(x, y)
    // Comme dans Word : un clic droit sur un objet non sélectionné le sélectionne d'abord.
    const top = stack.find((o) => !o.locked)
    if (top && !c.getActiveObjects().includes(top)) {
      c.setActiveObject(top)
      c.requestRenderAll()
    }
    this.previous = c.getActiveObjects()
    const hasSelection = this.previous.length > 0
    const m = document.createElement('div')
    m.className = 'tt-menu ctx-menu'
    m.setAttribute('role', 'menu')
    m.addEventListener('mousedown', (e) => e.preventDefault())

    const item = (iconName: IconName | null, label: string, onClick: () => void, opts: { enabled?: boolean; key?: string; danger?: boolean; hover?: () => void; color?: string } = {}): void => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `tt-item ${opts.danger ? 'danger' : ''}`
      b.setAttribute('role', 'menuitem')
      b.disabled = opts.enabled === false
      b.innerHTML = `<span class="tt-check">${iconName ? icon(iconName, 16) : ''}</span><span class="ctx-label"></span>${opts.color ? `<i class="ctx-color" style="background:${opts.color}"></i>` : ''}${opts.key ? `<kbd>${opts.key}</kbd>` : ''}`
      b.querySelector('.ctx-label')!.textContent = label
      b.addEventListener('click', () => {
        this.closeMenu(false)
        onClick()
      })
      if (opts.hover) b.addEventListener('pointerenter', opts.hover)
      m.append(b)
    }
    const heading = (text: string): void => {
      const h = document.createElement('div')
      h.className = 'tt-heading'
      h.textContent = text
      m.append(h)
    }
    const sep = (): void => void m.append(Object.assign(document.createElement('hr'), { className: 'tt-sep' }))

    if (stack.length) {
      heading(stack.length > 1 ? 'Sélectionner (du dessus vers le dessous)' : 'Sélectionner')
      for (const o of stack.slice(0, 12)) {
        const d = describe(o)
        const select = (): void => {
          if (o.locked) return
          c.setActiveObject(o)
          c.requestRenderAll()
        }
        item(d.icon, o.locked ? `${d.name} (verrouillé)` : d.name, () => {
          select()
          this.previous = c.getActiveObjects()
        }, { hover: select, enabled: !o.locked, color: colorOf(o) })
      }
      sep()
    }
    item('cut', 'Couper', () => this.run('cut'), { enabled: hasSelection, key: 'Ctrl+X' })
    item('copy', 'Copier', () => this.run('copy'), { enabled: hasSelection, key: 'Ctrl+C' })
    item('paste', 'Coller', () => this.run('paste'), { key: 'Ctrl+V' })
    item('duplicate', 'Dupliquer', () => this.run('duplicate'), { enabled: hasSelection, key: 'Ctrl+D' })
    sep()
    item('front', 'Premier plan', () => this.run('front'), { enabled: hasSelection, key: 'Ctrl+Maj+]' })
    item('back', 'Arrière-plan', () => this.run('back'), { enabled: hasSelection, key: 'Ctrl+Maj+[' })
    item('group', 'Grouper', () => this.run('group'), { enabled: this.previous.length > 1, key: 'Ctrl+G' })
    item('ungroup', 'Dégrouper', () => this.run('ungroup'), { enabled: this.previous.length === 1 && this.previous[0] instanceof Group && !(this.previous[0] instanceof ActiveSelection), key: 'Ctrl+Maj+G' })
    const locked = stack.find((o) => o.locked)
    if (hasSelection) item('lock', 'Verrouiller (ne plus le prendre au clic)', () => this.setLocked(this.previous as Pickable[], true))
    if (locked) item('unlock', `Déverrouiller : ${describe(locked).name}`, () => this.setLocked([locked], false))
    sep()
    item('delete', 'Supprimer', () => this.run('delete'), { enabled: hasSelection, key: 'Suppr', danger: true })

    document.body.append(m)
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`
    m.style.top = `${Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8))}px`
    this.menu = m
  }

  /** Ferme le menu ; `restore` : rétablit la sélection d'avant l'aperçu au survol. */
  private closeMenu(restore: boolean): void {
    if (!this.menu) return
    this.menu.remove()
    this.menu = null
    if (!restore) return
    const c = this.ed.canvas
    const prev = this.previous.filter((o) => c.getObjects().includes(o))
    c.discardActiveObject()
    if (prev.length === 1) c.setActiveObject(prev[0])
    else if (prev.length > 1) c.setActiveObject(new ActiveSelection(prev, { canvas: c }))
    c.requestRenderAll()
  }

  /** Verrouiller : l'objet reste visible et s'exporte, mais ne se prend plus au clic. */
  setLocked(objs: Pickable[], locked: boolean): void {
    const c = this.ed.canvas
    c.discardActiveObject()
    for (const o of objs) {
      o.set({ locked: locked || undefined, selectable: !locked, evented: !locked, hoverCursor: locked ? 'default' : null } as never)
      this.ed.history.touch(o)
    }
    if (!locked && objs.length === 1) c.setActiveObject(objs[0])
    this.ed.history.record()
    c.requestRenderAll()
    this.ed.notify(locked ? 'Objet verrouillé : clic droit dessus › Déverrouiller pour le reprendre.' : 'Objet déverrouillé', 'info')
  }
}
