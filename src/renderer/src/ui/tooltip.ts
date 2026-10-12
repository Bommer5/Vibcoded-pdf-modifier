/**
 * Info-bulles soignées pour les boutons à icône (barre d'outils, barre du haut, barre de
 * sélection) : nom en gras, raccourci dans une touche, précision éventuelle en dessous.
 * « Stylo (P) — Maj : ligne droite » → **Stylo** [P] / Maj : ligne droite.
 * Le `title` natif est retiré pour ne pas afficher deux bulles ; le nom reste dans aria-label.
 */
const SELECTOR = '#toolbar button, .topbar button[data-icon], .selection-bar button'

export function parseTip(title: string): { name: string; key: string; hint: string } {
  const [head, ...rest] = title.split(/ — | : (?=[A-ZÉ])/)
  const m = /^(.*?)(?: \(([^)]+)\))?$/.exec(head.trim())!
  return { name: m[1], key: m[2] ?? '', hint: rest.join(' — ') }
}

/** `keyOf` : raccourci actuel (personnalisable dans les Préférences) du bouton, s'il en a un. */
export function installTooltips(keyOf: (b: HTMLElement) => string | null = () => null): void {
  let tip: HTMLElement | null = null
  let timer = 0
  const hide = (): void => {
    window.clearTimeout(timer)
    tip?.remove()
    tip = null
  }
  const prepare = (b: HTMLElement): string | null => {
    if (b.title) {
      b.dataset.tip = b.title
      if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', parseTip(b.title).name)
      b.removeAttribute('title')
    }
    return b.dataset.tip ?? null
  }
  document.querySelectorAll<HTMLElement>(SELECTOR).forEach(prepare)
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return
    const b = (e.target as HTMLElement).closest?.<HTMLElement>(SELECTOR)
    if (!b) return
    const text = prepare(b)
    if (!text) return
    hide()
    timer = window.setTimeout(() => {
      const parsed = parseTip(text)
      const { name, hint } = parsed
      const key = keyOf(b) ?? parsed.key
      tip = document.createElement('div')
      tip.className = 'tip'
      tip.setAttribute('role', 'tooltip')
      const title = document.createElement('b')
      title.textContent = name
      if (key) title.append(Object.assign(document.createElement('kbd'), { textContent: key }))
      tip.append(title)
      if (hint) tip.append(Object.assign(document.createElement('span'), { textContent: hint }))
      document.body.append(tip)
      const r = b.getBoundingClientRect()
      const vertical = !!b.closest('#toolbar') && innerWidth > 700
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      const left = vertical ? r.right + 8 : Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))
      const below = r.bottom + 8 + h < innerHeight
      const top = vertical ? r.top + r.height / 2 - h / 2 : below ? r.bottom + 8 : r.top - h - 8
      tip.style.left = `${left}px`
      tip.style.top = `${Math.max(8, top)}px`
    }, 350)
  })
  document.addEventListener('pointerout', (e) => {
    if ((e.target as HTMLElement).closest?.(SELECTOR)) hide()
  })
  document.addEventListener('pointerdown', hide, { capture: true })
  window.addEventListener('blur', hide)
}
