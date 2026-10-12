import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Pont vers LibreOffice (MPL 2.0, appelé comme programme externe) :
 * ouvre et produit les formats bureautiques (Word, Excel, PowerPoint,
 * OpenDocument, RTF, EPUB…) avec la meilleure fidélité disponible en open source.
 */
let cached: string | null | undefined

export function findSoffice(): string | null {
  if (cached !== undefined) return cached
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe')
        ]
      : process.platform === 'darwin'
        ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
        : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice']
  cached = candidates.find((p) => existsSync(p)) ?? null
  return cached
}

/** Convertit `data` (fichier nommé `name`) vers l'extension `target` (ex. "pdf", "docx", "odt"). */
export async function convertWithOffice(name: string, data: Uint8Array, target: string): Promise<Uint8Array> {
  if (!/^[a-z]{2,5}(:[\w ]+)?$/.test(target)) throw new Error('Format cible invalide')
  const soffice = findSoffice()
  if (!soffice) throw new Error('LibreOffice introuvable')
  const dir = await mkdtemp(join(tmpdir(), 'feuillet-'))
  try {
    const input = join(dir, basename(name))
    await writeFile(input, data)
    // Profil isolé : ne bloque pas si LibreOffice est déjà ouvert par l'utilisateur.
    const profile = 'file://' + join(dir, 'profile').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
    // Un PDF s'ouvre par défaut dans Draw : pour un traitement de texte, on force l'import Writer.
    const writerTargets = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html']
    const infilter =
      extname(name).toLowerCase() === '.pdf' && writerTargets.includes(target.split(':')[0]) ? ['--infilter=writer_pdf_import'] : []
    await run(
      soffice,
      [`-env:UserInstallation=${profile}`, '--headless', '--norestore', ...infilter, '--convert-to', target, '--outdir', dir, input],
      { timeout: 120_000, windowsHide: true }
    )
    const output = join(dir, basename(name, extname(name)) + '.' + target.split(':')[0])
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
