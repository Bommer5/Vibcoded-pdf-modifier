import { enterSubmitsPrimary } from './dialog-keys'

/** Demande le mot de passe d'un PDF protégé. Renvoie null si l'utilisateur annule. */
export function askPassword(fileName: string, retry: boolean): Promise<string | null> {
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Document protégé</h2>
      <p class="muted small"></p>
      <label>Mot de passe <input type="password" name="pw" autocomplete="off" required /></label>
      <menu>
        <button value="cancel" formnovalidate>Annuler</button>
        <button value="ok" class="primary">Ouvrir</button>
      </menu>
    </form>`
  dialog.querySelector('p')!.textContent = retry ? `Mot de passe incorrect pour « ${fileName} ». Réessayez.` : `« ${fileName} » est protégé par un mot de passe.`
  document.body.append(dialog)
  const input = dialog.querySelector('input')!
  enterSubmitsPrimary(dialog)
  dialog.showModal()
  input.focus()
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value : null)
      dialog.remove()
    })
  })
}
