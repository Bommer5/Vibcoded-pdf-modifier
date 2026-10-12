// Interface : barre d'outils rangée par usage avec libellés, pavé tactile (deux doigts),
// panneau Page (format, orientation, fond), astuces qu'on ferme une fois pour toutes.
// Utilisation : xvfb-run -a node tests/e2e/ui.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => { window.__feuillet.welcome?.hide(); Object.keys(localStorage).filter((k) => k.startsWith('feuillet.tips.')).forEach((k) => localStorage.removeItem(k)) })
  await win.keyboard.press('KeyV')

  // 1. Barre d'outils : les outils courants d'abord, chacun avec son nom
  const tools = await win.locator('#toolbar button').evaluateAll((b) => b.map((x) => x.querySelector('.btn-label')?.textContent))
  check('most used tools first', tools.slice(0, 5).join() === 'Sélection,Stylo,Surligneur,Gomme,Texte', tools.join())
  check('every tool has a visible label', tools.every(Boolean) && (await win.locator('#toolbar .btn-label').first().isVisible()), tools.join())
  check('lasso and hand at the end', tools.slice(-2).join() === 'Lasso,Main', tools.join())

  // 2. Pavé tactile : deux doigts = déplacer dans tous les sens, pincer = zoom
  const ws = await win.locator('#workspace').boundingBox()
  await win.mouse.move(ws.x + ws.width / 2, ws.y + ws.height / 2)
  const vpt = () => win.evaluate(() => [...window.__feuillet.editor.canvas.viewportTransform])
  let v0 = await vpt()
  await win.mouse.wheel(40, 60)
  await win.waitForTimeout(100)
  let v1 = await vpt()
  check('two-finger scroll pans both ways', Math.abs(v1[4] - (v0[4] - 40)) < 1 && Math.abs(v1[5] - (v0[5] - 60)) < 1, JSON.stringify([v0.slice(4), v1.slice(4)]))
  for (let i = 0; i < 30; i++) await win.mouse.wheel(0, 3000)
  await win.waitForTimeout(100)
  const visible = await win.evaluate(() => {
    const { canvas, doc } = window.__feuillet.editor
    const b = doc.bounds(), v = canvas.viewportTransform
    const top = b.top * v[3] + v[5], bottom = (b.top + b.height) * v[3] + v[5]
    return bottom > 100 && top < canvas.getHeight()
  })
  check('the document can never be scrolled out of sight', visible)
  await win.evaluate(() => window.__feuillet.editor.viewport.fit(window.__feuillet.editor.doc.bounds()))
  const z0 = await win.evaluate(() => window.__feuillet.editor.viewport.zoom)
  await win.keyboard.down('Control'); await win.mouse.wheel(0, -50); await win.keyboard.up('Control')
  await win.waitForTimeout(100)
  const z1 = await win.evaluate(() => window.__feuillet.editor.viewport.zoom)
  check('pinch (Ctrl+wheel) zooms in smoothly', z1 > z0 * 1.05 && z1 < z0 * 1.5, `${z0} -> ${z1}`)

  // 3. Panneau Page quand rien n'est sélectionné
  await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  await win.evaluate(() => window.__feuillet.properties.render())
  check('page panel shown with nothing selected', /Page 1 sur 1/i.test(await win.locator('.properties').innerText()))
  await win.locator('.properties button', { hasText: 'Paysage' }).click()
  let page = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; return [Math.round(p.width), Math.round(p.height)] })
  check('orientation: landscape', page[0] === 842 && page[1] === 595, JSON.stringify(page))
  await win.locator('.properties label', { hasText: 'Format' }).locator('select').selectOption({ label: 'A5 (148 × 210 mm)' })
  page = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; return [Math.round(p.width), Math.round(p.height)] })
  check('format A5 keeps landscape', page[0] === 595 && page[1] === 420, JSON.stringify(page))
  await win.locator('.properties label', { hasText: 'Fond' }).locator('select').selectOption({ label: 'Petits carreaux' })
  check('paper style', await win.evaluate(() => window.__feuillet.editor.doc.pages[0].bg.style === 'graph'))
  await win.keyboard.press('Control+z'); await win.waitForTimeout(150)
  await win.keyboard.press('Control+z'); await win.waitForTimeout(150)
  page = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; return [Math.round(p.width), Math.round(p.height), p.bg.kind] })
  check('page changes are undoable', page[0] === 842 && page[2] === 'blank', JSON.stringify(page))
  await win.locator('.properties button', { hasText: 'Ajouter une page' }).click()
  check('add a page from the panel', (await win.evaluate(() => window.__feuillet.editor.doc.pages.length)) === 2)
  await win.screenshot({ path: path.join(outDir, 'ui-page-panel.png') })

  // 4. Astuces : visibles au début, « Compris » les retire pour de bon
  check('tip shown the first time', await win.locator('.properties .tips').isVisible())
  await win.locator('.properties .tips-ok').click()
  await win.evaluate(() => window.__feuillet.properties.render())
  check('tip gone after « Compris », even after re-render', (await win.locator('.properties .tips').count()) === 0)
  await win.keyboard.press('KeyP')
  check('other tools keep their own first-time tip', (await win.locator('.properties .tips').count()) === 1)
  check('status bar explains the active tool', /Maj : ligne droite/.test(await win.locator('#tool-hint').innerText()))

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
