/**
 * Ressources binaires du document (images, PDF d'origine). Chaque ressource
 * a un identifiant stable (sauvegardé dans le projet) et une URL blob locale
 * (utilisée par le canevas, jamais sauvegardée).
 */
export interface Asset {
  id: string
  mime: string
  bytes: Uint8Array
  url: string
}

class AssetStore {
  private byId = new Map<string, Asset>()
  private idByUrl = new Map<string, string>()

  add(bytes: Uint8Array, mime: string, id: string = crypto.randomUUID()): Asset {
    const existing = this.byId.get(id)
    if (existing) return existing
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
    const asset = { id, mime, bytes, url }
    this.byId.set(id, asset)
    this.idByUrl.set(url, id)
    return asset
  }

  async addBlob(blob: Blob): Promise<Asset> {
    return this.add(new Uint8Array(await blob.arrayBuffer()), blob.type || 'application/octet-stream')
  }

  get(id: string): Asset | undefined {
    return this.byId.get(id)
  }

  idForUrl(url: string): string | undefined {
    return this.idByUrl.get(url)
  }

  all(): Asset[] {
    return [...this.byId.values()]
  }

  /** Libère les ressources, sauf celles encore référencées ailleurs (presse-papiers…). */
  clear(keep: Set<string> = new Set()): void {
    for (const a of [...this.byId.values()]) {
      if (keep.has(a.id)) continue
      URL.revokeObjectURL(a.url)
      this.byId.delete(a.id)
      this.idByUrl.delete(a.url)
    }
  }
}

export const assets = new AssetStore()

/** Encode une ressource en data URL (export SVG / PDF autonome). */
export function toDataUrl(asset: Asset): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < asset.bytes.length; i += chunk) {
    binary += String.fromCharCode(...asset.bytes.subarray(i, i + chunk))
  }
  return `data:${asset.mime};base64,${btoa(binary)}`
}
