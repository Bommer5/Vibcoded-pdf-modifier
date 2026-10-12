// Copie les ressources de pdf.js (polices standard, CMaps, décodeurs WASM)
// dans le dossier public du renderer, pour un fonctionnement 100 % hors ligne.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/pdfjs-dist')
const dest = join(root, 'src/renderer/public/pdfjs')
mkdirSync(dest, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true })
}
console.log('pdf.js assets copied to', dest)
