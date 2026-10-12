import type { FabricObject } from 'fabric'
import type { Editor } from '../core/editor'
import {
  applyStyle, clearFormatting, stepSize, styleValue, toggleBold, toggleItalic, toggleScript,
  toggleStrike, toggleUnderline, WORD_SIZES, type TextObj
} from '../text/format'
import {
  backspaceInList, BULLETS, changeLevel, currentItem, enterInList, marker, NUMBERINGS, setList, toggleList,
  type Bullet, type Numbering
} from '../text/lists'
import { FONTS } from './properties'

const COLORS = ['#000000', '#404040', '#7f7f7f', '#c00000', '#ff0000', '#ffc000', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0', '#ffffff']
const HIGHLIGHTS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff9900', '#d9d9d9']
const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3]
const PARA_SPACINGS = [0, 3, 6, 12, 18, 24]

/** Icônes 16×16 au trait (comme celles de Word), dessinées en SVG pour rester nettes à tout zoom. */
const icon = (body: string): string =>
  `<svg class="tt-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${body}</svg>`
const lines = (rows: [number, number][]): string => rows.map(([x1, x2], i) => `<path d="M${x1} ${3 + i * 3.4}H${x2}"/>`).join('')
const ICONS = {
  left: icon(lines([[2, 14], [2, 10], [2, 14], [2, 10]])),
  center: icon(lines([[2, 14], [4, 12], [2, 14], [4, 12]])),
  right: icon(lines([[2, 14], [6, 14], [2, 14], [6, 14]])),
  justify: icon(lines([[2, 14], [2, 14], [2, 14], [2, 10]])),
  bullets: icon('<circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M6 4H14M6 8H14M6 12H14"/>'),
  numbers: icon('<text x="0.5" y="6" font-size="5.5" fill="currentColor" stroke="none" font-family="sans-serif">1</text><text x="0.5" y="13.5" font-size="5.5" fill="currentColor" stroke="none" font-family="sans-serif">2</text><path d="M6 4H14M6 8H14M6 12H14"/>'),
  spacing: icon('<path d="M7 4H14M7 8H14M7 12H14"/><path d="M3 2.5V13.5M1.5 4L3 2.5L4.5 4M1.5 12L3 13.5L4.5 12" stroke-width="1.2"/>')
}

const isText = (o: FabricObject | undefined): o is TextObj => !!o && 'text' in o && typeof (o as TextObj).enterEditing === 'function'
type Para = TextObj & { paragraphSpacing?: number; contour?: unknown }

/**
 * Barre de mise en forme du texte façon Word, au-dessus de la page dès qu'un texte est
 * sélectionné ou en cours d'écriture. Trois groupes, comme l'onglet Accueil de Word :
 * Police · Caractères · Paragraphe. Les variantes (styles de puces, numérotation,
 * interligne, espacement, couleurs) sont rangées dans des menus ▾, jamais à côté.
 *
 * Raccourcis de Word pendant l'écriture : Ctrl+B/I/U, Ctrl+L/E/R/J, Ctrl+Maj+> / <,
 * Ctrl+= (indice), Ctrl+Maj++ (exposant), Ctrl+Maj+L (puces), Ctrl+Espace (effacer),
 * Tab / Maj+Tab (niveau de liste), Entrée (élément suivant), Entrée sur un élément vide (fin).
 */
export class TextToolbar {
  private root = document.createElement('div')
  private lastBullet: Bullet = '•'
  private lastNumber: Numbering = '1.'
  private menu: HTMLElement | null = null
  private menuFor: HTMLElement | null = null

