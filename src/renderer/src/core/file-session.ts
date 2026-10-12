import type { Editor } from './editor'
import type { Exporter } from '../io/exporter'
import { extOf, type Importer } from '../io/importer'
import { saveProject } from '../io/project'
import { platform, type OpenedFile } from '../platform'

type Kind = 'feuillet' | 'pdf' | 'other'

const AUTOSAVE_EVERY_MS = 45_000

/**
 * Le fichier en cours : enregistrement direct (Ctrl+S) dans le fichier ouvert,
 * y compris un PDF (« PDF modifiable » : lisible partout, entièrement modifiable
 * dans Feuillet), sauvegarde automatique et récupération après plantage,
 * fichiers récents, avertissement à la fermeture si rien n'est enregistré.
 */
export class FileSession {
  path: string | null = null
  name = 'Document'
  kind: Kind = 'other'
  private version = 0
  private savedVersion = 0
  private autosavedVersion = 0
  recent: { path: string; name: string }[] = []

  constructor(
    private ed: Editor,
    private importer: Importer,
    private exporter: Exporter
  ) {
    window.setInterval(() => void this.autosave(), AUTOSAVE_EVERY_MS)
    // Mobile : l'application peut être tuée en arrière-plan → on sauvegarde en quittant l'écran.
    document.addEventListener('visibilitychange', () => document.hidden && void this.autosave())
    platform.onSaveBeforeClose(async () => {
      if (await this.save()) platform.closeNow()
    })
    void this.refreshRecent()
  }

  get dirty(): boolean {
    return this.version !== this.savedVersion
  }

  /** À appeler à chaque changement de l'historique. */
  changed(): void {
    this.version++
    this.updateTitle()
  }

  private markSaved(): void {
    this.savedVersion = this.version
    this.autosavedVersion = this.version
    void platform.autosaveClear()
    this.updateTitle()
  }

  private updateTitle(): void {
    document.title = `${this.dirty ? '• ' : ''}${this.name} — Feuillet`
    platform.setDirty(this.dirty)
  }

  private set(file: { name: string; path?: string | null }): void {
    this.name = file.name
    this.path = file.path ?? null
    const ext = extOf(file.name)
    this.kind = ext === 'feuillet' ? 'feuillet' : ext === 'pdf' ? 'pdf' : 'other'
  }

  async open(files: OpenedFile[]): Promise<void> {
    if (!files.length) return
    if (this.dirty && !this.ed.doc.isEmpty && !confirm('Le document actuel n’est pas enregistré. L’abandonner ?')) return
    const opened = await this.importer.open(files, { confirm: false })
    if (!opened) return
    // Un seul fichier ouvert : Ctrl+S réécrira ce fichier ; sinon nouveau document.
    this.set(files.length === 1 ? files[0] : { name: 'Document' })
    this.markSaved()
    void this.refreshRecent()
  }

  async openRecent(path: string): Promise<void> {
    try {
      await this.open(await platform.openRecent(path))
    } catch (e) {
      this.ed.notify((e as Error).message, 'error')
    }
  }

  newDocument(): void {
    this.set({ name: 'Document' })
    this.markSaved()
  }

  private async bytesFor(kind: Kind): Promise<Uint8Array> {
    const pages = this.ed.doc.pages
    if (kind === 'pdf') return this.exporter.pdf(pages, { embedProject: true })
    return saveProject(this.ed.canvas, { layers: this.ed.layers?.list })
  }

  /** Ctrl+S : réécrit le fichier ouvert (projet ou PDF), sinon « Enregistrer sous ». */
  async save(): Promise<boolean> {
    if (!this.path || this.kind === 'other' || platform.kind !== 'desktop') return this.saveAs()
    try {
      await platform.writeFile(this.path, await this.bytesFor(this.kind))
      this.markSaved()
      this.ed.notify(
        this.kind === 'pdf' ? `Enregistré dans ${this.name} (lisible partout, modifiable dans Feuillet)` : `Enregistré : ${this.name}`,
        'success'
      )
      return true
    } catch (e) {
      this.ed.notify((e as Error).message || 'Enregistrement impossible', 'error')
      return false
    }
  }

  async saveAs(): Promise<boolean> {
    const stem = this.name.replace(/\.[^.]+$/, '')
    const filters = [
      { name: 'Projet Feuillet', extensions: ['feuillet'] },
      { name: 'PDF modifiable dans Feuillet', extensions: ['pdf'] }
    ]
    const path = await platform.chooseSavePath(`${stem}.${this.kind === 'pdf' ? 'pdf' : 'feuillet'}`, this.kind === 'pdf' ? [filters[1], filters[0]] : filters)
    if (path === null) return false
    try {
      if (path === undefined) {
        // Mobile / navigateur : partage ou téléchargement du projet.
        const saved = await platform.saveFiles(`${stem}.feuillet`, filters[0], 'application/zip', [await this.bytesFor('feuillet')])
        if (saved) this.markSaved()
        return !!saved
      }
      const kind: Kind = extOf(path) === 'pdf' ? 'pdf' : 'feuillet'
      const target = kind === 'feuillet' && extOf(path) !== 'feuillet' ? `${path}.feuillet` : path
      await platform.writeFile(target, await this.bytesFor(kind))
      this.set({ name: target.split(/[\\/]/).pop()!, path: target })
      this.markSaved()
      this.ed.notify(`Enregistré : ${this.name}`, 'success')
      void this.refreshRecent()
      return true
    } catch (e) {
      this.ed.notify((e as Error).message || 'Enregistrement impossible', 'error')
      return false
    }
  }

  async autosave(): Promise<void> {
    if (!this.dirty || this.version === this.autosavedVersion) return
    try {
      const version = this.version
      await platform.autosaveWrite(await saveProject(this.ed.canvas, { layers: this.ed.layers?.list, recovery: { name: this.name } }))
      this.autosavedVersion = version
    } catch (e) {
      console.warn('Sauvegarde automatique impossible', e)
    }
  }

  /** Au démarrage : propose de restaurer le travail non enregistré (plantage, coupure…). */
  async offerRecovery(): Promise<void> {
    const data = await platform.autosaveRead().catch(() => null)
    if (!data) return
    this.ed.notify('Du travail non enregistré a été retrouvé.', 'info', {
      label: 'Restaurer',
      run: async () => {
        await this.importer.open([{ name: 'Récupération.feuillet', data }], { confirm: false })
        this.set({ name: 'Document récupéré' })
        this.version++
        this.updateTitle()
      }
    })
  }

  async refreshRecent(): Promise<void> {
    this.recent = await platform.recentFiles().catch(() => [])
  }
}
