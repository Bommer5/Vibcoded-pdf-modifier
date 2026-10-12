import workerUrl from 'tesseract.js/dist/worker.min.js?url'
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import type { Page } from '../core/page'
import { assets } from '../core/assets'
import { pdfEngine } from './engine'
import type { PdfChar } from './protocol'

/**
 * Reconnaissance de caractères (OCR) : rend modifiable le texte qui n'en est pas vraiment un
 * dans le fichier — page scannée, photo, texte enregistré comme image ou comme dessin.
 *
 * Tesseract (Apache 2.0, WebAssembly) tourne sur l'appareil, sans internet, avec le modèle
 * français. Le résultat est rangé sur la page comme des caractères ordinaires (position,
 * ligne de base, taille, couleur) : recherche, sélection, surlignage et « Modifier PDF »
 * s'en servent comme du texte d'un PDF. Le texte modifié recouvre l'image d'origine de la
 * couleur du fond (`page.covers`).
 */

export interface OcrData {
  /** Caractères reconnus (mêmes champs que le texte d'un PDF ; police -1 = police par défaut). */
  chars: PdfChar[]
}

type Tesseract = typeof import('tesseract.js')
let workerPromise: Promise<Awaited<ReturnType<Tesseract['createWorker']>>> | null = null

function worker(): Promise<Awaited<ReturnType<Tesseract['createWorker']>>> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js')
    // Modèle français (tessdata « best_int », Apache 2.0) livré avec l'application : public/ocr.
    const langPath = new URL('ocr', document.baseURI).href
    const w = await createWorker('fra', 1, {
      workerPath: new URL(workerUrl, document.baseURI).href,
      corePath: new URL(coreUrl, document.baseURI).href,
      langPath,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true
    })
    // Mise en page analysée (colonnes, encadrés) : l'API part sinon d'un seul bloc de texte et
    // lit les colonnes ligne à ligne, l'une à la suite de l'autre.
    // La page est toujours rendue à 300 ppp : inutile de laisser Tesseract l'estimer.
    await w.setParameters({ tessedit_pageseg_mode: '3' as never, preserve_interword_spaces: '1', user_defined_dpi: '300' })
    return w
  })()
  return workerPromise
}

const OCR_DPI = 300
const hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** Image de la page (fond seul, sans les ajouts) à la résolution de l'OCR. */
async function pageImage(page: Page, dpi = OCR_DPI): Promise<HTMLCanvasElement | null> {
  const s = dpi / 72
  const w = Math.round(page.width * s)
  const h = Math.round(page.height * s)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  const bg = page.bg
  if (bg.kind === 'pdf') {
    const bmp = await pdfEngine.render(bg.assetId, bg.index, w, h, page.masks)
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
  } else if (bg.kind === 'image') {
    const asset = assets.get(bg.assetId)
    if (!asset) return null
    const bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
  } else return null
  return canvas
}

/** Le scan est-il parsemé de points isolés (bruit « sel et poivre ») ? Estimation par échantillon. */
function speckled(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: W, height: H } = canvas
  const d = ctx.getImageData(0, 0, W, H).data
  const g = (x: number, y: number): number => {
    const i = (y * W + x) * 4
    return d[i] + d[i + 1] + d[i + 2]
  }
  let isolated = 0
  let n = 0
  let seed = 12345
  for (let k = 0; k < 60000; k++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const x = 1 + (seed % (W - 2))
    const y = 1 + ((seed >> 8) % (H - 2))
    const v = g(x, y)
    const nb = [g(x - 1, y), g(x + 1, y), g(x, y - 1), g(x, y + 1)]
    n++
    if (nb.every((u) => Math.abs(u - v) > 240)) isolated++
  }
  return isolated / n > 0.004
}

/** Filtre médian 3×3 (enlève les points isolés en gardant les contours des lettres). */
function medianFilter(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: W, height: H } = canvas
  const img = ctx.getImageData(0, 0, W, H)
  const src = img.data
  const gray = new Uint8Array(W * H)
  for (let i = 0; i < gray.length; i++) gray[i] = (src[i * 4] + src[i * 4 + 1] + src[i * 4 + 2]) / 3
  const out = new Uint8Array(gray)
  const win = new Uint8Array(9)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = gray[(y + dy) * W + x + dx]
      win.sort()
      out[y * W + x] = win[4]
    }
  }
  for (let i = 0; i < out.length; i++) {
    // Couleur gardée là où le pixel n'était pas un point isolé.
    if (Math.abs(out[i] - gray[i]) < 60) continue
    src[i * 4] = src[i * 4 + 1] = src[i * 4 + 2] = out[i]
  }
  ctx.putImageData(img, 0, 0)
}

