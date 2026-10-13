import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Types proposés dans « Ouvrir avec » (mêmes que electron-builder.yml). */
const MIME = [
  'application/pdf', 'application/x-feuillet', 'application/x-xopp', 'application/x-xojpp',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/vnd.oasis.opendocument.text', 'application/rtf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation'
]

const MIME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-feuillet">
    <comment>Projet Feuillet</comment>
    <comment xml:lang="fr">Projet Feuillet</comment>
    <glob pattern="*.feuillet"/>
  </mime-type>
</mime-info>
`

/**
 * Linux, application lancée depuis une AppImage : elle n'apparaît nulle part (pas d'icône dans
 * le menu, impossible de l'épingler, absente de « Ouvrir avec »). Au lancement, Feuillet
 * s'inscrit donc pour l'utilisateur : lanceur (~/.local/share/applications/feuillet.desktop,
 * même nom que celui du paquet .deb, pour que le dock reconnaisse la fenêtre), icône et type
 * .feuillet. Le chemin de l'AppImage est remis à jour si on la déplace.
 */
export async function integrateAppImage(resources: string): Promise<void> {
  const appImage = process.env.APPIMAGE
  if (process.platform !== 'linux' || !appImage) return
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const apps = join(data, 'applications')
  const desktop = join(apps, 'feuillet.desktop')
  const exec = `"${appImage.replace(/(["`$\\])/g, '\\$1')}" %F`
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Feuillet',
    'GenericName=Éditeur de PDF',
    'Comment=Annoter et modifier PDF, documents et images',
    `Exec=${exec}`,
    'TryExec=' + appImage,
    'Icon=feuillet',
    'Terminal=false',
    'StartupWMClass=Feuillet',
    'StartupNotify=true',
    'Categories=Graphics;Office;Viewer;',
    'Keywords=pdf;annotation;tablette;stylet;dessin;',
    `MimeType=${MIME.join(';')};`,
    'X-Feuillet-AppImage=true',
    ''
  ].join('\n')
  const current = await readFile(desktop, 'utf8').catch(() => '')
  // Un lanceur personnel écrit à la main (sans notre marque) est laissé tel quel.
  if (current && !current.includes('X-Feuillet-AppImage=true')) return
  if (current === entry) return
  const icons = join(data, 'icons', 'hicolor', '512x512', 'apps')
  const mime = join(data, 'mime', 'packages')
  await Promise.all([mkdir(apps, { recursive: true }), mkdir(icons, { recursive: true }), mkdir(mime, { recursive: true })])
  await copyFile(join(resources, 'icon.png'), join(icons, 'feuillet.png')).catch(() => {})
  await writeFile(join(mime, 'feuillet.xml'), MIME_XML)
  await writeFile(desktop, entry, { mode: 0o755 })
  // Mise à jour des index (outils facultatifs : absents, le bureau relit les dossiers lui-même)
  const run = (cmd: string, args: string[]): void => void execFile(cmd, args, () => {})
  run('update-desktop-database', [apps])
  run('update-mime-database', [join(data, 'mime')])
  run('gtk-update-icon-cache', ['-f', '-t', join(data, 'icons', 'hicolor')])
}
