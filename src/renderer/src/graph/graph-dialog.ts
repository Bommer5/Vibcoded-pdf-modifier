import { enterSubmitsPrimary } from '../ui/dialog-keys'
import { applyText, crossings, layout, newId, nextLabel, renderGraph, toText, UNIT, type GraphSpec } from './graph'

/**
 * Fenêtre d'un graphe : on dessine directement dans l'aperçu.
 * - clic dans le vide : un nœud (nommé A, B, C… — renommez-le à droite ou par double-clic) ;
 * - clic sur un nœud puis sur un autre : une arête entre les deux (le poids se saisit à droite) ;
 * - glisser un nœud : le déplacer ; clic sur une arête : la choisir (poids, suppression) ;
 * - Suppr : effacer ce qui est choisi ; « Organiser » : moins de croisements possible ;
 * - saisie rapide : une arête par ligne (« A - B 4 », « Paris -> Lyon : 465 »).
 */
export function editGraph(initial: GraphSpec): Promise<GraphSpec | null> {
  const g: GraphSpec = structuredClone(initial)
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog graph-dialog'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Graphe</h2>
      <div class="graph-layout">
        <div class="graph-stage" tabindex="0" aria-label="Graphe : cliquez pour ajouter des nœuds et des arêtes"></div>
        <div class="graph-side">
          <p class="muted small graph-help">Clic dans le vide : <b>nœud</b>. Clic sur un nœud puis un autre : <b>arête</b>. Glisser : déplacer. Double-clic : renommer. <kbd>Suppr</kbd> : effacer.</p>
          <div class="graph-sel"></div>
          <div class="row">
            <label class="check"><input type="checkbox" name="directed" /> Orienté (flèches)</label>
            <label class="check"><input type="checkbox" name="weighted" /> Poids</label>
          </div>
          <label>Taille des nœuds <input type="range" name="size" min="22" max="60" /></label>
          <label>Couleur <input type="color" name="color" /></label>
          <button type="button" class="primary graph-layout-btn">Organiser (moins de croisements)</button>
          <p class="small graph-cross"></p>
          <details class="graph-quick">
            <summary>Saisie rapide</summary>
            <p class="muted small">Une arête par ligne : <code>A - B 4</code>, <code>A -> B</code>, <code>Paris - Lyon : 465</code>. Un nom seul : nœud isolé.</p>
            <textarea name="quick" rows="7" spellcheck="false"></textarea>
            <button type="button" class="graph-apply">Appliquer</button>
          </details>
        </div>
      </div>
      <menu>
        <button value="cancel" formnovalidate>Annuler</button>
        <button value="ok" class="primary">Valider</button>
      </menu>
    </form>`
  const $ = <T extends Element>(sel: string): T => dialog.querySelector(sel) as T
  const stage = $<HTMLElement>('.graph-stage')
  const selBox = $<HTMLElement>('.graph-sel')
  const directed = $<HTMLInputElement>('[name=directed]')
  const weighted = $<HTMLInputElement>('[name=weighted]')
  const size = $<HTMLInputElement>('[name=size]')
  const color = $<HTMLInputElement>('[name=color]')
  const quick = $<HTMLTextAreaElement>('[name=quick]')
  directed.checked = g.directed
  weighted.checked = g.weighted
  size.value = String(g.nodeSize)
  color.value = g.color
  quick.value = toText(g)

  /** Ce qui est choisi : un nœud (id) ou une arête (« e<rang> ») ; `pending` : premier nœud d'une arête. */
  let selected: string | null = null
  let pending: string | null = null
  let view = renderGraph(g)

  const render = (): void => {
    view = renderGraph(g, { selected, pending })
    stage.innerHTML = view.svg
    const svg = stage.querySelector('svg')!
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', '100%')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    $<HTMLElement>('.graph-cross').textContent = g.nodes.length ? `${g.nodes.length} nœud${g.nodes.length > 1 ? 's' : ''}, ${g.edges.length} arête${g.edges.length > 1 ? 's' : ''} — ${plural(crossings(g), 'croisement')}` : 'Cliquez dans le cadre pour ajouter un premier nœud.'
    renderSelection()
  }
  const plural = (n: number, w: string): string => `${n} ${w}${n > 1 ? 's' : ''}`
  const syncQuick = (): void => {
    quick.value = toText(g)
  }

  const renderSelection = (): void => {
    selBox.replaceChildren()
    const node = g.nodes.find((n) => n.id === selected)
    const edgeIndex = selected?.startsWith('e') ? Number(selected.slice(1)) : -1
    const edge = edgeIndex >= 0 ? g.edges[edgeIndex] : undefined
    if (!node && !edge) return
    const field = (label: string, value: string, set: (v: string) => void, focus: boolean): HTMLInputElement => {
      const l = document.createElement('label')
      l.textContent = label
      const input = document.createElement('input')
      input.value = value
      input.addEventListener('input', () => {
        set(input.value)
        view = renderGraph(g, { selected, pending })
        stage.innerHTML = view.svg
        const svg = stage.querySelector('svg')!
        svg.setAttribute('width', '100%')
        svg.setAttribute('height', '100%')
        syncQuick()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          stage.focus()
        }
      })
      l.append(input)
      selBox.append(l)
      if (focus) requestAnimationFrame(() => input.select())
      return input
    }
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'danger'
    del.textContent = node ? 'Supprimer ce nœud' : 'Supprimer cette arête'
    del.addEventListener('click', () => removeSelected())
    if (node) field('Nom du nœud', node.label, (v) => (node.label = v || '?'), focusNext)
    if (edge) {
      const names = new Map(g.nodes.map((n) => [n.id, n.label]))
      const p = document.createElement('p')
      p.className = 'small'
      p.textContent = `Arête ${names.get(edge.from)} ${g.directed ? '→' : '—'} ${names.get(edge.to)}`
      selBox.append(p)
      field('Poids', edge.weight ?? '', (v) => {
        edge.weight = v
        if (v) {
          g.weighted = true
          weighted.checked = true
        }
      }, focusNext)
      if (g.directed) {
        const flip = document.createElement('button')
        flip.type = 'button'
        flip.textContent = 'Inverser le sens'
        flip.addEventListener('click', () => {
          ;[edge.from, edge.to] = [edge.to, edge.from]
          syncQuick()
          render()
        })
        selBox.append(flip)
      }
    }
    selBox.append(del)
    focusNext = false
  }
  let focusNext = false

  const removeSelected = (): void => {
    if (!selected) return
    if (selected.startsWith('e')) g.edges.splice(Number(selected.slice(1)), 1)
    else {
      const id = selected
      g.nodes = g.nodes.filter((n) => n.id !== id)
      g.edges = g.edges.filter((e) => e.from !== id && e.to !== id)
    }
    selected = pending = null
    syncQuick()
    render()
  }

  // Coordonnées : écran → unités du graphe
  const toUnits = (e: PointerEvent): { x: number; y: number } => {
    const svg = stage.querySelector('svg')!
    const m = svg.getScreenCTM()!.inverse()
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
    return { x: (p.x - view.ox) / UNIT, y: (p.y - view.oy) / UNIT }
  }

  let drag: { id: string; moved: boolean; x0: number; y0: number; pid: number } | null = null
  stage.addEventListener('pointerdown', (e) => {
    const t = e.target as Element
    const nodeId = t.closest('[data-node]')?.getAttribute('data-node')
    const edgeAttr = t.closest('[data-edge]')?.getAttribute('data-edge')
    stage.focus()
    if (nodeId) {
      drag = { id: nodeId, moved: false, x0: e.clientX, y0: e.clientY, pid: e.pointerId }
      stage.setPointerCapture(e.pointerId)
      return
    }
    if (edgeAttr !== null && edgeAttr !== undefined) {
      selected = `e${edgeAttr}`
      pending = null
      focusNext = true
      render()
      return
    }
    // Vide : désélectionner, ou ajouter un nœud
    if (selected || pending) {
      selected = pending = null
      render()
      return
    }
    const u = toUnits(e)
    const n = { id: newId(), label: nextLabel(g), x: u.x, y: u.y }
    g.nodes.push(n)
    selected = n.id
    pending = n.id
    syncQuick()
    render()
  })
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return
    drag.moved = true
    const n = g.nodes.find((x) => x.id === drag!.id)
    if (!n) return
    const u = toUnits(e)
    n.x = u.x
    n.y = u.y
    render()
  })
  stage.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pid) return
    const { id, moved } = drag
    drag = null
    if (moved) return
    // Clic sur un nœud : premier bout d'arête, ou arête vers le nœud choisi avant
    if (pending && pending !== id) {
      const exists = g.edges.findIndex((x) => (x.from === pending && x.to === id) || (!g.directed && x.from === id && x.to === pending))
      if (exists < 0) g.edges.push({ from: pending, to: id, weight: g.weighted ? '' : undefined })
      const idx = exists < 0 ? g.edges.length - 1 : exists
      selected = `e${idx}`
      pending = null
      focusNext = g.weighted
    } else {
      selected = id
      pending = id
    }
    syncQuick()
    render()
  })
  stage.addEventListener('dblclick', (e) => {
    const nodeId = (e.target as Element).closest('[data-node]')?.getAttribute('data-node')
    if (!nodeId) return
    selected = nodeId
    pending = null
    focusNext = true
    render()
  })
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeSelected()
    } else if (e.key === 'Escape' && (selected || pending)) {
      e.preventDefault()
      e.stopPropagation()
      selected = pending = null
      render()
    }
  })

  directed.addEventListener('change', () => {
    g.directed = directed.checked
    syncQuick()
    render()
  })
  weighted.addEventListener('change', () => {
    g.weighted = weighted.checked
    render()
  })
  size.addEventListener('input', () => {
    g.nodeSize = Number(size.value)
    render()
  })
  color.addEventListener('input', () => {
    g.color = color.value
    render()
  })
  $('.graph-layout-btn').addEventListener('click', () => {
    layout(g)
    render()
  })
  $('.graph-apply').addEventListener('click', () => {
    // Remplace les arêtes par la saisie ; les nœuds gardent leur place, les nouveaux sont rangés.
    const before = new Set(g.nodes.map((n) => n.label))
    const keep = new Map(g.nodes.map((n) => [n.label, n]))
    g.edges = []
    g.nodes = []
    g.directed = false
    applyText(g, quick.value)
    const remap = new Map<string, string>()
    for (const n of g.nodes) {
      const old = keep.get(n.label)
      if (old) {
        remap.set(n.id, old.id)
        n.x = old.x
        n.y = old.y
        n.id = old.id
      }
    }
    // Les arêtes pointent vers les identifiants repris
    for (const e of g.edges) {
      e.from = remap.get(e.from) ?? e.from
      e.to = remap.get(e.to) ?? e.to
    }
    if (g.nodes.some((n) => !before.has(n.label))) layout(g)
    directed.checked = g.directed
    weighted.checked = g.weighted
    selected = pending = null
    render()
  })

  document.body.append(dialog)
  enterSubmitsPrimary(dialog)
  dialog.showModal()
  render()
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(dialog.returnValue === 'ok' && g.nodes.length ? g : null)
    })
  })
}