/** Couleur du texte (pixels les plus sombres) et du fond (les plus clairs) d'une zone. */
function colorsIn(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): { ink: string; bg: string } {
  const w = Math.max(1, Math.round(x1 - x0))
  const h = Math.max(1, Math.round(y1 - y0))
  const d = ctx.getImageData(Math.round(x0), Math.round(y0), w, h).data
  const px: [number, number, number, number][] = []
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], d[i] + d[i + 1] + d[i + 2]])
  px.sort((a, b) => a[3] - b[3])
  const avg = (list: typeof px): string => {
    const n = Math.max(1, list.length)
    return hex(list.reduce((a, p) => a + p[0], 0) / n, list.reduce((a, p) => a + p[1], 0) / n, list.reduce((a, p) => a + p[2], 0) / n)
  }
  const k = Math.max(1, Math.floor(px.length * 0.12))
  return { ink: avg(px.slice(0, k)), bg: avg(px.slice(-Math.max(1, Math.floor(px.length * 0.4)))) }
}

/** Reconnaît le texte d'une page. `progress` reçoit une valeur entre 0 et 1. */
export async function recognizePage(page: Page, progress?: (p: number) => void): Promise<OcrData> {
  const canvas = await pageImage(page)
  if (!canvas) return { chars: [] }
  // Scan bruité (poussières, « sel et poivre ») : nettoyé avant la lecture.
  if (speckled(canvas)) medianFilter(canvas)
  progress?.(0.1)
  const w = await worker()
  progress?.(0.3)
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false })
  progress?.(0.95)
  const ctx = canvas.getContext('2d')!
  const k = 72 / OCR_DPI
  const chars: PdfChar[] = []
  let index = 0
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        // Mots gardés même peu sûrs (un mot manquant est pire qu'une lettre douteuse) ; seules
        // les poussières (tout petites, sans lettre ni chiffre, peu sûres) sont écartées.
        const heights = line.words.map((wd) => wd.bbox.y1 - wd.bbox.y0).sort((a, c) => a - c)
        const typical = heights[Math.floor(heights.length / 2)] || 1
        const words = line.words.filter((wd) => {
          if (!wd.text.trim()) return false
          const small = wd.bbox.y1 - wd.bbox.y0 < typical * 0.45
          const noLetter = !/[\p{L}\p{N}€$%&@]/u.test(wd.text)
          // Peu sûr mais de taille normale et avec des lettres : c'est un vrai mot (souvent
          // une apostrophe ou un accent douteux), il est gardé.
          if (wd.confidence < 15 && (small || noLetter)) return false
          return !(small && wd.confidence < 60 && (noLetter || wd.text.length <= 2))
        })
        // Apostrophe lue deux fois (« qu'’hier ») : une seule, et la lettre fantôme disparaît.
        for (const wd of words) {
          for (let i = wd.symbols.length - 1; i > 0; i--) {
            if (/^['’]$/.test(wd.symbols[i].text) && /^['’]$/.test(wd.symbols[i - 1].text)) {
              wd.symbols[i - 1].bbox.x1 = wd.symbols[i].bbox.x1
              wd.symbols[i - 1].text = '’'
              wd.symbols.splice(i, 1)
            }
          }
        }
        // Boîte de lettre gonflée par une poussière voisine : ramenée à une largeur normale.
        const widths = words.flatMap((wd) => wd.symbols.map((sy) => sy.bbox.x1 - sy.bbox.x0)).sort((a, c) => a - c)
        const wMed = widths[Math.floor(widths.length / 2)] || 1
        for (const wd of words) {
          for (const sy of wd.symbols) {
            if (sy.bbox.x1 - sy.bbox.x0 > wMed * 3.5 && [...sy.text].length === 1) sy.bbox.x0 = sy.bbox.x1 - wMed * 1.4
          }
        }
        if (!words.length) continue
        const b = line.baseline
        const baseAt = (x: number): number => (b.x1 !== b.x0 ? b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0) : b.y0)
        // Taille de police : hauteur des majuscules / jambages hauts au-dessus de la ligne de base.
        const tops = words.flatMap((wd) => wd.symbols.map((s) => baseAt(s.bbox.x0) - s.bbox.y0)).sort((a, c) => a - c)
        const cap = tops[Math.floor(tops.length * 0.85)] ?? line.rowAttributes.rowHeight * 0.7
        const size = Math.max(4, (cap / 0.72) * k)
        const { ink, bg: back } = colorsIn(ctx, line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1)
        words.forEach((wd, wi) => {
          if (wi > 0) {
            const prev = words[wi - 1].bbox
            const x = prev.x1 * k
            chars.push({ c: ' ', x, y: baseAt(prev.x1) * k, x0: x, y0: wd.bbox.y0 * k, x1: wd.bbox.x0 * k, y1: wd.bbox.y1 * k, size, f: -1, color: ink, bg: back, i: index++ })
          }
          for (const s of wd.symbols) {
            for (const ch of [...s.text]) {
              chars.push({
                c: ch,
                x: s.bbox.x0 * k,
                y: baseAt((s.bbox.x0 + s.bbox.x1) / 2) * k,
                x0: s.bbox.x0 * k,
                y0: Math.min(s.bbox.y0, line.bbox.y0) * k,
                x1: s.bbox.x1 * k,
                y1: Math.max(s.bbox.y1, baseAt(s.bbox.x1)) * k,
                size,
                f: -1,
                color: ink,
                bg: back,
                i: index++
              })
            }
          }
        })
        chars.push({ c: '\n', x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0, size, f: -1, color: ink, i: index++ })
      }
    }
  }
  progress?.(1)
  // Arrondi : le résultat est enregistré avec le document.
  const r = (v: number): number => Math.round(v * 100) / 100
  return { chars: chars.map((c) => ({ ...c, x: r(c.x), y: r(c.y), x0: r(c.x0), y0: r(c.y0), x1: r(c.x1), y1: r(c.y1), size: r(c.size) })) }
}

