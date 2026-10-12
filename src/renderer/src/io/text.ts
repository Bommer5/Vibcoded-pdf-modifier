import { Textbox } from 'fabric'
import { PAGE_SIZES, type DocumentModel, type Page } from '../core/document'

export const TEXT_EXT = ['txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf']

const MARGIN = 56
const FONT_SIZE = 11
const LINE_HEIGHT = 1.3

export function decodeText(data: Uint8Array): string {
  // UTF-8 (avec ou sans BOM), sinon Windows-1252 pour les vieux fichiers Windows.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(data)
  }
}

export function textBox(text: string, left: number, top: number, width: number): Textbox {
  return new Textbox(text, {
    left,
    top,
    width,
    fontFamily: 'Helvetica',
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    fill: '#1b1b1f',
    splitByGrapheme: false
  })
}

/** Met en page un texte brut sur des feuilles A4 (une zone de texte modifiable par page). */
export async function importTextAsPages(
  text: string,
  doc: DocumentModel,
  add: (o: Textbox) => void,
  after?: Page
): Promise<Page[]> {
  const size = PAGE_SIZES.A4
  const width = size.width - MARGIN * 2
  const maxHeight = size.height - MARGIN * 2
  const pages: Page[] = []
  let remaining = text.replace(/\r\n?/g, '\n').split('\n')

  while (remaining.length > 0 || pages.length === 0) {
    const page = await doc.addPage(size, { after: pages.at(-1) ?? after })
    pages.push(page)
    // Remplit la page ligne par ligne jusqu'à la hauteur disponible (lignes renvoyées comprises).
    const box = textBox('', page.left + MARGIN, page.top + MARGIN, width)
    let count = 0
    while (count < remaining.length) {
      box.set({ text: remaining.slice(0, count + 1).join('\n') })
      box.initDimensions()
      if (box.height > maxHeight && count > 0) break
      count++
    }
    box.set({ text: remaining.slice(0, count).join('\n') })
    box.initDimensions()
    remaining = remaining.slice(count)
    if (box.text) add(box)
  }
  return pages
}
