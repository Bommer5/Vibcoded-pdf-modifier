import { Point, Textbox } from 'fabric'
import type { Editor } from '../core/editor'
import { scenePoints, type InkObject } from '../tools/ink'
import type { ToolManager } from '../tools/manager'
import { settings } from '../tools/settings'
import type { Candidate } from './decode'
import { handwriting } from './engine'
import type { Stroke } from './ink-image'
import { rotate, segment, textHeight, type Box } from './segment'

/** Zone de texte issue de l'écriture : propositions et traits d'origine (pour revenir à l'encre). */
type HwrBox = Textbox & { hwr?: { alts: string[] } }

/**
 * Écriture → texte. Mode « au fil de l'eau » (réglage) : ce qu'on écrit au stylo est reconnu
 * après une courte pause et remplacé par du texte à la même place, à la même taille, de la même
 * couleur ; les dessins (traits droits, formes, schémas) restent de l'encre. À tout moment :
 * « Convertir en texte » sur des traits sélectionnés. Après une conversion, une petite barre
 * propose les autres lectures et le retour à l'encre ; Ctrl+Z annule aussi.
 */
export class HandwritingConverter {
  private pending: InkObject[] = []
  private timer = 0
  private busy: Promise<void> = Promise.resolve()
  private chip = document.createElement('div')
  /** Traits remplacés, pour revenir à l'encre. */
  private sources = new WeakMap<Textbox, InkObject[]>()

  constructor(private ed: Editor, tools: ToolManager) {
    this.chip.className = 'hwr-chip'
    this.chip.hidden = true
    document.getElementById('workspace')!.append(this.chip)
    tools.onInk = (o) => {
      if (!settings.value.handwriting) return
      this.pending.push(o)
      this.schedule()
    }
    tools.onPenDown = () => {
      window.clearTimeout(this.timer)
      this.hideChip()
    }
    // Changement d'outil : ce qui attend est converti tout de suite.
    tools.onChange(() => {
      if (this.pending.length) this.flush()
    })
    ed.canvas.on('mouse:down', () => this.hideChip())
    ed.canvas.on('after:render', () => this.placeChip())
  }

