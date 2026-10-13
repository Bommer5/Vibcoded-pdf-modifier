import { enterSubmitsPrimary } from './dialog-keys'
import { parseRange } from './export-dialog'

export type PdfInsertMode = 'image' | 'part' | 'pages-pdf' | 'pages-doc'

export interface PdfInsertChoice {
  mode: PdfInsertMode
  /** Index (à partir de 0) des pages à insérer. */
  pages: number[]
  /** Pour l'insertion en pages : après la page actuelle, ou à la fin. */
  position: 'after' | 'end'
}

const STORAGE_KEY = 'feuillet.pdfInsert'

/**
 * « Insérer un PDF » dans un document existant, sans mauvaise surprise de format :
 * - comme image sur la page (par défaut) : se déplace et se redimensionne librement ;
 * - une partie d'une page seulement (un exercice…) : la zone s'entoure dans la fenêtre suivante ;
 * - comme nouvelles pages au format du PDF (portrait reste portrait, paysage reste paysage) ;
 * - comme nouvelles pages au format du document (le PDF est centré, sans déformation).
 * Choix des pages (toutes, actuelle, plage) et de la position. Aperçu de la première page.
 */
export function askPdfInsert(
  fileName: string,
  sizes: { width: number; height: number }[],
  docPage: { width: number; height: number },
  thumbnail: Promise<HTMLCanvasElement | null>
): Promise<PdfInsertChoice | null> {
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { mode?: PdfInsertMode; position?: 'after' | 'end' } | null
    } catch {
      return null
    }
  })()
  const orient = (s: { width: number; height: number }): string => (s.width > s.height ? 'paysage' : s.width < s.height ? 'portrait' : 'carré')
  const fmt = (s: { width: number; height: number }): string => `${Math.round(s.width * 0.3528)} × ${Math.round(s.height * 0.3528)} mm, ${orient(s)}`
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog pdf-insert'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Insérer un PDF</h2>
      <div class="pi-head">
        <div class="pi-thumb" aria-hidden="true"></div>
        <div class="pi-info">
          <strong class="pi-name"></strong>
          <span class="muted small pi-meta"></span>
        </div>
      </div>
      <fieldset class="pi-modes">
        <legend>Comment l'insérer ?</legend>
        <label class="pi-mode"><input type="radio" name="mode" value="image" />
          <span><b>Comme image sur la page</b><small>Se déplace et se redimensionne librement, comme une photo. Reste net à l'export.</small></span></label>
        <label class="pi-mode"><input type="radio" name="mode" value="part" />
          <span><b>Une partie d’une page</b><small>Un exercice, un schéma, un paragraphe : choisissez la page puis entourez la zone.</small></span></label>
        <label class="pi-mode"><input type="radio" name="mode" value="pages-pdf" />
          <span><b>Nouvelles pages, format du PDF</b><small class="pi-pdf-size"></small></span></label>
        <label class="pi-mode"><input type="radio" name="mode" value="pages-doc" />
          <span><b>Nouvelles pages, format du document</b><small class="pi-doc-size"></small></span></label>
      </fieldset>
      <div class="pi-row">
        <label>Pages
          <select name="pages">
            <option value="all">Toutes</option>
            <option value="first">Première page seulement</option>
            <option value="range">Plage…</option>
          </select>
        </label>
        <label class="pi-range" hidden>Plage (ex. 1-3, 5)<input name="range" placeholder="1-3, 5" /></label>
        <label class="pi-position">Position
          <select name="position">
            <option value="after">Après la page actuelle</option>
            <option value="end">À la fin du document</option>
          </select>
        </label>
      </div>
      <p class="pi-error small" hidden>Plage de pages invalide.</p>
      <menu>
        <button value="cancel" formnovalidate>Annuler</button>
        <button value="ok" class="primary">Insérer</button>
      </menu>
    </form>`
  const $ = <T extends Element>(sel: string): T => dialog.querySelector(sel) as T
  $('.pi-name').textContent = fileName
  $('.pi-meta').textContent = `${sizes.length} page${sizes.length > 1 ? 's' : ''} · ${fmt(sizes[0])}`
  $('.pi-pdf-size').textContent = `Chaque page garde sa taille et son orientation (${orient(sizes[0])}).`
  $('.pi-doc-size').textContent = `Pages comme celles du document (${fmt(docPage)}) ; le PDF y est centré, sans déformation.`
  const form = $<HTMLFormElement>('form')
  const pagesSel = $<HTMLSelectElement>('select[name=pages]')
  const range = $<HTMLInputElement>('input[name=range]')
  const position = $<HTMLSelectElement>('select[name=position]')
  const error = $<HTMLElement>('.pi-error')
  if (sizes.length === 1) $<HTMLElement>('.pi-row label:first-child').hidden = true
  const mode = remembered?.mode ?? 'image'
  ;(form.elements.namedItem('mode') as RadioNodeList).value = mode
  position.value = remembered?.position ?? 'after'
  const update = (): void => {
    const m = (form.elements.namedItem('mode') as RadioNodeList).value
    $<HTMLElement>('.pi-position').hidden = m === 'image' || m === 'part'
    // Une partie : la page se choisit dans la fenêtre suivante.
    $<HTMLElement>('.pi-row').style.display = m === 'part' ? 'none' : ''
    $<HTMLElement>('.pi-range').hidden = pagesSel.value !== 'range'
    error.hidden = true
  }
  form.addEventListener('change', update)
  update()
  void thumbnail.then((c) => {
    if (c) $('.pi-thumb').append(c)
  })

  const chosen = (): number[] | null => {
    if ((form.elements.namedItem('mode') as RadioNodeList).value === 'part') return [0]
    if (pagesSel.value === 'first') return [0]
    if (pagesSel.value === 'range') {
      const list = parseRange(range.value, sizes.length)
      return list.length ? list : null
    }
    return sizes.map((_, i) => i)
  }
  form.addEventListener('submit', (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value === 'ok' && !chosen()) {
      e.preventDefault()
      error.hidden = false
      range.focus()
    }
  })

  document.body.append(dialog)
  enterSubmitsPrimary(dialog)
  dialog.showModal()
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const pages = chosen()
      const m = (form.elements.namedItem('mode') as RadioNodeList).value as PdfInsertMode
      dialog.remove()
      if (dialog.returnValue !== 'ok' || !pages) return resolve(null)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: m, position: position.value }))
      } catch {
        // stockage indisponible : on ne retient pas le choix
      }
      resolve({ mode: m, pages, position: position.value as 'after' | 'end' })
    })
  })
}
