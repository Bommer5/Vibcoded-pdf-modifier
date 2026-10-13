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

  // 5. Outils PDF compréhensibles
  const labels = await win.locator('#toolbar [data-tool=textselect] .btn-label, #toolbar [data-tool=edittext] .btn-label').allInnerTexts()
  check('PDF tools have explicit names under a « PDF » caption', labels.join() === 'Annoter PDF,Modifier PDF' && (await win.locator('#toolbar .tool-caption').innerText()) === 'PDF', labels.join())
  check('PDF tools greyed out without any PDF', (await win.locator('#toolbar [data-tool=edittext].unavailable').count()) === 1)
  await win.keyboard.press('KeyM')
  await win.waitForSelector('.pdf-guide:not([hidden])')
  let guide = await win.locator('.pdf-guide').innerText()
  check('without PDF the tool explains why nothing happens', /ne contient pas de PDF/.test(guide) && /Écrire du texte/.test(guide), JSON.stringify(guide))
  await win.locator('.pdf-guide button', { hasText: 'Écrire du texte' }).click()
  check('« Écrire du texte » switches to the Text tool', (await win.evaluate(() => window.__feuillet.tools.tool)) === 'text')
  // Avec un PDF
  const { PDFDocument, StandardFonts } = require('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595.28, 841.89]).drawText('Bonjour tout le monde, voici un paragraphe.', { x: 60, y: 760, size: 18, font })
  const b64 = Buffer.from(await pdf.save()).toString('base64')
  await win.evaluate((b) => { window.confirm = () => true; return window.__feuillet.importer.open([{ name: 'doc.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]) }, b64)
  check('PDF tools available once a PDF is open', (await win.locator('#toolbar [data-tool=edittext].unavailable').count()) === 0)
  await win.keyboard.press('KeyM')
  const word = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; const v = window.__feuillet.editor.canvas.viewportTransform; return [(p.left + 120) * v[0] + v[4], (p.top + 841.89 - 765) * v[3] + v[5]] })
  const ws2 = await win.locator('#workspace').boundingBox()
  await win.mouse.move(ws2.x + word[0], ws2.y + word[1], { steps: 3 })
  await win.waitForSelector('.pdf-hover:not([hidden])', { timeout: 5000 }).catch(() => {})
  check('hover frames the paragraph to modify', await win.locator('.pdf-hover:not(.word)').isVisible() && /Cliquer pour modifier/.test(await win.locator('.pdf-hover-label').innerText()))
  guide = await win.locator('.pdf-guide').innerText()
  check('guide tells what to do', /Cliquez/.test(guide) && /Échap/.test(guide), JSON.stringify(guide))
  await win.screenshot({ path: path.join(outDir, 'ui-edit-pdf.png') })
  await win.keyboard.press('KeyX')
  await win.mouse.move(ws2.x + word[0] + 3, ws2.y + word[1], { steps: 2 })
  await win.waitForSelector('.pdf-hover.word:not([hidden])', { timeout: 5000 }).catch(() => {})
  check('Annoter PDF frames the word under the pointer', await win.locator('.pdf-hover.word').isVisible())
  guide = await win.locator('.pdf-guide').innerText()
  check('Annoter PDF guide lists the actions', /Copier/.test(guide) && /Surligner/.test(guide) && /Barrer/.test(guide), JSON.stringify(guide))
  await win.screenshot({ path: path.join(outDir, 'ui-annotate-pdf.png') })
  await win.keyboard.press('KeyV')
  check('guide hidden with other tools', await win.locator('.pdf-guide').isHidden())

  // Main : la vue continue sur sa lancée au lâcher (élan), et s'arrête net si la main reste
  // immobile avant de lâcher ou si on reprend la page.
  await win.evaluate(() => { const { editor, tools } = window.__feuillet; tools.set('hand'); editor.viewport.zoomAt(2, null) })
  const vx = () => win.evaluate(() => window.__feuillet.editor.canvas.viewportTransform[4])
  const cx = ws2.x + ws2.width / 2
  const cy = ws2.y + ws2.height / 2
  await win.mouse.move(cx, cy)
  await win.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await win.mouse.move(cx - i * 25, cy)
    await win.waitForTimeout(8)
  }
  await win.mouse.up()
  const atRelease = await vx()
  await win.waitForTimeout(500)
  const glided = (await vx()) - atRelease
  check('hand: the view keeps gliding after a flick', glided < -20, `${glided.toFixed(1)} px`)
  await win.waitForTimeout(800)
  const settled = await vx()
  await win.waitForTimeout(200)
  check('hand: the glide slows down and stops', Math.abs((await vx()) - settled) < 0.5)
  await win.mouse.move(cx, cy)
  await win.mouse.down()
  await win.mouse.move(cx - 60, cy, { steps: 4 })
  await win.waitForTimeout(200)
  await win.mouse.up()
  const still = await vx()
  await win.waitForTimeout(300)
  check('hand: no glide when the hand stops before releasing', Math.abs((await vx()) - still) < 0.5)
  await win.keyboard.press('KeyV')

  // Pavé tactile : pincer à deux doigts (Ctrl+molette à petits pas) suit l'écartement des doigts,
  // centré sur le pointeur ; un cran de molette avec Ctrl = ~10 %.
  const pinch = (deltas, ctrl = true) => win.evaluate(async ([deltas, ctrl, x, y]) => {
    const { editor } = window.__feuillet
    const host = document.getElementById('workspace')
    const r = host.getBoundingClientRect()
    const before = editor.viewport.zoom
    const v0 = [...editor.canvas.viewportTransform]
    const sceneUnder = [(x - r.left - v0[4]) / v0[0], (y - r.top - v0[5]) / v0[3]]
    for (const d of deltas) {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: d, ctrlKey: ctrl, clientX: x, clientY: y, bubbles: true, cancelable: true }))
      await new Promise((res) => requestAnimationFrame(res))
    }
    await new Promise((res) => requestAnimationFrame(res))
    const v = editor.canvas.viewportTransform
    const drift = Math.hypot(sceneUnder[0] * v[0] + v[4] - (x - r.left), sceneUnder[1] * v[3] + v[5] - (y - r.top))
    return { ratio: editor.viewport.zoom / before, drift }
  }, [deltas, ctrl, cx, cy])
  await win.evaluate(() => window.__feuillet.editor.viewport.zoomAt(1, null))
  // Écartement ×2 en 20 petits pas : somme des deltaY = -100 × ln 2
  const spread = await pinch(Array.from({ length: 20 }, () => (-100 * Math.log(2)) / 20))
  check('touchpad pinch: zoom follows the fingers (×2)', Math.abs(spread.ratio - 2) < 0.06, JSON.stringify(spread))
  check('touchpad pinch: the point under the pointer stays put', spread.drift < 1.5, JSON.stringify(spread))
  const closing = await pinch(Array.from({ length: 10 }, () => (100 * Math.log(2)) / 10))
  check('touchpad pinch: closing the fingers zooms out (÷2)', Math.abs(closing.ratio - 0.5) < 0.03, JSON.stringify(closing))
  const notch = await pinch([100])
  check('Ctrl + mouse wheel notch: one ~10 % step', Math.abs(notch.ratio - 1 / 1.1) < 0.01, JSON.stringify(notch))

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
