// Finitions : accueil, préférences (touche de zoom personnalisée), thème clair, PDF protégés.
// Utilisation : xvfb-run -a node tests/e2e/polish.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), os = require('os')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const fixture = (n) => path.join(root, 'tests/fixtures', n)

;(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'feuillet-ud-'))
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox', `--user-data-dir=${userData}`] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => (window.confirm = () => true))

  // Accueil
  await win.waitForSelector('.welcome:not([hidden])')
  await win.screenshot({ path: path.join(outDir, 'p1-welcome.png') })
  await win.click('.welcome-papers button:has-text("Petits carreaux")')
  await win.click('.welcome [data-w=new]')
  const bg = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].bg)
  check('welcome: new document on squared paper', bg.kind === 'paper' && bg.style === 'graph', JSON.stringify(bg))
  check('welcome closes', await win.locator('.welcome').isHidden())

  // Préférences : la touche « Q » devient « zoom avant »
  await win.keyboard.press('Control+Comma')
  await win.waitForSelector('.prefs[open]')
  await win.locator('.key-row', { hasText: 'Zoom avant' }).locator('button:has-text("Modifier")').click()
  await win.keyboard.press('KeyQ')
  await win.screenshot({ path: path.join(outDir, 'p2-prefs.png') })
  await win.click('.prefs button[value=ok]')
  const before = await win.locator('#zoom-label').textContent()
  await win.mouse.move(600, 400)
  await win.keyboard.press('KeyQ')
  const after = await win.locator('#zoom-label').textContent()
  check('custom zoom key works', parseInt(after) > parseInt(before), `${before} → ${after}`)

  // Thème clair
  await win.keyboard.press('Control+Comma')
  await win.click('.prefs [data-tab=general]')
  await win.selectOption('.prefs [name=theme]', 'light')
  const panelColor = await win.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor)
  check('light theme', panelColor === 'rgb(255, 255, 255)', panelColor)
  await win.click('.prefs button[value=ok]')
  await win.screenshot({ path: path.join(outDir, 'p3-light.png') })

  // PDF avec mot de passe d'ouverture : fenêtre de saisie, mauvais puis bon mot de passe.
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), fixture('protected.pdf'))
  await win.click('.menu-button >> text=Fichier')
  await win.click('.menu-item >> text=Ouvrir…')
  await win.waitForTimeout(2500)
  await win.waitForSelector('dialog[open] input[type=password]')
  await win.fill('dialog[open] input[type=password]', 'faux')
  await win.keyboard.press('Enter')
  await win.waitForSelector('dialog[open] p:has-text("incorrect")')
  check('wrong password asked again', true)
  await win.fill('dialog[open] input[type=password]', 'secret')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => window.__feuillet.editor.doc.pages.length === 3, null, { timeout: 15000 })
  check('password-protected PDF opens', true)
  // L'export fonctionne (copie déverrouillée) et le texte est lisible.
  const exported = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    return u.length
  })
  check('protected PDF exports', exported > 1000, `${exported} octets`)

  // PDF avec restrictions seulement (sans mot de passe d'ouverture) : s'ouvre directement.
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), fixture('restricted.pdf'))
  await win.click('.menu-button >> text=Fichier')
  await win.click('.menu-item >> text=Ouvrir…')
  await win.waitForFunction(() => window.__feuillet.editor.doc.pages.length === 3 && document.title.includes('restricted'), null, { timeout: 15000 })
  const words = await win.evaluate(async () => {
    const page = window.__feuillet.editor.doc.pages[0]
    return (await window.__feuillet.textSelection.snapStroke([[page.left + 70, page.top + 85], [page.left + 300, page.top + 85]], page))?.length ?? 0
  })
  check('restricted PDF opens without prompt (text readable)', words > 0, `mots=${words}`)

  // Icône de l'application
  check('app icon present', fs.existsSync(path.join(root, 'build/icon.png')) && fs.existsSync(path.join(root, 'build/icon.ico')))

  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
