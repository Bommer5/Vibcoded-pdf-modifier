import { enterSubmitsPrimary } from './dialog-keys'

/** Zone choisie, en fractions de la page (0 à 1), coin haut-gauche + taille. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CropSource {
  /** Nombre de pages (1 pour une image). */
  count: number
  /** Rendu d'une page, côté le plus long ≈ `maxPx` pixels. */
  render(index: number, maxPx: number): Promise<HTMLCanvasElement | null>
}

export interface CropChoice {
  index: number
  rect: CropRect
}

const MIN = 0.01
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v))

/**
 * Choisir une partie d'une page (un exercice dans un long PDF, un détail d'une photo) :
 * on glisse sur la page pour l'entourer, puis on ajuste les coins ou on déplace le cadre.
 * Pages précédente / suivante pour un PDF de plusieurs pages. Doigt, stylet ou souris.
 */
export function askCrop(title: string, action: string, src: CropSource, start: { index: number; rect?: CropRect } = { index: 0 }): Promise<CropChoice | null> {
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog crop-dialog'
  dialog.innerHTML = `
    <form method="dialog">
      <h2></h2>
      <p class="muted small crop-hint">Glissez sur la page pour entourer la partie à garder, puis ajustez les coins.</p>
      <div class="crop-stage">
        <div class="crop-page">
          <div class="crop-rect" hidden>
            <span class="crop-handle" data-corner="nw"></span><span class="crop-handle" data-corner="ne"></span>
            <span class="crop-handle" data-corner="sw"></span><span class="crop-handle" data-corner="se"></span>
          </div>
        </div>
      </div>
      <div class="crop-bar">
        <span class="crop-nav">
          <button type="button" class="crop-prev" aria-label="Page précédente">‹</button>
          <span>Page <input class="crop-num" type="number" min="1" inputmode="numeric" /> / <span class="crop-count"></span></span>
          <button type="button" class="crop-next" aria-label="Page suivante">›</button>
        </span>
        <button type="button" class="crop-all">Toute la page</button>
      </div>
      <menu>
        <button value="cancel" formnovalidate>Annuler</button>
        <button value="ok" class="primary crop-ok"></button>
      </menu>
    </form>`
  const $ = <T extends Element>(sel: string): T => dialog.querySelector(sel) as T
  $('h2').textContent = title
  $('.crop-ok').textContent = action
  const stage = $<HTMLElement>('.crop-stage')
  const pageEl = $<HTMLElement>('.crop-page')
  const box = $<HTMLElement>('.crop-rect')
  const num = $<HTMLInputElement>('.crop-num')
  const ok = $<HTMLButtonElement>('.crop-ok')
  $('.crop-count').textContent = String(src.count)
  num.max = String(src.count)
  $<HTMLElement>('.crop-nav').hidden = src.count < 2

  let index = clamp(start.index, 0, src.count - 1)
  let rect: CropRect | null = start.rect ?? null
  let token = 0

  const show = (): void => {
    box.hidden = !rect
    ok.disabled = !rect
    if (!rect) return
    Object.assign(box.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` })
  }

  const load = async (i: number): Promise<void> => {
    index = i
    num.value = String(i + 1)
    $<HTMLButtonElement>('.crop-prev').disabled = i === 0
    $<HTMLButtonElement>('.crop-next').disabled = i === src.count - 1
    const mine = ++token
    pageEl.classList.add('loading')
    const max = Math.round(Math.max(stage.clientWidth, stage.clientHeight, 600) * Math.min(2, devicePixelRatio || 1))
    const canvas = await src.render(i, max).catch(() => null)
    if (mine !== token) return
    pageEl.classList.remove('loading')
    pageEl.querySelector('canvas')?.remove()
    if (!canvas) return
    canvas.className = 'crop-canvas'
    pageEl.prepend(canvas)
    // La page tient entière dans la zone, proportions gardées.
    const k = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height)
    pageEl.style.width = `${Math.floor(canvas.width * k)}px`
    pageEl.style.height = `${Math.floor(canvas.height * k)}px`
    show()
  }
  const go = (i: number): void => {
    if (i === index || i < 0 || i >= src.count) return
    rect = null
    void load(i)
  }
  $('.crop-prev').addEventListener('click', () => go(index - 1))
  $('.crop-next').addEventListener('click', () => go(index + 1))
  num.addEventListener('change', () => go(clamp(Math.round(Number(num.value)) - 1, 0, src.count - 1)))
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      num.dispatchEvent(new Event('change'))
    }
  })
  $('.crop-all').addEventListener('click', () => {
    rect = { x: 0, y: 0, w: 1, h: 1 }
    show()
  })

  // Glisser : nouveau cadre, déplacement du cadre, ou un coin.
  let drag: { mode: 'new' | 'move' | string; x0: number; y0: number; start: CropRect; id: number } | null = null
  const at = (e: PointerEvent): [number, number] => {
    const r = pageEl.getBoundingClientRect()
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]
  }
  pageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    const [x, y] = at(e)
    const corner = (e.target as HTMLElement).dataset.corner
    const mode = corner ?? (rect && e.target === box ? 'move' : 'new')
    if (mode === 'new') rect = { x, y, w: 0, h: 0 }
    drag = { mode, x0: x, y0: y, start: { ...rect! }, id: e.pointerId }
    pageEl.setPointerCapture(e.pointerId)
    show()
  })
  pageEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const [x, y] = at(e)
    const s = drag.start
    if (drag.mode === 'new') {
      rect = { x: Math.min(drag.x0, x), y: Math.min(drag.y0, y), w: Math.abs(x - drag.x0), h: Math.abs(y - drag.y0) }
    } else if (drag.mode === 'move') {
      rect = { ...s, x: clamp(s.x + x - drag.x0, 0, 1 - s.w), y: clamp(s.y + y - drag.y0, 0, 1 - s.h) }
    } else {
      // Coin tiré : le coin opposé reste en place.
      const left = drag.mode.includes('w') ? Math.min(x, s.x + s.w - MIN) : s.x
      const right = drag.mode.includes('e') ? Math.max(x, s.x + MIN) : s.x + s.w
      const top = drag.mode.includes('n') ? Math.min(y, s.y + s.h - MIN) : s.y
      const bottom = drag.mode.includes('s') ? Math.max(y, s.y + MIN) : s.y + s.h
      rect = { x: left, y: top, w: right - left, h: bottom - top }
    }
    show()
  })
  const end = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    drag = null
    // Simple toucher sans glisser : pas de cadre minuscule.
    if (rect && (rect.w < MIN || rect.h < MIN)) rect = null
    show()
  }
  pageEl.addEventListener('pointerup', end)
  pageEl.addEventListener('pointercancel', end)

  document.body.append(dialog)
  enterSubmitsPrimary(dialog)
  dialog.showModal()
  requestAnimationFrame(() => void load(index))
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(dialog.returnValue === 'ok' && rect ? { index, rect } : null)
    })
  })
}
