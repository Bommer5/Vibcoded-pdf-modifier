import { prettyCombo, type ActionId, type ShortcutManager } from '../core/shortcuts'

export interface MenuItem {
  label: string
  action: string
  /** Raccourci affiché (lu dans le gestionnaire de raccourcis). */
  shortcut?: ActionId
  hint?: string
}

export type MenuEntry = MenuItem | '-' | (() => (MenuItem | '-')[])

export interface Menu {
  label: string
  items: MenuEntry[]
}

/**
 * Barre de menus façon application de bureau : clic pour ouvrir, survol pour
 * passer d'un menu à l'autre, flèches + Entrée au clavier, Échap pour fermer.
 */
export class MenuBar {
  private openIndex = -1
  private buttons: HTMLButtonElement[] = []
  private panels: HTMLElement[] = []

  constructor(
    private host: HTMLElement,
    private menus: Menu[],
    private run: (action: string) => void,
    private shortcuts: ShortcutManager,
    private isEnabled: (action: string) => boolean = () => true
  ) {
    host.setAttribute('role', 'menubar')
    menus.forEach((menu, i) => this.build(menu, i))
    document.addEventListener('pointerdown', (e) => {
      if (!host.contains(e.target as Node)) this.close()
    })
    window.addEventListener('keydown', (e) => {
      if (this.openIndex < 0) return
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        this.open((this.openIndex + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length, true)
      }
    })
    window.addEventListener('blur', () => this.close())
  }

  private build(menu: Menu, index: number): void {
    const wrap = document.createElement('div')
    wrap.className = 'menu'
    const button = document.createElement('button')
    button.className = 'menu-button'
    button.textContent = menu.label
    button.setAttribute('aria-haspopup', 'true')
    button.addEventListener('click', () => (this.openIndex === index ? this.close() : this.open(index)))
    button.addEventListener('pointerenter', () => this.openIndex >= 0 && this.openIndex !== index && this.open(index))

    const panel = document.createElement('div')
    panel.className = 'menu-panel'
    panel.setAttribute('role', 'menu')
    panel.hidden = true
    panel.addEventListener('keydown', (e) => this.onPanelKey(e, panel))
    wrap.append(button, panel)
    this.host.append(wrap)
    this.buttons.push(button)
    this.panels.push(panel)
  }

  private fill(menu: Menu, panel: HTMLElement): void {
    panel.replaceChildren()
    // Entrées dynamiques (ex. fichiers récents) : calculées à l'ouverture du menu.
    for (const entry of menu.items.flatMap((e) => (typeof e === 'function' ? e() : [e]))) {
      if (entry === '-') {
        panel.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
        continue
      }
      const item = document.createElement('button')
      item.className = 'menu-item'
      item.setAttribute('role', 'menuitem')
      item.disabled = !this.isEnabled(entry.action)
      const combo = entry.shortcut ? this.shortcuts.get(entry.shortcut)?.[0] : undefined
      item.innerHTML = `<span></span><kbd>${combo ? prettyCombo(combo) : ''}</kbd>`
      item.firstElementChild!.textContent = entry.label
      if (entry.hint) item.title = entry.hint
      item.addEventListener('click', () => {
        this.close()
        this.run(entry.action)
      })
      panel.append(item)
    }
  }

  private open(index: number, focusFirst = false): void {
    this.close()
    this.openIndex = index
    const panel = this.panels[index]
    this.fill(this.menus[index], panel)
    panel.hidden = false
    this.buttons[index].classList.add('open')
    if (focusFirst) panel.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus()
  }

  close(): void {
    if (this.openIndex < 0) return
    this.panels[this.openIndex].hidden = true
    this.buttons[this.openIndex].classList.remove('open')
    this.openIndex = -1
  }

  private onPanelKey(e: KeyboardEvent, panel: HTMLElement): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...panel.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
}
