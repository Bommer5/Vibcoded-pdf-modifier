import {
  BringToFront, ChartColumn, ClipboardPaste, Crop, Copy, CopyPlus, Eraser, FilePenLine, Group, Hand, Highlighter, Image, Lasso, Layers,
  Circle, Lightbulb, Lock, LockOpen, Menu, MousePointer2, MoveUpRight, PaintBucket, Slash, Square, Triangle, PanelLeft, PenLine, Plus, Redo2, ScanText, Scissors, Search, SendToBack, Settings, Shapes,
  SlidersHorizontal, Table, Trash, Type, Undo2, Ungroup, ZoomIn, ZoomOut, type IconNode
} from 'lucide'

/**
 * Icônes de l'interface : jeu Lucide (licence ISC), au trait, homogène — même style que
 * les applications modernes (Fluent / Office, Figma, Notion). Seules les icônes listées
 * ici sont intégrées à l'application (quelques Ko).
 */
const ICONS = {
  select: MousePointer2,
  lasso: Lasso,
  hand: Hand,
  textselect: ScanText,
  edittext: FilePenLine,
  pen: PenLine,
  highlighter: Highlighter,
  eraser: Eraser,
  shape: Shapes,
  text: Type,
  table: Table,
  chart: ChartColumn,
  image: Image,
  crop: Crop,
  undo: Undo2,
  redo: Redo2,
  find: Search,
  menu: Menu,
  sidebar: PanelLeft,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  settings: Settings,
  props: SlidersHorizontal,
  copy: Copy,
  cut: Scissors,
  paste: ClipboardPaste,
  duplicate: CopyPlus,
  group: Group,
  ungroup: Ungroup,
  front: BringToFront,
  back: SendToBack,
  delete: Trash,
  add: Plus,
  layers: Layers,
  lock: Lock,
  unlock: LockOpen,
  tip: Lightbulb,
  'shape-line': Slash,
  'shape-arrow': MoveUpRight,
  'shape-rect': Square,
  'shape-ellipse': Circle,
  'shape-triangle': Triangle,
  fill: PaintBucket
} satisfies Record<string, IconNode>

export type IconName = keyof typeof ICONS

const escape = (v: string | number): string => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** SVG d'une icône (20 px par défaut, trait 1,75 : net sur écrans standard et haute densité). */
export function icon(name: IconName, size = 20): string {
  const body = ICONS[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escape(v as string)}"`).join(' ')}/>`).join('')
  return `<svg class="ico" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** Remplit chaque élément `[data-icon]` de la page avec son icône (le libellé reste pour l'accessibilité). */
export function applyIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon as IconName
    if (!(name in ICONS)) continue
    const label = el.dataset.label
    el.innerHTML = icon(name) + (label ? `<span class="btn-label">${label}</span>` : '')
  }
}
