// Fichiers : Ctrl+S dans le PDF ouvert (« PDF modifiable »), réouverture, récents, récupération.
// Utilisation : xvfb-run -a node tests/e2e/files.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'feuillet-ud-'))

async function launch() {
  const app = await _electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [root, '--no-sandbox', `--user-data-dir=${userData}`]
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => (window.confirm = () => true))
  return { app, win }
}

;(async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) pdf.addPage([595.28, 841.89]).drawText(`Texte original page ${i}`, { x: 60, y: 760, size: 14, font })
  const file = path.join(outDir, 'cours.pdf')
  fs.writeFileSync(file, await pdf.save())
  const originalSize = fs.statSync(file).size

  let { app, win } = await launch()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  // Boîte « Ouvrir » simulée : renvoie notre fichier.
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), file)
  await win.click('.menu-button >> text=Fichier')
  await win.click('.menu-item >> text=Ouvrir…')
  await win.waitForFunction(() => window.__feuillet.editor.doc.pages.length === 3)
  const box = await win.locator('#workspace').boundingBox()
  await win.keyboard.press('KeyP')
  await win.mouse.move(box.x + 400, box.y + 300); await win.mouse.down(); await win.mouse.move(box.x + 520, box.y + 340, { steps: 6 }); await win.mouse.up()
  const title = await win.title()
  check('unsaved marker in title', title.startsWith('• cours.pdf'), title)

  // Ctrl+S : réécrit cours.pdf, sans boîte de dialogue.
  await win.keyboard.press('Control+KeyS')
  await win.waitForFunction(() => !document.title.startsWith('•'), null, { timeout: 15000 })
  const saved = fs.readFileSync(file)
  check('Ctrl+S writes the opened PDF in place', saved.length > originalSize, `${originalSize} -> ${saved.length} octets`)
  const txt = execFileSync('pdftotext', [file, '-']).toString()
  check('saved PDF readable everywhere (original text kept)', txt.includes('Texte original page 1') && txt.includes('page 3'))
  const recent = await win.evaluate(() => window.__feuillet.fileSession.recent.map((r) => r.name))
  check('recent files', recent.includes('cours.pdf'), JSON.stringify(recent))
  await app.close()

  // Réouverture : le projet joint est retrouvé → le trait est un objet modifiable (pas aplati).
  ;({ app, win } = await launch())
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), file)
  await win.click('.menu-button >> text=Fichier')
  await win.click('.menu-item >> text=Ouvrir…')
  await win.waitForFunction(() => window.__feuillet.editor.doc.pages.length === 3)
  await win.waitForTimeout(300)
  const objs = await win.evaluate(() => window.__feuillet.editor.doc.content.map((o) => !!o.ink))
  check('reopened PDF: annotations still editable objects', objs.length === 1 && objs[0], JSON.stringify(objs))
  // Récents dans le menu
  await win.click('.menu-button >> text=Fichier')
  const hasRecent = await win.locator('.menu-item >> text=cours.pdf').count()
  check('recent file listed in File menu', hasRecent > 0)
  await win.keyboard.press('Escape')

  // Sauvegarde automatique puis « plantage » (fermeture forcée) → proposition de restauration.
  await win.keyboard.press('KeyP')
  await win.mouse.move(box.x + 400, box.y + 450); await win.mouse.down(); await win.mouse.move(box.x + 520, box.y + 480, { steps: 6 }); await win.mouse.up()
  await win.evaluate(() => window.__feuillet.fileSession.autosave())
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  ;({ app, win } = await launch())
  const restore = win.locator('.toast button:has-text("Restaurer")')
  await restore.waitFor({ timeout: 10000 })
  await restore.click()
  await win.waitForFunction(() => window.__feuillet.editor.doc.content.length === 2, null, { timeout: 10000 })
  check('crash recovery restores unsaved work', true)
  await app.close()

  console.log(results.join('\n'))
  console.log('errors:', errors)
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