/** La page a-t-elle besoin de l'OCR (aucun texte, ou très peu, dans le fichier) ? */
export function canRecognize(page: Page): boolean {
  return page.bg.kind === 'pdf' || page.bg.kind === 'image'
}

export interface FontGuess {
  family: string
  bold: boolean
  italic: boolean
  /** Correction de la taille estimée par l'OCR (1 = inchangée). */
  scale: number
}

/** Polices proposées : les plus courantes (livrées avec l'application en équivalents libres)… */
const BUNDLED = ['Arial', 'Times New Roman', 'Calibri', 'Cambria', 'Courier New']
/** …et celles de l'ordinateur, si elles y sont (Windows, macOS, Linux). */
const SYSTEM = ['Georgia', 'Verdana', 'Tahoma', 'Segoe UI', 'Garamond', 'Book Antiqua', 'Century Gothic', 'DejaVu Serif', 'DejaVu Sans', 'Noto Serif', 'Noto Sans', 'Helvetica Neue']

/** Police réellement installée (et pas seulement un nom de secours) ? */
function installed(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d')!
  const sample = 'mmmmmmmmmmlli1WQ@#àé'
  return ['monospace', 'serif', 'sans-serif'].every((generic) => {
    ctx.font = `72px ${generic}`
    const base = ctx.measureText(sample).width
    ctx.font = `72px "${family}", ${generic}`
    return ctx.measureText(sample).width !== base
  })
}

let candidates: string[] | null = null
function fontCandidates(): string[] {
  // Les noms déclarés par l'application comme équivalents libres (Georgia → Liberation Serif…)
  // donnent la même forme qu'une police déjà proposée : sans effet sur le choix.
  candidates ??= [...BUNDLED, ...SYSTEM.filter(installed)]
  return candidates
}

/**
 * Police la plus proche d'un texte scanné : quelques mots du scan sont comparés, forme contre
 * forme, aux polices courantes (normal, gras, italique), chacune mise à la largeur du mot.
 * La largeur trouvée corrige aussi la taille estimée par l'OCR.
 */
