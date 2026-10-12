// Déplacer sans tracer, prendre l'objet du dessous, menu clic droit, verrouillage.
// Utilisation : xvfb-run -a node tests/e2e/selection.cjs <racine> <sortie>
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
  await win.evaluate(() => window.__feuillet.welcome?.hide())
  const box = await win.locator('#workspace').boundingBox()
  // Coordonnées écran d'un point du document
  const screen = async (x, y) => {
    const v = await win.evaluate(() => window.__feuillet.editor.canvas.viewportTransform)
    return [box.x + x * v[0] + v[4], box.y + y * v[3] + v[5]]
  }
  const page = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; return { left: p.left, top: p.top } })
  const P = (x, y) => screen(page.left + x, page.top + y)
  const count = () => win.evaluate(() => window.__feuillet.editor.doc.content.length)
  const active = () => win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o ? (o.shape ?? o.type) + (o.type === 'rect' && o.fill && o.fill !== 'transparent' ? ':' + o.fill : '') : null })
  const add = (spec) => win.evaluate((s) => {
    const { make, editor, tools } = window.__feuillet
    const p = editor.doc.pages[0]
    const o = make.rect({ left: p.left + s.x, top: p.top + s.y, width: s.w, height: s.h, fill: s.fill, stroke: '#000' })
    editor.add(o)
    return editor.doc.content.length
  }, spec)

  // 1. Stylo actif, objet sélectionné : on le déplace, aucun trait
  await add({ x: 100, y: 100, w: 120, h: 80, fill: '#ff0000' })
  await win.keyboard.press('KeyP')
  let [x, y] = await P(160, 140)
  await win.mouse.click(x, y)
  check('pen tap on object selects it (no dot)', (await active()) === 'rect:#ff0000' && (await count()) === 1, String(await active()))
  const before = await win.evaluate(() => window.__feuillet.editor.doc.content[0].left)
  await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x + 60, y + 40, { steps: 6 }); await win.mouse.up()
  const after = await win.evaluate(() => window.__feuillet.editor.doc.content[0].left)
  check('pen drag inside selected object moves it, no stroke', after > before + 20 && (await count()) === 1, `${before} -> ${after}, n=${await count()}`)
  ;[x, y] = await P(400, 400)
  await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x + 80, y + 30, { steps: 6 }); await win.mouse.up()
  check('pen drag elsewhere still draws', (await count()) === 2 && (await active()) === null, `n=${await count()}`)

  // 2. Forme : reste sélectionnée, déplaçable tout de suite
  await win.evaluate(() => window.__feuillet.settings.set('shape', 'rect'))
  await win.keyboard.press('KeyR')
  ;[x, y] = await P(100, 500)
  await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x + 100, y + 60, { steps: 5 }); await win.mouse.up()
  check('new shape is selected', (await active())?.startsWith('rect'), String(await active()))

  // 3. Insérer une image repasse à l'outil Sélection
  await win.keyboard.press('KeyP')
  await win.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 30
    c.getContext('2d').fillRect(0, 0, 40, 30)
    const blob = await new Promise((r) => c.toBlob(r))
    await window.__feuillet.importer.insertImageBlob(blob, null)
  })
  check('inserting an image switches to Select', (await win.evaluate(() => window.__feuillet.tools.tool)) === 'select' && (await active()) === 'image')

  // 4. Objets superposés
  await win.evaluate(() => { const { canvas, doc } = window.__feuillet.editor; canvas.discardActiveObject(); canvas.remove(...doc.content) })
  await add({ x: 300, y: 200, w: 150, h: 150, fill: '#00ff00' })
  await add({ x: 330, y: 230, w: 150, h: 150, fill: '#0000ff' })
  // Trait en diagonale au-dessus de tout : son cadre recouvre les rectangles
  await win.keyboard.press('KeyP')
  const [a1, a2] = await P(250, 150), [b1, b2] = await P(560, 460)
  await win.mouse.move(a1, a2); await win.mouse.down(); await win.mouse.move(b1, b2, { steps: 12 }); await win.mouse.up()
  await win.keyboard.press('KeyV')
  ;[x, y] = await P(460, 250) // dans le cadre du trait, loin du tracé, sur le rectangle bleu
  await win.mouse.click(x, y)
  check('click goes through the bounding box of a stroke', (await active()) === 'rect:#0000ff', String(await active()))
  ;[x, y] = await P(340, 340) // zone commune bleu / vert, loin du tracé du trait
  await win.mouse.click(x, y)
  check('click takes the top object', (await active()) === 'rect:#0000ff', String(await active()))
  await win.keyboard.down('Alt'); await win.mouse.click(x, y); await win.keyboard.up('Alt')
  check('Alt+click takes the object underneath', (await active()) === 'rect:#00ff00', String(await active()))
  await win.keyboard.down('Alt'); await win.mouse.click(x, y); await win.keyboard.up('Alt')
  check('Alt+click again cycles back to the top', (await active()) === 'rect:#0000ff', String(await active()))

  // 5. Menu clic droit
  await win.keyboard.press('Escape')
  await win.mouse.click(x, y, { button: 'right' })
  const items = await win.locator('.ctx-menu .tt-item').evaluateAll((b) => b.map((x) => x.textContent.trim()))
  check('context menu lists the stacked objects', items.filter((t) => t.startsWith('Rectangle')).length === 2, JSON.stringify(items))
  await win.screenshot({ path: path.join(outDir, 'context-menu.png') })
  await win.locator('.ctx-menu .tt-item').nth(1).click()
  check('menu entry selects the lower object', (await active()) === 'rect:#00ff00', String(await active()))
  // Verrouiller le bleu : le clic prend alors le vert
  await win.keyboard.press('Escape')
  await win.mouse.click(x, y)
  await win.mouse.click(x, y, { button: 'right' })
  await win.locator('.ctx-menu .tt-item', { hasText: 'Verrouiller' }).click()
  await win.mouse.click(x, y)
  check('locked object is skipped by clicks', (await active()) === 'rect:#00ff00', String(await active()))
  await win.keyboard.press('Escape')
  await win.mouse.click(x, y, { button: 'right' })
  await win.locator('.ctx-menu .tt-item', { hasText: 'Déverrouiller' }).click()
  check('unlock from the menu', (await active()) === 'rect:#0000ff', String(await active()))
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(150)
  check('lock / unlock are undoable', await win.evaluate(() => window.__feuillet.editor.doc.content.find((o) => o.fill === '#0000ff')?.locked === true))

  // 6. Info-bulle soignée avec le raccourci
  await win.mouse.move(0, 0)
  await win.hover('#toolbar [data-tool=pen]')
  await win.waitForTimeout(600)
  const tip = await win.locator('.tip').innerText().catch(() => '')
  check('toolbar tooltip shows name and shortcut', /Stylo/.test(tip) && /P/.test(tip), JSON.stringify(tip))
  check('toolbar uses SVG icons', (await win.locator('#toolbar svg.ico').count()) >= 12)

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
