import type { Editor } from './editor'
import type { Exporter } from '../io/exporter'
import { extOf, type Importer } from '../io/importer'
import { saveProject } from '../io/project'
import { platform, type OpenedFile } from '../platform'

type Kind = 'feuillet' | 'pdf' | 'other'

/** Sauvegarde de secours : quelques secondes après la dernière modification, et au plus tard toutes les 30 s. */
const AUTOSAVE_DELAY_MS = 3_000
const AUTOSAVE_MAX_MS = 30_000

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
  /** Cette session de travail : sa sauvegarde de secours n'écrase jamais celle d'une autre. */
  private readonly recoveryId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  private autosaveTimer = 0
  private firstUnsaved = 0
  recent: { path: string; name: string }[] = []

  constructor(
    private ed: Editor,
    private importer: Importer,
    private exporter: Exporter
  ) {
    // Mobile : l'application peut être tuée en arrière-plan (ou balayée) → on sauvegarde dès
    // qu'elle quitte l'écran ; PC : juste avant la question de fermeture.
    document.addEventListener('visibilitychange', () => document.hidden && void this.autosave())
    window.addEventListener('pagehide', () => void this.autosave())
    platform.onAutosaveNow(() => this.autosave())
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
    // Sauvegarde de secours peu après la dernière modification (et au plus tard après 30 s)
    const now = Date.now()
    if (!this.firstUnsaved) this.firstUnsaved = now
    window.clearTimeout(this.autosaveTimer)
    const wait = Math.min(AUTOSAVE_DELAY_MS, Math.max(0, this.firstUnsaved + AUTOSAVE_MAX_MS - now))
    this.autosaveTimer = window.setTimeout(() => void this.autosave(), wait)
  }

  private markSaved(): void {
    this.savedVersion = this.version
    this.autosavedVersion = this.version
    // Le travail est dans un fichier : la sauvegarde de secours de cette session n'a plus lieu d'être
    // (après une éventuelle sauvegarde en cours, pour qu'elle ne la recrée pas).
    window.clearTimeout(this.autosaveTimer)
    this.firstUnsaved = 0
    this.saving = this.saving.then(() => platform.recoveryDelete(this.recoveryId)).catch(() => {})
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

  private saving: Promise<void> = Promise.resolve()

  async autosave(): Promise<void> {
    window.clearTimeout(this.autosaveTimer)
    this.saving = this.saving.then(async () => {
      if (!this.dirty || this.version === this.autosavedVersion || this.ed.doc.isEmpty) return
      try {
        const version = this.version
        const data = await saveProject(this.ed.canvas, { layers: this.ed.layers?.list, recovery: { name: this.name } })
        await platform.recoveryWrite(this.recoveryId, this.name, data)
        this.autosavedVersion = version
        this.firstUnsaved = 0
      } catch (e) {
        console.warn('Sauvegarde automatique impossible', e)
      }
    })
    return this.saving
  }

  /**
   * Au démarrage : travail non enregistré d'une session précédente (fermeture, plantage,
   * application balayée sur téléphone) → une bande qui reste jusqu'à ce qu'on choisisse.
   */
  async offerRecovery(): Promise<void> {
    const list = (await platform.recoveryList().catch(() => [])).filter((r) => r.id !== this.recoveryId)
    const last = list[0]
    if (!last) return
    const bar = document.createElement('div')
    bar.className = 'recovery-bar'
    bar.setAttribute('role', 'alert')
    const when = new Date(last.time).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
    bar.innerHTML = `<span><b>Travail non enregistré retrouvé</b> — « ${escapeHtml(last.name)} », ${when}${list.length > 1 ? ` (et ${list.length - 1} autre${list.length > 2 ? 's' : ''})` : ''}</span>`
    const restore = document.createElement('button')
    restore.className = 'primary'
    restore.textContent = 'Restaurer'
    restore.addEventListener('click', async () => {
      bar.remove()
      await this.restore(last.id, last.name)
    })
    const all = document.createElement('button')
    all.textContent = 'Tout voir…'
    all.addEventListener('click', () => {
      bar.remove()
      void this.showRecovery()
    })
    const close = document.createElement('button')
    close.textContent = 'Plus tard'
    close.title = 'La sauvegarde reste disponible : Fichier > Récupérer un travail non enregistré'
    close.addEventListener('click', () => bar.remove())
    bar.append(restore, all, close)
    document.getElementById('workspace')?.append(bar)
  }

  /** Ouvre une sauvegarde de secours (le document actuel est gardé lui aussi en secours). */
  async restore(id: string, name: string): Promise<void> {
    const data = await platform.recoveryRead(id)
    if (!data) return this.ed.notify('Cette sauvegarde n’existe plus.', 'error')
    await this.autosave()
    await this.importer.open([{ name: 'Récupération.feuillet', data }], { confirm: false })
    this.set({ name: name.replace(/\.[^.]+$/, '') + ' (récupéré)' })
    this.version++
    this.updateTitle()
    this.ed.notify('Travail récupéré. Pensez à l’enregistrer (Ctrl+S).', 'success')
  }

  /** Fichier > Récupérer un travail non enregistré : la liste des sauvegardes de secours. */
  async showRecovery(): Promise<void> {
    const list = (await platform.recoveryList().catch(() => [])).filter((r) => r.id !== this.recoveryId)
    const dialog = document.createElement('dialog')
    dialog.className = 'dialog recovery-dialog'
    dialog.innerHTML = `<form method="dialog"><h2>Récupérer un travail non enregistré</h2>
      <p class="muted small">Feuillet garde une copie de secours de chaque séance de travail non enregistrée, pendant 14 jours.</p>
      <div class="recovery-list"></div><menu><button value="cancel">Fermer</button></menu></form>`
    const box = dialog.querySelector('.recovery-list')!
    if (!list.length) box.textContent = 'Aucune sauvegarde de secours.'
    for (const r of list) {
      const row = document.createElement('div')
      row.className = 'recovery-row'
      const when = new Date(r.time).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
      row.innerHTML = `<span><b>${escapeHtml(r.name)}</b><small>${when}${r.size ? ` · ${Math.max(1, Math.round(r.size / 1024))} Ko` : ''}</small></span>`
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'primary'
      open.textContent = 'Ouvrir'
      open.addEventListener('click', () => {
        dialog.close()
        void this.restore(r.id, r.name)
      })
      const del = document.createElement('button')
      del.type = 'button'
      del.textContent = 'Supprimer'
      del.addEventListener('click', async () => {
        await platform.recoveryDelete(r.id)
        row.remove()
      })
      row.append(open, del)
      box.append(row)
    }
    document.body.append(dialog)
    dialog.addEventListener('close', () => dialog.remove())
    dialog.showModal()
  }

  async refreshRecent(): Promise<void> {
    this.recent = await platform.recentFiles().catch(() => [])
  }
}

const escapeHtml = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