export async function matchFont(page: Page, chars: PdfChar[]): Promise<FontGuess> {
  const fallback: FontGuess = { family: 'Arial', bold: false, italic: false, scale: 1 }
  const words: PdfChar[][] = []
  let cur: PdfChar[] = []
  for (const c of chars) {
    if (/\s/.test(c.c)) {
      if (cur.length) words.push(cur)
      cur = []
    } else cur.push(c)
  }
  if (cur.length) words.push(cur)
  const sample = words.filter((w) => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 4)
  if (!sample.length) return fallback
  const S = 4
  const canvas = await pageImage(page, S * 72)
  if (!canvas) return fallback
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const test = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  const styles = [[false, false], [true, false], [false, true], [true, true]] as const
  const CANDIDATES = fontCandidates()
  await Promise.all(CANDIDATES.flatMap((f) => styles.map(([b, i]) => document.fonts.load(`${i ? 'italic' : 'normal'} ${b ? 'bold' : 'normal'} 20px "${f}"`).catch(() => []))))

  const scores = new Map<string, { score: number; scales: number[] }>()
  for (const word of sample) {
    const text = word.map((c) => c.c).join('')
    const x0 = Math.floor(Math.min(...word.map((c) => c.x0)) * S) - 2
    const x1 = Math.ceil(Math.max(...word.map((c) => c.x1)) * S) + 2
    const y0 = Math.floor(Math.min(...word.map((c) => c.y0)) * S) - 2
    const y1 = Math.ceil(Math.max(...word.map((c) => c.y1)) * S) + 2
    const w = x1 - x0
    const h = y1 - y0
    if (w < 4 || h < 4) continue
    const crop = ctx.getImageData(x0, y0, w, h).data
    const gray = new Float32Array(w * h)
    for (let i = 0; i < gray.length; i++) gray[i] = (crop[i * 4] + crop[i * 4 + 1] + crop[i * 4 + 2]) / 3
    const lo = Math.min(...gray)
    const hi = Math.max(...gray)
    const cut = (lo + hi) / 2
    const ink = Array.from(gray, (v) => v < cut)
    const inkLeft = Math.min(...word.map((c) => c.x0)) * S
    const inkRight = Math.max(...word.map((c) => c.x1)) * S
    const baseline = word[0].y * S - y0
    const size = word[0].size * S
    test.canvas.width = w
    test.canvas.height = h
    for (const family of CANDIDATES) {
      for (const [bold, italic] of styles) {
        const font = (px: number): string => `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${px}px "${family}"`
        test.font = font(size)
        const m = test.measureText(text)
        const drawn = m.actualBoundingBoxLeft + m.actualBoundingBoxRight
        if (drawn <= 0) continue
        // Même largeur que le mot scanné : on compare les formes, pas les tailles.
        const scale = (inkRight - inkLeft) / drawn
        if (scale < 0.7 || scale > 1.4) continue
        test.clearRect(0, 0, w, h)
        test.fillStyle = '#000'
        test.font = font(size * scale)
        const m2 = test.measureText(text)
        test.fillText(text, inkLeft - x0 + m2.actualBoundingBoxLeft, baseline)
        const d = test.getImageData(0, 0, w, h).data
        let both = 0
        let either = 0
        for (let i = 0; i < ink.length; i++) {
          const t = d[i * 4 + 3] > 127
          if (t && ink[i]) both++
          if (t || ink[i]) either++
        }
        const key = `${family}|${bold}|${italic}`
        const entry = scores.get(key) ?? { score: 0, scales: [] }
        entry.score += either ? both / either : 0
        entry.scales.push(scale)
        scores.set(key, entry)
      }
    }
  }
  // Gras ou italique seulement s'ils ressemblent nettement mieux que le romain de la même police.
  const adjusted = (key: string, score: number): number => {
    const [family, bold, italic] = key.split('|')
    if (bold === 'false' && italic === 'false') return score
    const regular = scores.get(`${family}|false|false`)?.score ?? 0
    return score > regular * 1.25 ? score : score * 0.85
  }
  let best: [string, { score: number; scales: number[] }] | null = null
  for (const e of scores) if (e[1].scales.length === sample.length && (!best || adjusted(e[0], e[1].score) > adjusted(best[0], best[1].score))) best = e
  if (!best) return fallback
  const [family, bold, italic] = best[0].split('|')
  const scales = [...best[1].scales].sort((a, b) => a - b)
  return { family, bold: bold === 'true', italic: italic === 'true', scale: scales[Math.floor(scales.length / 2)] }
}
