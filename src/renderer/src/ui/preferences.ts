import { comboFromEvent, prettyCombo, type ActionId, type ShortcutManager } from '../core/shortcuts'
import { PAPER_STYLES } from '../core/paper'
import { settings } from '../tools/settings'

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
        <label class="check"><input type="checkbox" name="pressure" /> Stylo sensible à la pression</label>
        <label class="check"><input type="checkbox" name="snap" /> Surligneur aimanté au texte des PDF</label>
        <label class="check"><input type="checkbox" name="shapes" /> Formes parfaites en tenant le stylet immobile</label>
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
  bind('snap', 'highlightSnap')
  bind('shapes', 'shapeRecognition')

  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}
