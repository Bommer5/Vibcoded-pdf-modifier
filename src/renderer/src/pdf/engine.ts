import type { PdfChar, PdfCharFont, PdfGlyphFont, PdfFontInfo, PdfMask, PdfShift, PdfOutlineItem, PdfPageInfo, PdfRequest, PdfResponse, PdfWord, PdfShape } from './protocol'

/**
 * Accès au moteur PDF natif (PDFium/WASM dans un worker). Les requêtes de rendu
 * sont mises en file : la plus récente passe en premier (la page qu'on regarde).
 */
class PdfEngine {
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, (res: PdfResponse) => void>()
  private opened = new Map<string, Promise<PdfPageInfo[]>>()

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./pdfium.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<{ id: number; res: PdfResponse }>) => {
        this.pending.get(e.data.id)?.(e.data.res)
        this.pending.delete(e.data.id)
      }
    }
    return this.worker
  }

  private call(req: PdfRequest, transfer: Transferable[] = []): Promise<PdfResponse & { ok: true }> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, (res) => (res.ok ? resolve(res) : reject(new Error(res.error))))
      this.w.postMessage({ id, req }, transfer)
    })
  }

  /** Copies déverrouillées des PDF chiffrés (à substituer aux octets d'origine). */
  readonly decrypted = new Map<string, Uint8Array>()

  /** Ouvre un PDF (une seule fois par ressource) et renvoie la taille de ses pages. */
  open(doc: string, data: Uint8Array, password?: string): Promise<PdfPageInfo[]> {
    let p = this.opened.get(doc)
    if (!p) {
      // Copie : le tampon est transféré au worker.
      const copy = data.slice()
      p = this.call({ op: 'open', doc, data: copy, password }, [copy.buffer]).then((r) => {
        if (r.decrypted) this.decrypted.set(doc, r.decrypted)
        return r.pages!
      })
      p.catch(() => this.opened.delete(doc))
      this.opened.set(doc, p)
    }
    return p
  }

  isOpen(doc: string): boolean {
    return this.opened.has(doc)
  }

  async close(doc: string): Promise<void> {
    if (!this.opened.delete(doc)) return
    await this.call({ op: 'close', doc })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.opened.keys()].map((d) => this.close(d)))
  }

  async render(doc: string, page: number, width: number, height: number, masks?: PdfMask[], shifts?: PdfShift[], hidden?: number[]): Promise<ImageBitmap> {
    return (await this.call({ op: 'render', doc, page, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), masks, shifts: shifts?.length ? shifts : undefined, hidden: hidden?.length ? hidden : undefined })).bitmap!
  }

  /** Trait ou forme vectorielle sous un point (coordonnées de la page), ou null. */
  async shapeAt(doc: string, page: number, x: number, y: number, tolerance: number, hidden?: number[]): Promise<PdfShape | null> {
    return (await this.call({ op: 'shapeat', doc, page, x, y, tolerance, hidden })).shape ?? null
  }

  private charCache = new Map<string, Promise<{ chars: PdfChar[]; fonts: PdfCharFont[] }>>()

  /** Caractères d'une page avec position exacte et police (mis en cache). */
  chars(doc: string, page: number): Promise<{ chars: PdfChar[]; fonts: PdfCharFont[] }> {
    const key = `${doc}#${page}`
    let p = this.charCache.get(key)
    if (!p) {
      p = this.call({ op: 'chars', doc, page }).then((r) => ({ chars: r.chars ?? [], fonts: r.fonts ?? [] }))
      this.charCache.set(key, p)
    }
    return p
  }

  /** Contours des glyphes de la police d'un caractère (voir le moteur). */
  async glyphs(doc: string, page: number, char: number, codepoints: number[], strict: number[]): Promise<PdfGlyphFont | null> {
    return (await this.call({ op: 'glyphs', doc, page, char, codepoints, strict })).glyphFont ?? null
  }

  /** Fichier de la police intégrée utilisée par un caractère, ou null. */
  async fontData(doc: string, page: number, char: number): Promise<Uint8Array | null> {
    return (await this.call({ op: 'fontdata', doc, page, char })).file ?? null
  }

  async fontInfo(doc: string, page: number, x: number, y: number): Promise<PdfFontInfo | null> {
    return (await this.call({ op: 'fontinfo', doc, page, x, y })).font ?? null
  }

  /** PDF dont le texte des zones masquées est réellement supprimé. */
  async redacted(doc: string, pages: { page: number; masks: PdfMask[]; shifts?: PdfShift[]; hidden?: number[] }[]): Promise<Uint8Array> {
    return (await this.call({ op: 'redacted', doc, pages })).file!
  }

  private textCache = new Map<string, Promise<PdfWord[]>>()

  /** Mots d'une page (mis en cache : recherche, sélection de texte, surlignage aimanté). */
  words(doc: string, page: number): Promise<PdfWord[]> {
    const key = `${doc}:${page}`
    let p = this.textCache.get(key)
    if (!p) {
      p = this.call({ op: 'text', doc, page }).then((r) => r.words!)
      this.textCache.set(key, p)
    }
    return p
  }

  async outline(doc: string): Promise<PdfOutlineItem[]> {
    return (await this.call({ op: 'outline', doc })).outline!
  }

  async attachment(doc: string, name: string): Promise<Uint8Array | null> {
    return (await this.call({ op: 'attachment', doc, name })).file ?? null
  }

  forgetText(): void {
    this.textCache.clear()
    this.charCache.clear()
  }
}

export const pdfEngine = new PdfEngine()
