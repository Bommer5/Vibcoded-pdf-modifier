import { comboFromEvent, prettyCombo, type ActionId, type ShortcutManager } from '../core/shortcuts'
import { PAPER_STYLES } from '../core/paper'
import { precise } from '../hwr/engine'
import { settings, type PenButtonAction } from '../tools/settings'

export type Theme = 'system' | 'dark' | 'light'
const THEME_KEY = 'feuillet.theme'

export function applyTheme(theme: Theme = (localStorage.getItem(THEME_KEY) as Theme) || 'system'): void {
  document.documentElement.dataset.theme = theme
}

/** Libellés des actions modifiables dans les préférences (dans l'ordre d'affichage). */
const LABELS: [ActionId, string][] = [
  ['zoomIn', 'Zoom avant (sur le pointeur)'],
  ['zoomOut', 'Zoom arrière (sur le pointeur)'],
  ['zoomReset', 'Ajuster à la page'],
  ['zoomWidth', 'Ajuster à la largeur'],
  ['undo', 'Annuler'],
  ['redo', 'Rétablir'],
  ['tool.select', 'Outil Sélection'],
  ['tool.lasso', 'Outil Lasso'],
  ['tool.pen', 'Outil Stylo'],
  ['tool.highlighter', 'Outil Surligneur'],
  ['tool.eraser', 'Outil Gomme'],
  ['tool.shape', 'Outil Formes'],
  ['tool.text', 'Outil Texte'],
  ['tool.textselect', 'Sélection du texte du PDF'],
  ['tool.edittext', 'Modifier le texte du PDF'],
  ['tool.hand', 'Outil Main'],
  ['find', 'Rechercher'],
  ['goto', 'Aller à la page'],
  ['save', 'Enregistrer'],
  ['export', 'Exporter'],
  ['print', 'Imprimer']
]

/**
 * Préférences : touches de chaque action (dont le zoom), thème, papier par défaut,
 * comportement du stylet. Tout est enregistré sur l'appareil.
 */
