/**
 * Entrée valide toujours le bouton principal d'une boîte de dialogue (et non le premier
 * bouton du formulaire, souvent « Annuler »). Échap annule (comportement natif).
 */
export function enterSubmitsPrimary(dialog: HTMLDialogElement): void {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    const target = e.target as HTMLElement
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA' || target.closest('[data-enter-local]')) return
    const primary = dialog.querySelector<HTMLButtonElement>('button.primary')
    if (!primary) return
    e.preventDefault()
    const form = dialog.querySelector('form')
    if (form && !form.reportValidity()) return
    dialog.close(primary.value || 'ok')
  })
}
