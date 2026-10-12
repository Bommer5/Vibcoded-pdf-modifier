import type { Tool, ToolManager } from '../tools/manager'
import { settings, type LineStyle, type ToolSettings } from '../tools/settings'

/** Tailles prédéfinies (fin / moyen / épais), comme dans les applications de prise de notes. */
const PRESETS: Partial<Record<Tool, { key: keyof ToolSettings; sizes: number[]; colorKey?: keyof ToolSettings }>> = {
  pen: { key: 'penWidth', sizes: [1.2, 2.5, 5], colorKey: 'penColor' },
  highlighter: { key: 'highlighterWidth', sizes: [8, 14, 24], colorKey: 'highlighterColor' },
  eraser: { key: 'eraserSize', sizes: [8, 16, 40] },
  shape: { key: 'shapeWidth', sizes: [1, 2, 4], colorKey: 'shapeStroke' }
}

/**
 * Barre rapide au-dessus de la feuille pour les outils de dessin : taille du trait
 * (3 préréglages + [ et ] au clavier), couleurs favorites (clic droit = remplacer
 * par une autre couleur), style plein / tirets / pointillés.
 */
export class QuickBar {
  private root = document.createElement('div')

  constructor(private tools: ToolManager) {
    this.root.className = 'quickbar'
    document.getElementById('workspace')!.append(this.root)
    tools.onChange(() => this.render())
    settings.onChange(() => this.render())
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        this.resize(e.key === ']' ? 1.25 : 0.8)
      }
    })
    this.render()
  }

  /** Change la taille de l'outil actif (×1,25 ou ×0,8). */
  resize(factor: number): void {
    const preset = PRESETS[this.tools.tool]
    if (!preset) return
    const current = settings.value[preset.key] as number
    const next = Math.round(Math.min(80, Math.max(0.5, current * factor)) * 10) / 10
    settings.set(preset.key, next as never)
  }

  private render(): void {
    const preset = PRESETS[this.tools.tool]
    this.root.replaceChildren()
    this.root.hidden = !preset
    if (!preset) return
    const v = settings.value
    const size = v[preset.key] as number
    const color = preset.colorKey ? (v[preset.colorKey] as string) : '#9a9ba3'

    const group = (): HTMLElement => {
      const g = document.createElement('div')
      g.className = 'qb-group'
      this.root.append(g)
      return g
    }

    const sizes = group()
    preset.sizes.forEach((s, i) => {
      const b = document.createElement('button')
      b.className = `qb-size ${Math.abs(s - size) < 0.05 ? 'active' : ''}`
      b.title = ['Fin', 'Moyen', 'Épais'][i] + ` (${s} pt) — [ et ] pour ajuster`
      const dot = document.createElement('span')
      const px = 4 + i * 5
      Object.assign(dot.style, { width: `${px}px`, height: `${px}px`, background: color })
      b.append(dot)
      b.addEventListener('click', () => settings.set(preset.key, s as never))
      sizes.append(b)
    })
    const value = document.createElement('span')
    value.className = 'qb-value'
    value.textContent = `${size} ${this.tools.tool === 'eraser' ? 'px' : 'pt'}`
    sizes.append(value)

    if (preset.colorKey) {
      const colors = group()
      v.favorites.forEach((c, i) => {
        const b = document.createElement('button')
        b.className = `swatch ${c.toLowerCase() === color.toLowerCase() ? 'active' : ''}`
        b.style.background = c
        b.title = `${c} — clic droit pour changer cette couleur`
        b.addEventListener('click', () => settings.set(preset.colorKey!, c as never))
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          const input = document.createElement('input')
          input.type = 'color'
          input.value = c
          input.addEventListener('change', () => {
            const favs = [...settings.value.favorites]
            favs[i] = input.value
            settings.set('favorites', favs)
            settings.set(preset.colorKey!, input.value as never)
          })
          input.click()
        })
        colors.append(b)
      })
    }

    if (this.tools.tool === 'pen' || this.tools.tool === 'shape') {
      const styles = group()
      const key = this.tools.tool === 'pen' ? 'penStyle' : 'shapeStyle'
      for (const [id, label, title] of [['solid', '━', 'Plein'], ['dashed', '╍', 'Tirets'], ['dotted', '┈', 'Pointillés']] as [LineStyle, string, string][]) {
        const b = document.createElement('button')
        b.className = `qb-style ${v[key] === id ? 'active' : ''}`
        b.textContent = label
        b.title = title
        b.addEventListener('click', () => settings.set(key, id))
        styles.append(b)
      }
    }
    if (this.tools.tool === 'highlighter') {
      const g = group()
      const b = document.createElement('button')
      b.className = `qb-toggle ${v.highlightSnap ? 'active' : ''}`
      b.textContent = 'Aimanter au texte'
      b.title = 'Le surligneur s’aligne exactement sur les lignes de texte du PDF (Maj = tracé libre)'
      b.addEventListener('click', () => settings.set('highlightSnap', !v.highlightSnap))
      g.append(b)
    }
  }
}