export function openPreferences(shortcuts: ShortcutManager): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog prefs'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Préférences</h2>
      <div class="prefs-tabs" role="tablist">
        <button type="button" data-tab="keys" class="active">Raccourcis</button>
        <button type="button" data-tab="general">Général</button>
        <button type="button" data-tab="pen">Stylet et tablette</button>
      </div>
      <section data-panel="keys">
        <p class="muted small">Cliquez sur « Modifier », puis appuyez sur la touche (ou combinaison) voulue. Échap annule.</p>
        <div class="keys-list"></div>
        <button type="button" data-do="reset-keys">Rétablir les raccourcis par défaut</button>
      </section>
      <section data-panel="general" hidden>
        <label>Thème
          <select name="theme"><option value="system">Comme le système</option><option value="dark">Sombre</option><option value="light">Clair</option></select>
        </label>
        <label>Papier des nouvelles pages
          <select name="paper">${PAPER_STYLES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select>
        </label>
        <label class="check"><input type="checkbox" name="snap" /> Surligneur aimanté au texte des PDF</label>
        <label class="check"><input type="checkbox" name="shapes" /> Formes parfaites en tenant le stylet immobile</label>
      </section>
      <section data-panel="pen" hidden>
        <label>Curseur pour écrire
          <select name="cursor">
            <option value="dot">Point plein (taille et couleur du trait)</option>
            <option value="ring">Cercle (taille et couleur du trait)</option>
            <option value="cross">Croix fine</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" name="pressure" /> Trait plus épais quand on appuie plus fort (pression)</label>
        <label>Effet de la pression <input type="range" name="pressureStrength" min="0.2" max="0.9" step="0.05" /></label>
        <label class="check"><input type="checkbox" name="pressureSim" /> Si le stylet n'envoie pas de pression : épaisseur selon la vitesse</label>
        <div class="pressure-test" tabindex="0">
          <canvas width="440" height="90"></canvas>
          <div class="pressure-info"><span class="pressure-meter"><i></i></span><span class="pressure-text">Écrivez ici pour tester la pression.</span></div>
        </div>
        <h3 class="prefs-sub">Écriture → texte</h3>
        <label class="check"><input type="checkbox" name="hwr" /> Convertir ce que j'écris au stylo en texte (lettres, chiffres, symboles de maths ; les traits et dessins restent)</label>
        <label>Pause avant la conversion
          <select name="hwrDelay"><option value="700">Courte (0,7 s)</option><option value="1200">Normale (1,2 s)</option><option value="2000">Longue (2 s)</option><option value="3500">Très longue (3,5 s)</option></select>
        </label>
        <div class="hwr-engine" hidden>
          <p class="small"><b>Moteur de lecture précis</b> — TrOCR (Microsoft, open source), entraîné sur de vraies écritures. Environ 60 Mo à télécharger une seule fois, puis tout se fait hors ligne sur ce PC.</p>
          <div class="row"><button type="button" class="primary hwr-get">Télécharger le moteur précis</button><span class="small hwr-state"></span></div>
          <progress class="hwr-progress" max="1" value="0" hidden></progress>
        </div>
        <h3 class="prefs-sub">Boutons du stylet</h3>
        <p class="muted small">La pointe écrit avec l'outil choisi. Chaque bouton agit tant qu'il est maintenu pendant le geste.</p>
        <div class="pen-map">
          <span class="pen-name"><b>Bouton 1</b><small>le plus près de la pointe (clic droit)</small></span><select name="penButton1"></select>
          <span class="pen-name"><b>Bouton 2</b><small>le plus haut (clic du milieu)</small></span><select name="penButton2"></select>
          <span class="pen-name"><b>Bout gomme</b><small>stylet retourné</small></span><select name="penEraserEnd"></select>
        </div>
        <div class="pen-test" tabindex="0">Essayez ici : posez le stylet en tenant un bouton, ou retournez-le.</div>
        <h3 class="prefs-sub">Boutons de la tablette (ExpressKeys, molette…)</h3>
        <p class="muted small">Ils se règlent dans le pilote de la tablette (Wacom, XP-Pen, Huion…) : faites-leur envoyer une de ces touches.</p>
        <div class="pad-keys"></div>
      </section>
      <menu><button value="ok" class="primary">Fermer</button></menu>
    </form>`
  document.body.append(dialog)
  const $ = <T extends Element>(sel: string): T => dialog.querySelector(sel) as T

  // Onglets
  dialog.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      dialog.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab))
      dialog.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab))
    })
  )

  // Raccourcis
  const list = $<HTMLElement>('.keys-list')
  const render = (): void => {
    list.replaceChildren()
    for (const [id, label] of LABELS) {
      const row = document.createElement('div')
      row.className = 'key-row'
      const name = document.createElement('span')
      name.textContent = label
      const keys = document.createElement('span')
      keys.className = 'key-combos'
      for (const combo of shortcuts.get(id)) {
        const k = document.createElement('kbd')
        k.textContent = prettyCombo(combo)
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'key-del'
        del.textContent = '×'
        del.title = 'Retirer ce raccourci'
        del.addEventListener('click', () => {
          shortcuts.set(id, shortcuts.get(id).filter((c) => c !== combo))
          render()
        })
        k.append(del)
        keys.append(k)
      }
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.textContent = 'Modifier'
      edit.addEventListener('click', () => {
        edit.textContent = 'Appuyez sur une touche…'
        edit.classList.add('listening')
        const onKey = (e: KeyboardEvent): void => {
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
          e.preventDefault()
          e.stopPropagation()
          window.removeEventListener('keydown', onKey, true)
          if (e.key !== 'Escape') {
            const combo = comboFromEvent(e)
            // Une combinaison ne déclenche qu'une seule action : on la retire des autres.
            for (const [other] of LABELS) if (other !== id) shortcuts.set(other, shortcuts.get(other).filter((c) => c !== combo))
            shortcuts.set(id, [combo, ...shortcuts.get(id).filter((c) => c !== combo)])
          }
          render()
        }
        window.addEventListener('keydown', onKey, true)
      })
      row.append(name, keys, edit)
      list.append(row)
    }
  }
  render()
  $<HTMLButtonElement>('[data-do=reset-keys]').addEventListener('click', () => {
    shortcuts.reset()
    render()
  })

  // Général
  const theme = $<HTMLSelectElement>('[name=theme]')
  theme.value = localStorage.getItem(THEME_KEY) || 'system'
  theme.addEventListener('change', () => {
    localStorage.setItem(THEME_KEY, theme.value)
    applyTheme(theme.value as Theme)
  })
  const paper = $<HTMLSelectElement>('[name=paper]')
  paper.value = settings.value.paper
  paper.addEventListener('change', () => settings.set('paper', paper.value as never))
  const bind = (name: string, key: 'pressure' | 'highlightSnap' | 'shapeRecognition'): void => {
    const box = $<HTMLInputElement>(`[name=${name}]`)
    box.checked = settings.value[key]
    box.addEventListener('change', () => settings.set(key, box.checked))
  }
  bind('pressure', 'pressure')
  const strength = $<HTMLInputElement>('[name=pressureStrength]')
  strength.value = String(settings.value.pressureStrength)
  strength.addEventListener('input', () => settings.set('pressureStrength', Number(strength.value)))
  const sim = $<HTMLInputElement>('[name=pressureSim]')
  sim.checked = settings.value.pressureSim
  sim.addEventListener('change', () => settings.set('pressureSim', sim.checked))
  pressureTest($<HTMLElement>('.pressure-test'))

  // Stylet et tablette
  const hwrBox = $<HTMLInputElement>('[name=hwr]')
  hwrBox.checked = settings.value.handwriting
  hwrBox.addEventListener('change', () => settings.set('handwriting', hwrBox.checked))
  // Moteur précis (PC) : état et téléchargement
  const engineBox = $<HTMLElement>('.hwr-engine')
  if (precise.available) {
    engineBox.hidden = false
    const state = $<HTMLElement>('.hwr-state')
    const get = $<HTMLButtonElement>('.hwr-get')
    const bar = $<HTMLProgressElement>('.hwr-progress')
    const show = (ok: boolean): void => {
      get.hidden = ok
      state.textContent = ok ? '✓ Installé : utilisé pour convertir l’écriture.' : 'Non installé : un modèle plus simple est utilisé, beaucoup moins fiable.'
    }
    void precise.installed().then(show)
    get.addEventListener('click', async () => {
      get.disabled = true
      bar.hidden = false
      state.textContent = 'Téléchargement…'
      try {
        const ok = await precise.download((f) => {
          bar.value = f
          state.textContent = `Téléchargement… ${Math.round(f * 100)} %`
        })
        show(ok)
        if (!ok) state.textContent = 'Le moteur n’a pas pu démarrer.'
      } catch (e) {
        state.textContent = `Échec : ${(e as Error).message}. Vérifiez la connexion et réessayez.`
      } finally {
        get.disabled = false
        bar.hidden = true
      }
    })
  }
  const hwrDelay = $<HTMLSelectElement>('[name=hwrDelay]')
  hwrDelay.value = String(settings.value.handwritingDelay)
  hwrDelay.addEventListener('change', () => settings.set('handwritingDelay', Number(hwrDelay.value)))
  const cursor = $<HTMLSelectElement>('[name=cursor]')
  cursor.value = settings.value.cursor
  cursor.addEventListener('change', () => settings.set('cursor', cursor.value as never))
  const ACTIONS: [PenButtonAction, string][] = [
    ['lasso', 'Lasso (entourer pour sélectionner)'],
    ['eraser', 'Gomme'],
    ['hand', 'Déplacer la vue'],
    ['menu', 'Menu (clic droit)'],
    ['none', 'Rien']
  ]
  const label = (a: PenButtonAction): string => ACTIONS.find(([k]) => k === a)?.[1] ?? a
  for (const key of ['penButton1', 'penButton2', 'penEraserEnd'] as const) {
    const sel = $<HTMLSelectElement>(`[name=${key}]`)
    sel.innerHTML = ACTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')
    sel.value = settings.value[key]
    sel.addEventListener('change', () => settings.set(key, sel.value as PenButtonAction))
  }
  // Zone d'essai : montre quel bouton est reconnu et ce qu'il fait.
  const pad = $<HTMLElement>('.pen-test')
  pad.addEventListener('contextmenu', (e) => e.preventDefault())
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const b = e.buttons
    const v = settings.value
    const [name, action] =
      e.button === 5 || b & 32 ? ['Bout gomme', v.penEraserEnd]
        : b & 2 ? ['Bouton 1', v.penButton1]
          : b & 4 ? ['Bouton 2', v.penButton2]
            : [e.pointerType === 'pen' ? 'Pointe' : e.pointerType === 'touch' ? 'Doigt' : 'Souris', null]
    pad.textContent = action ? `${name} → ${label(action as PenButtonAction)}` : `${name} → écrit avec l'outil choisi`
    pad.classList.add('hit')
    setTimeout(() => pad.classList.remove('hit'), 400)
  })
  // Touches utiles à mettre sur les boutons de la tablette (raccourcis actuels).
  const PAD: [ActionId, string][] = [
    ['tool.eraser', 'Stylo ↔ gomme'],
    ['undo', 'Annuler'],
    ['redo', 'Rétablir'],
    ['tool.pen', 'Stylo'],
    ['tool.highlighter', 'Surligneur'],
    ['tool.select', 'Sélection'],
    ['tool.hand', 'Main (déplacer la vue)'],
    ['zoomIn', 'Zoom avant'],
    ['zoomOut', 'Zoom arrière'],
    ['zoomReset', 'Page entière']
  ]
  const keys = $<HTMLElement>('.pad-keys')
  const pads = PAD.map(([id, l]) => `<span>${l}</span><span>${shortcuts.get(id).map((c) => `<kbd>${prettyCombo(c)}</kbd>`).join(' ') || '—'}</span>`)
  keys.innerHTML = pads.join('') + '<span>Taille du trait</span><span><kbd>[</kbd> <kbd>]</kbd></span><span>Défiler / zoomer</span><span>Molette, Ctrl + molette</span>'
  bind('snap', 'highlightSnap')
  bind('shapes', 'shapeRecognition')

  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}