  private schedule(): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.flush(), settings.value.handwritingDelay)
  }

  /** Convertit tout de suite ce qui attend. */
  flush(): Promise<void> {
    window.clearTimeout(this.timer)
    const list = this.pending
    this.pending = []
    this.busy = this.busy.then(async () => void (await this.convert(list, false))).catch((e) => {
      console.error(e)
      this.ed.notify('Reconnaissance de l’écriture impossible sur cet appareil.', 'error')
    })
    return this.busy
  }

  /** « Convertir en texte » sur les traits sélectionnés (seuil de confiance plus souple). */
  async convertSelection(): Promise<number> {
    const inks = this.ed.canvas.getActiveObjects().filter((o): o is InkObject => !!(o as InkObject).ink && (o as InkObject).ink!.tool === 'pen')
    if (!inks.length) return 0
    this.ed.canvas.discardActiveObject()
    let n = 0
    await (this.busy = this.busy.then(async () => {
      n = await this.convert(inks, true)
    }))
    if (!n) this.ed.notify('Aucun texte reconnu dans la sélection.', 'info')
    return n
  }

  /** Reconnaît et remplace ; renvoie le nombre de zones de texte créées. */
  async convert(list: InkObject[], manual: boolean): Promise<number> {
    const alive = list.filter((o) => this.ed.canvas.getObjects().includes(o))
    if (!alive.length) return 0
    const strokes: Stroke[] = alive.map((o) => scenePoints(o).map(([x, y]) => [x, y] as [number, number]))
    // Hauteur de référence : l'écriture de la page en cours, pas seulement ces traits-ci
    const seg = segment(alive.map((_, i) => ({ id: i, points: strokes[i] })), textHeight(strokes))
    if (!seg.lines.length) return 0
    // Lignes penchées : redressées autour de leur centre avant la lecture
    const straight = seg.lines.map((l) => {
      const cx = (l.box.x0 + l.box.x1) / 2
      const cy = (l.box.y0 + l.box.y1) / 2
      const st = rotate(l.strokes.map((i) => strokes[i]), -l.angle, cx, cy)
      return { strokes: st, box: boxOfStrokes(st), cx, cy }
    })
    const results = await handwriting.recognize(straight.map((l) => l.strokes))
    const made: { box: HwrBox; inks: InkObject[] }[] = []
    seg.lines.forEach((line, k) => {
      const cands = results[k] ?? []
      const best = cands[0]
      if (!best || !accept(best, line.strokes.length, manual)) return
      const inks = line.strokes.map((i) => alive[i]).filter((o) => this.ed.canvas.getObjects().includes(o))
      if (!inks.length) return
      const color = inks[0].ink?.color ?? settings.value.penColor
      const st = straight[k]
      const box = this.textFor(best.text, st.box, color, cands)
      // Écriture nettement en biais (plus de 12°) : le texte suit la même pente.
      if (Math.abs(line.angle) > 0.21) {
        box.set({ angle: (line.angle * 180) / Math.PI })
        box.setPositionByOrigin(new Point(st.cx, st.cy), 'center', 'center')
      }
      made.push({ box, inks })
    })
    if (!made.length) return 0
    await this.ed.history.transaction(() => {
      for (const { box, inks } of made) {
        for (const o of inks) this.ed.canvas.remove(o)
        this.ed.add(box)
        this.sources.set(box, inks)
      }
    })
    this.ed.canvas.requestRenderAll()
    this.showChip(made[made.length - 1].box)
    return made.length
  }

  /** Zone de texte à la place de l'écriture : même hauteur de lettres, même ligne de base. */
  private textFor(text: string, ink: Box, color: string, cands: Candidate[]): HwrBox {
    const family = settings.value.fontFamily || 'Helvetica'
    const ctx = measureCtx()
    ctx.font = `100px "${family}"`
    const m = ctx.measureText(text)
    const hb = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
    const fs = Math.min(200, Math.max(6, hb > 1 ? ((ink.y1 - ink.y0) * 100) / hb : ink.y1 - ink.y0))
    const k = fs / 100
    // Ligne de base de l'écriture : bas de l'encre moins la partie sous la ligne (jambages).
    const baseline = ink.y1 - m.actualBoundingBoxDescent * k
    const box = new Textbox(text, {
      left: ink.x0 - m.actualBoundingBoxLeft * k,
      top: baseline - fs * 1.13 * (1 - 0.222),
      width: Math.max(m.width * k + fs * 0.3, ink.x1 - ink.x0),
      fontSize: Math.round(fs * 10) / 10,
      fontFamily: family,
      fill: color,
      strokeWidth: 0
    }) as HwrBox
    box.hwr = { alts: cands.map((c) => c.text).filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 4) }
    return box
  }

  // --- Barre de propositions -----------------------------------------------------------

  private chipFor: HwrBox | null = null

  private showChip(box: HwrBox): void {
    this.chipFor = box
    this.chip.replaceChildren()
    const alts = (box.hwr?.alts ?? []).filter((t) => t !== box.text)
    for (const t of alts.slice(0, 3)) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'hwr-alt'
      b.textContent = t
      b.title = 'Remplacer par cette lecture'
      b.addEventListener('click', () => void this.replace(box, t))
      this.chip.append(b)
    }
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'hwr-back'
    back.textContent = '↶ Encre'
    back.title = 'Revenir à l’écriture manuscrite'
    back.addEventListener('click', () => void this.revert(box))
    this.chip.append(back)
    this.chip.hidden = false
    this.placeChip()
  }

  private hideChip(): void {
    this.chip.hidden = true
    this.chipFor = null
  }

  private placeChip(): void {
    const b = this.chipFor
    if (!b || this.chip.hidden) return
    if (!this.ed.canvas.getObjects().includes(b)) return this.hideChip()
    const v = this.ed.canvas.viewportTransform
    const r = b.getBoundingRect()
    Object.assign(this.chip.style, { left: `${r.left * v[0] + v[4]}px`, top: `${(r.top + r.height) * v[3] + v[5] + 6}px` })
  }

  private async replace(box: HwrBox, text: string): Promise<void> {
    await this.ed.history.transaction(() => {
      box.set({ text })
      box.initDimensions()
      this.ed.history.touch(box)
    })
    this.ed.canvas.requestRenderAll()
    this.showChip(box)
  }

  /** Retour à l'écriture : les traits d'origine reviennent, le texte part. */
  async revert(box: Textbox): Promise<void> {
    const inks = this.sources.get(box)
    if (!inks) return
    await this.ed.history.transaction(() => {
      this.ed.canvas.remove(box)
      for (const o of inks) this.ed.add(o)
    })
    this.hideChip()
    this.ed.canvas.requestRenderAll()
  }
}

/**
 * Lecture assez sûre pour remplacer l'écriture ? (sinon l'encre reste : mieux vaut ne rien
 * faire que remplacer un dessin ou un mot illisible par n'importe quoi). Seuil par caractère
 * de la log-probabilité, plus souple quand on demande soi-même la conversion.
 */
export function accept(c: Candidate, strokes: number, manual: boolean): boolean {
  const n = [...c.text.replace(/\s/g, '')].length
  if (!n) return false
  if (c.conf !== undefined) return c.conf > (manual ? 0.35 : 0.6) && !(strokes >= 6 && n === 1)
  const perChar = c.score / n
  // Modèle intégré (peu fiable sur une vraie écriture) : en automatique, seulement une lecture
  // très sûre d'au moins deux caractères ; « Convertir en texte » reste plus souple.
  if (!manual) return perChar > -0.5 && n >= 2
  return perChar > -2.2 && !(strokes >= 6 && n === 1)
}

let ctx2d: CanvasRenderingContext2D | null = null
const measureCtx = (): CanvasRenderingContext2D => (ctx2d ??= document.createElement('canvas').getContext('2d')!)

const boxOfStrokes = (strokes: Stroke[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const st of strokes) for (const [x, y] of st) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}
