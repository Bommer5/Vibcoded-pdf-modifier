import type { Page } from '../core/document'
import type { Editor } from '../core/editor'
import { EXPORT_FORMATS, type Exporter } from '../io/exporter'
import { platform } from '../platform'
import { enterSubmitsPrimary } from './dialog-keys'

const STORAGE_KEY = 'feuillet.export.v1'

/** Analyse « 1-3, 5 » en indices de pages (base 0), bornés au document. */
export function parseRange(text: string, count: number): number[] {
  const out = new Set<number>()
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map((n) => parseInt(n, 10))
    if (Number.isNaN(a)) continue
    const end = Number.isNaN(b) ? (part.endsWith('-') ? count : a) : b
    for (let i = Math.max(1, Math.min(a, end)); i <= Math.min(count, Math.max(a, end)); i++) out.add(i - 1)
  }
  return [...out].sort((x, y) => x - y)
}

export class ExportDialog {
  private dialog = document.getElementById('export-dialog') as HTMLDialogElement
  private format = document.getElementById('export-format') as HTMLSelectElement
  private pages = document.getElementById('export-pages') as HTMLSelectElement
  private range = document.getElementById('export-range') as HTMLInputElement
  private dpi = document.getElementById('export-dpi') as HTMLSelectElement
  private hint = document.getElementById('export-hint') as HTMLElement
  private name = 'Document'

  constructor(
    private ed: Editor,
    private exporter: Exporter
  ) {
    this.format.innerHTML = EXPORT_FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (saved.format) this.format.value = saved.format
      if (saved.dpi) this.dpi.value = saved.dpi
    } catch {
      // préférences indisponibles : valeurs par défaut
    }
    this.format.addEventListener('change', () => this.refresh())
    this.pages.addEventListener('change', () => this.refresh())
    enterSubmitsPrimary(this.dialog)
    this.dialog.addEventListener('close', () => {
      if (this.dialog.returnValue === 'ok') void this.submit()
    })
  }

  async open(name: string): Promise<void> {
    this.name = name
    const office = await platform.officeAvailable()
    for (const option of Array.from(this.format.options)) {
      const f = EXPORT_FORMATS.find((x) => x.id === option.value)!
      option.disabled = !!f.office && !office
      option.textContent = f.label + (option.disabled ? ' — nécessite LibreOffice' : '')
    }
    if (this.format.selectedOptions[0]?.disabled) this.format.value = 'pdf'
    this.refresh()
    this.dialog.returnValue = ''
    this.dialog.showModal()
  }

  private refresh(): void {
    const f = EXPORT_FORMATS.find((x) => x.id === this.format.value)!
    ;(document.getElementById('export-dpi-row') as HTMLElement).hidden = !f.raster
    ;(document.getElementById('export-range-row') as HTMLElement).hidden = this.pages.value !== 'range'
    this.pages.disabled = f.id === 'feuillet'
    this.hint.textContent =
      f.id === 'pdf'
        ? 'Les pages PDF d’origine sont conservées telles quelles (texte sélectionnable) ; vos ajouts sont ajoutés en vectoriel.'
        : f.id === 'feuillet'
          ? 'Format de travail : rouvrez-le pour tout modifier (objets, pages, images).'
          : f.perPage
            ? 'Un fichier par page (nom-1, nom-2…).'
            : f.office
              ? 'Conversion par LibreOffice : le texte devient modifiable, la mise en page peut légèrement changer.'
              : ''
  }

  private selectedPages(): Page[] {
    const all = this.ed.doc.pages
    if (this.pages.value === 'current') {
      const current = this.ed.doc.currentPage()
      return current ? [current] : all.slice(0, 1)
    }
    if (this.pages.value === 'range') return parseRange(this.range.value, all.length).map((i) => all[i])
    return all
  }

  private async submit(): Promise<void> {
    const format = EXPORT_FORMATS.find((x) => x.id === this.format.value)!
    const pages = this.selectedPages()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: format.id, dpi: this.dpi.value }))
    } catch {
      // sans importance
    }
    if (pages.length === 0) return this.ed.notify('Aucune page à exporter', 'error')
    this.ed.notify(`Export ${format.label}…`)
    try {
      const saved = await this.exporter.run({ format, pages, dpi: Number(this.dpi.value), name: this.name })
      if (saved) this.ed.notify(`Exporté : ${saved.length > 1 ? `${saved.length} fichiers` : saved[0]}`, 'success')
    } catch (e) {
      console.error(e)
      this.ed.notify((e as Error).message || 'Export impossible', 'error')
    }
  }
}