/**
 * Zone d'essai de la pression : trace avec la vraie épaisseur et dit ce que l'appareil envoie.
 * Si la tablette arrive comme une souris, la pression n'existe pas pour l'application : on
 * explique quoi régler (Windows Ink, session Linux…).
 */
function pressureTest(box: HTMLElement): void {
  const canvas = box.querySelector('canvas')!
  const meter = box.querySelector<HTMLElement>('.pressure-meter i')!
  const text = box.querySelector<HTMLElement>('.pressure-text')!
  const ctx = canvas.getContext('2d')!
  let last: { x: number; y: number; w: number } | null = null
  let lo = 1, hi = 0
  let kind = ''
  let down = -1
  const at = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height }
  }
  const draw = (e: PointerEvent): void => {
    const p = e.pointerType === 'pen' ? e.pressure : 0.5
    lo = Math.min(lo, p)
    hi = Math.max(hi, p)
    meter.style.width = `${Math.round(p * 100)}%`
    const v = settings.value
    const w = Math.max(0.6, 5 * (v.pressure && e.pointerType === 'pen' ? 1 - v.pressureStrength * (1 - p * 1.6) : 1))
    const q = at(e)
    ctx.strokeStyle = getComputedStyle(box).color
    ctx.lineCap = 'round'
    if (last) {
      ctx.lineWidth = (last.w + w) / 2
      ctx.beginPath()
      ctx.moveTo(last.x, last.y)
      ctx.lineTo(q.x, q.y)
      ctx.stroke()
    }
    last = { ...q, w }
    text.textContent = kind === 'pen' ? `Stylet · pression ${Math.round(p * 100)} %` : kind === 'touch' ? 'Doigt : pas de pression' : 'Souris : pas de pression'
  }
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try {
      box.setPointerCapture(e.pointerId)
    } catch {
      // pointeur déjà relâché : sans importance
    }
    down = e.pointerId
    kind = e.pointerType
    lo = 1
    hi = 0
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    last = null
    draw(e)
  })
  box.addEventListener('pointermove', (e) => {
    if (e.pointerId !== down) return
    const evs = e.getCoalescedEvents?.() ?? []
    for (const ev of evs.length ? evs : [e]) draw(ev)
  })
  box.addEventListener('pointerup', (e) => {
    if (e.pointerId !== down) return
    down = -1
    last = null
    if (kind === 'pen') {
      text.textContent = hi - lo > 0.04
        ? `Pression reçue (de ${Math.round(lo * 100)} à ${Math.round(hi * 100)} %).`
        : 'Le stylet est reconnu mais n’envoie pas de pression : vérifiez le pilote de la tablette (pression activée, « Windows Ink » sous Windows).'
    } else if (kind === 'mouse') {
      text.textContent = /Windows/.test(navigator.userAgent)
        ? 'Votre stylet arrive comme une souris : activez « Windows Ink » dans le pilote de la tablette (Wacom, Huion, XP-Pen…), puis relancez Feuillet.'
        : 'Votre stylet arrive comme une souris : sous Linux, essayez l’autre type de session (Wayland ou X11) ou le pilote du fabricant. En attendant, l’épaisseur suit la vitesse.'
    }
  })
}