  constructor(private ed: Editor) {
    this.root.className = 'text-toolbar'
    this.root.hidden = true
    this.root.setAttribute('role', 'toolbar')
    this.root.setAttribute('aria-label', 'Mise en forme du texte')
    // Garder la sélection de texte quand on clique sur la barre.
    this.root.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).matches('input, select')) e.preventDefault()
    })
    document.getElementById('workspace')!.append(this.root)
    const c = ed.canvas
    const refresh = (): void => this.render()
    for (const ev of ['selection:created', 'selection:updated', 'selection:cleared', 'text:selection:changed', 'text:editing:entered', 'text:editing:exited', 'text:changed'] as const) {
      c.on(ev as never, refresh)
    }
    window.addEventListener('keydown', (e) => this.onKey(e), { capture: true })
    window.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.tt-menu, [data-menu]')) this.closeMenu()
    }, { capture: true })
  }

  private get text(): Para | null {
    const o = this.ed.canvas.getActiveObject()
    return isText(o) ? o : null
  }

  /** Applique une modification puis enregistre une étape d'annulation. */
  private act(fn: (t: Para) => void): void {
    const t = this.text
    if (!t) return
    this.closeMenu()
    fn(t)
    this.ed.canvas.requestRenderAll()
    this.ed.history.touch(t)
    this.ed.history.record()
    this.render()
    // Rendre la main au texte (ou à la page) : Ctrl+Z, la frappe… continuent de fonctionner.
    if (t.isEditing) t.hiddenTextarea?.focus()
    else if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.menu) {
      e.preventDefault()
      e.stopPropagation()
      return this.closeMenu()
    }
    const t = this.text
    if (!t || !t.isEditing || (e.target as HTMLElement).closest?.('.text-toolbar, .tt-menu')) return
    const run = (fn: (t: Para) => void): void => {
      e.preventDefault()
      e.stopPropagation()
      this.act(fn)
    }
    // Listes : Entrée, Tab, Maj+Tab et Retour arrière se comportent comme dans Word.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.isComposing || !currentItem(t)) return
      if (e.key === 'Enter' && !e.shiftKey) return run((x) => void enterInList(x))
      if (e.key === 'Tab') return run((x) => void changeLevel(x, e.shiftKey ? -1 : 1))
      if (e.key === 'Backspace' && backspaceAfterMarker(t)) return run((x) => void backspaceInList(x))
      return
    }
    const k = e.key.toLowerCase()
    if (k === 'b') return run(toggleBold)
    if (k === 'i') return run(toggleItalic)
    if (k === 'u') return run(toggleUnderline)
    if (k === 'l' && e.shiftKey) return run((x) => toggleList(x, 'bullet'))
    if (k === 'l') return run((x) => x.set({ textAlign: 'left' }))
    if (k === 'e') return run((x) => x.set({ textAlign: 'center' }))
    if (k === 'r') return run((x) => x.set({ textAlign: 'right' }))
    if (k === 'j') return run((x) => x.set({ textAlign: 'justify-left' }))
    if (e.key === '>' || (e.shiftKey && e.code === 'Period') || e.key === ']') return run((x) => stepSize(x, 1))
    if (e.key === '<' || (e.shiftKey && e.code === 'Comma') || e.key === '[') return run((x) => stepSize(x, -1))
    if (e.key === '+' || (e.shiftKey && e.code === 'Equal')) return run((x) => toggleScript(x, 'super'))
    if (e.key === '=') return run((x) => toggleScript(x, 'sub'))
    if (e.code === 'Space') return run(clearFormatting)
  }

  // --- Construction de la barre ---------------------------------------------------------

  private render(): void {
    this.closeMenu()
    const t = this.text
    this.root.hidden = !t
    if (!t) return
    this.root.replaceChildren()

    // Police
    const g1 = this.group('Police')
    const family = document.createElement('select')
    family.className = 'tt-font'
    family.title = 'Police'
    const current = String(styleValue(t, 'fontFamily'))
    for (const f of FONTS.includes(current) ? FONTS : [current, ...FONTS]) {
      const o = new Option(f, f, false, f === current)
      o.style.fontFamily = `"${f}"`
      family.append(o)
    }
    family.addEventListener('change', () => this.act((x) => applyStyle(x, { fontFamily: family.value })))
    const size = document.createElement('input')
    size.className = 'tt-size'
    size.title = 'Taille de police (tapez une valeur, puis Entrée)'
    size.setAttribute('list', 'tt-sizes')
    size.inputMode = 'decimal'
    size.value = String(Math.round(Number(styleValue(t, 'fontSize')) * 10) / 10)
    const list = document.createElement('datalist')
    list.id = 'tt-sizes'
    list.innerHTML = WORD_SIZES.map((s) => `<option value="${s}">`).join('')
    const applySize = (): void => {
      const v = parseFloat(size.value.replace(',', '.'))
      if (v >= 1 && v <= 400) this.act((x) => applyStyle(x, { fontSize: v }))
    }
    size.addEventListener('change', applySize)
    size.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        applySize()
      }
    })
    g1.append(family, size, list)
    this.btn(g1, 'A<sup>+</sup>', 'Augmenter la taille (Ctrl+Maj+>)', false, (x) => stepSize(x, 1))
    this.btn(g1, 'A<sup>−</sup>', 'Diminuer la taille (Ctrl+Maj+<)', false, (x) => stepSize(x, -1))
    this.btn(g1, 'A<sub class="tt-eraser">✕</sub>', 'Effacer la mise en forme (Ctrl+Espace)', false, clearFormatting)

    // Caractères
    const g2 = this.group('Caractères')
    const w = styleValue(t, 'fontWeight')
    this.btn(g2, '<b>G</b>', 'Gras (Ctrl+B)', w === 'bold' || Number(w) >= 600, toggleBold)
    this.btn(g2, '<i>I</i>', 'Italique (Ctrl+I)', styleValue(t, 'fontStyle') === 'italic', toggleItalic)
    this.btn(g2, '<u>S</u>', 'Souligné (Ctrl+U)', !!styleValue(t, 'underline'), toggleUnderline)
    this.btn(g2, '<s>ab</s>', 'Barré', !!styleValue(t, 'linethrough'), toggleStrike)
    const dy = Number(styleValue(t, 'deltaY') ?? 0)
    this.btn(g2, 'x<sub>2</sub>', 'Indice (Ctrl+=)', dy > 0, (x) => toggleScript(x, 'sub'))
    this.btn(g2, 'x<sup>2</sup>', 'Exposant (Ctrl+Maj++)', dy < 0, (x) => toggleScript(x, 'super'))
    const fill = String(styleValue(t, 'fill') ?? '#000000')
    const hl = String(styleValue(t, 'textBackgroundColor') || '')
    this.menuButton(g2, `<span class="tt-swatch-label">A<i style="background:${fill}"></i></span>`, 'Couleur du texte', (m) =>
      this.palette(m, 'Couleur du texte', COLORS, fill, (c) => this.act((x) => applyStyle(x, { fill: c })), null)
    )
    this.menuButton(g2, `<span class="tt-swatch-label"><span class="tt-marker">ab</span><i style="background:${hl || 'transparent'}"></i></span>`, 'Surlignage du texte', (m) =>
      this.palette(m, 'Surlignage', HIGHLIGHTS, hl, (c) => this.act((x) => applyStyle(x, { textBackgroundColor: c })), 'Aucun')
    )

    // Paragraphe
    const g3 = this.group('Paragraphe')
    const item = currentItem(t)
    const bullet = item?.list.kind === 'bullet'
    const numbered = item?.list.kind === 'number'
    this.split(g3, ICONS.bullets, 'Puces (Ctrl+Maj+L)', bullet, (x) => toggleList(x, 'bullet', bullet ? undefined : this.lastBullet), (m) => {
      this.heading(m, 'Bibliothèque de puces')
      const grid = this.grid(m)
      this.choice(grid, 'Aucune', 'Aucune', !item, (x) => setList(x, null))
      for (const b of BULLETS) {
        this.choice(grid, `${b}`, `Puce ${b}`, bullet && item?.list.style === b, (x) => {
          this.lastBullet = b
          setList(x, { kind: 'bullet', style: b })
        })
      }
      this.levelItems(m, !!item)
    })
    this.split(g3, ICONS.numbers, 'Numérotation', numbered, (x) => toggleList(x, 'number', numbered ? undefined : this.lastNumber), (m) => {
      this.heading(m, 'Bibliothèque de numérotation')
      const grid = this.grid(m, 'wide')
      this.choice(grid, 'Aucune', 'Aucune', !item, (x) => setList(x, null))
      for (const n of NUMBERINGS) {
        const sample = [1, 2, 3].map((k) => marker({ kind: 'number', style: n }, k)).join('<br>')
        this.choice(grid, sample, `Numérotation ${n}`, numbered && item?.list.style === n, (x) => {
          this.lastNumber = n
          setList(x, { kind: 'number', style: n })
        })
      }
      this.levelItems(m, !!item)
    })
    const align = t.textAlign
    this.btn(g3, ICONS.left, 'Aligner à gauche (Ctrl+L)', align === 'left', (x) => x.set({ textAlign: 'left' }))
    this.btn(g3, ICONS.center, 'Centrer (Ctrl+E)', align === 'center', (x) => x.set({ textAlign: 'center' }))
    this.btn(g3, ICONS.right, 'Aligner à droite (Ctrl+R)', align === 'right', (x) => x.set({ textAlign: 'right' }))
    this.btn(g3, ICONS.justify, 'Justifier (Ctrl+J)', align.startsWith('justify'), (x) => x.set({ textAlign: 'justify-left' }))
    this.menuButton(g3, ICONS.spacing, 'Interligne et espacement des paragraphes', (m) => {
      this.heading(m, 'Interligne')
      const lh = Math.round(t.lineHeight * 100) / 100
      for (const v of LINE_SPACINGS) {
        this.item(m, String(v).replace('.', ','), `Interligne ${v}`, Math.abs(v - lh) < 0.01, (x) => x.set({ lineHeight: v }))
      }
      if (t.contour) return this.note(m, 'Zone de texte libre : les lignes suivent la forme dessinée.')
      this.heading(m, 'Espacement entre paragraphes et éléments de liste')
      const ps = t.paragraphSpacing ?? 0
      for (const v of PARA_SPACINGS) {
        this.item(m, v ? `${v} pt` : 'Aucun', `Espacement ${v} pt`, Math.abs(v - ps) < 0.01, (x) => x.set({ paragraphSpacing: v }))
      }
      const other = document.createElement('label')
      other.className = 'tt-other'
      other.innerHTML = 'Autre : <input type="number" min="0" max="200" step="1"> pt'
      const input = other.querySelector('input')!
      input.value = String(ps)
      input.title = 'Espacement personnalisé entre paragraphes (pt)'
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.dispatchEvent(new Event('change'))
      })
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (v >= 0 && v <= 200) this.act((x) => x.set({ paragraphSpacing: v }))
      })
      m.append(other)
    })
  }

  private group(name: string): HTMLElement {
    const g = document.createElement('div')
    g.className = 'tt-group'
    g.setAttribute('role', 'group')
    g.setAttribute('aria-label', name)
    this.root.append(g)
    return g
  }

  private btn(parent: HTMLElement, label: string, title: string, active: boolean, fn: (t: Para) => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `tt-btn ${active ? 'active' : ''}`
    b.innerHTML = label
    b.title = title
    b.setAttribute('aria-pressed', String(active))
    b.addEventListener('click', () => this.act(fn))
    parent.append(b)
    return b
  }

  /** Bouton partagé façon Word : action directe à gauche, variantes dans le menu ▾. */
  private split(parent: HTMLElement, label: string, title: string, active: boolean, fn: (t: Para) => void, build: (menu: HTMLElement) => void): void {
    const wrap = document.createElement('div')
    wrap.className = 'tt-split'
    parent.append(wrap)
    this.btn(wrap, label, title, active, fn)
    this.menuButton(wrap, '', `${title.replace(/ \(.*\)$/, '')} : styles et niveaux`, build, 'tt-caret')
  }

  /** Bouton qui ouvre un menu juste en dessous (posé sur la page : la barre défile sur téléphone). */
  private menuButton(parent: HTMLElement, label: string, title: string, build: (menu: HTMLElement) => void, cls = ''): void {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `tt-btn tt-drop ${cls}`
    b.innerHTML = `${label}<span class="tt-arrow">▾</span>`
    b.title = title
    b.dataset.menu = ''
    b.setAttribute('aria-haspopup', 'menu')
    b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', () => {
      const wasOpen = this.menuFor === b
      this.closeMenu()
      if (wasOpen) return
      const m = document.createElement('div')
      m.className = 'tt-menu'
      m.setAttribute('role', 'menu')
      m.setAttribute('aria-label', title)
      m.addEventListener('mousedown', (e) => {
        if (!(e.target as HTMLElement).matches('input')) e.preventDefault()
      })
      build(m)
      document.body.append(m)
      const r = b.getBoundingClientRect()
      m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`
      m.style.top = `${r.bottom + 4}px`
      m.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 16)}px`
      b.setAttribute('aria-expanded', 'true')
      this.menu = m
      this.menuFor = b
    })
    parent.append(b)
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menuFor?.setAttribute('aria-expanded', 'false')
    this.menu = this.menuFor = null
  }

  private heading(menu: HTMLElement, text: string): void {
    const h = document.createElement('div')
    h.className = 'tt-heading'
    h.textContent = text
    menu.append(h)
  }

  private note(menu: HTMLElement, text: string): void {
    const p = document.createElement('p')
    p.className = 'tt-note'
    p.textContent = text
    menu.append(p)
  }

  private grid(menu: HTMLElement, cls = ''): HTMLElement {
    const g = document.createElement('div')
    g.className = `tt-grid ${cls}`
    menu.append(g)
    return g
  }

  /** Case d'une bibliothèque (puces, numérotation). */
  private choice(grid: HTMLElement, label: string, title: string, active: boolean, fn: (t: Para) => void): void {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `tt-choice ${active ? 'active' : ''}`
    b.setAttribute('role', 'menuitemradio')
    b.setAttribute('aria-checked', String(active))
    b.innerHTML = label
    b.title = title
    b.addEventListener('click', () => this.act(fn))
    grid.append(b)
  }

  /** Ligne de menu, cochée (✓) pour la valeur actuelle. */
  private item(menu: HTMLElement, label: string, title: string, checked: boolean, fn: (t: Para) => void, enabled = true): void {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'tt-item'
    b.setAttribute('role', 'menuitemradio')
    b.setAttribute('aria-checked', String(checked))
    b.disabled = !enabled
    b.innerHTML = `<span class="tt-check">${checked ? '✓' : ''}</span><span>${label}</span>`
    b.title = title
    b.addEventListener('click', () => this.act(fn))
    menu.append(b)
  }

  private levelItems(menu: HTMLElement, inList: boolean): void {
    menu.append(Object.assign(document.createElement('hr'), { className: 'tt-sep' }))
    this.item(menu, 'Augmenter le niveau <kbd>Tab</kbd>', 'Augmenter le niveau de liste', false, (x) => void changeLevel(x, 1), inList)
    this.item(menu, 'Diminuer le niveau <kbd>Maj+Tab</kbd>', 'Diminuer le niveau de liste', false, (x) => void changeLevel(x, -1), inList)
  }

  /** Palette de couleurs (couleur du texte, surlignage). */
  private palette(menu: HTMLElement, title: string, colors: string[], current: string, pick: (c: string) => void, none: string | null): void {
    this.heading(menu, title)
    const grid = this.grid(menu, 'colors')
    const swatch = (color: string, label: string): void => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `swatch ${color ? '' : 'none'} ${color.toLowerCase() === current.toLowerCase() ? 'active' : ''}`
      if (color) b.style.background = color
      b.title = label
      b.addEventListener('click', () => pick(color))
      grid.append(b)
    }
    if (none) swatch('', none)
    for (const c of colors) swatch(c, c)
    const custom = document.createElement('label')
    custom.className = 'tt-other'
    custom.innerHTML = 'Autre couleur… <input type="color">'
    const input = custom.querySelector('input')!
    input.title = 'Autre couleur…'
    if (/^#[0-9a-f]{6}$/i.test(current)) input.value = current
    input.addEventListener('change', () => pick(input.value))
    menu.append(custom)
  }
}

/** Le curseur est-il juste après la puce (Retour arrière enlève alors la puce, comme Word) ? */
function backspaceAfterMarker(t: TextObj): boolean {
  if (t.selectionStart !== t.selectionEnd) return false
  const g = (t as unknown as { _text: string[] })._text
  let start = t.selectionStart
  while (start > 0 && g[start - 1] !== '\n') start--
  return /^( {4})*([•◦▪➤✓–]|\d+[.)]|[a-zA-Z]+[.)]) $/.test(g.slice(start, t.selectionStart).join(''))
}
