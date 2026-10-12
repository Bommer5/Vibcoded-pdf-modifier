import type { FileSession } from '../core/file-session'
import { PAPER_STYLES, type PaperStyle } from '../core/paper'

/**
 * Écran d'accueil (document vide au démarrage) : nouveau document (avec le style de papier),
 * ouvrir, fichiers récents, glisser-déposer. Disparaît dès qu'on commence à travailler.
 */
export class Welcome {
  private root = document.createElement('div')

  constructor(
    private session: FileSession,
    private actions: { newDoc(paper: PaperStyle): void; open(): void; openRecent(path: string): void }
  ) {
    this.root.className = 'welcome'
    this.root.hidden = true
    document.getElementById('workspace')!.append(this.root)
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.hide())
    // Clic à côté de la carte : on ferme (l'accueil ne bloque jamais).
    this.root.addEventListener('click', (e) => e.target === this.root && this.hide())
  }

  async show(): Promise<void> {
    await this.session.refreshRecent()
    const card = document.createElement('div')
    card.className = 'welcome-card'
    card.innerHTML = `
      <img src="./icon-192.png" alt="" width="64" height="64" />
      <h1>Feuillet</h1>
      <p class="muted">Annotez, écrivez et modifiez vos PDF, documents et images.</p>
      <div class="welcome-actions">
        <button class="primary big" data-w="new">Nouveau document</button>
        <button class="big" data-w="open">Ouvrir un fichier…</button>
      </div>
      <div class="welcome-papers" role="group" aria-label="Papier du nouveau document"></div>
      <div class="welcome-recent"></div>
      <p class="muted small">Ou glissez un PDF, une image, un document Word… n’importe où dans la fenêtre.</p>`
    let paper: PaperStyle = 'plain'
    const papers = card.querySelector('.welcome-papers')!
    for (const p of PAPER_STYLES.slice(0, 5)) {
      const b = document.createElement('button')
      b.className = `prop-chip ${p.id === paper ? 'active' : ''}`
      b.textContent = p.label
      b.addEventListener('click', () => {
        paper = p.id
        papers.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b))
      })
      papers.append(b)
    }
    card.querySelector('[data-w=new]')!.addEventListener('click', () => {
      this.hide()
      this.actions.newDoc(paper)
    })
    card.querySelector('[data-w=open]')!.addEventListener('click', () => {
      this.hide()
      this.actions.open()
    })
    const recent = card.querySelector('.welcome-recent')!
    if (this.session.recent.length) {
      const h = document.createElement('h3')
      h.textContent = 'Récents'
      recent.append(h)
      for (const r of this.session.recent.slice(0, 6)) {
        const b = document.createElement('button')
        b.className = 'welcome-file'
        b.textContent = r.name
        b.title = r.path
        b.addEventListener('click', () => {
          this.hide()
          this.actions.openRecent(r.path)
        })
        recent.append(b)
      }
    }
    this.root.replaceChildren(card)
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  get visible(): boolean {
    return !this.root.hidden
  }
}
