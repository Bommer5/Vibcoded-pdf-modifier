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
  // Réglages connus (ils sont mémorisés d'une session à l'autre).
  await win.evaluate(() => { (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()); window.__feuillet.settings.set('penWidth', 2.5) })
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

  // 6. On n'écrit pas en dehors des pages
  await win.evaluate(() => { const { canvas, doc } = window.__feuillet.editor; canvas.discardActiveObject(); canvas.remove(...doc.content) })
  const pg = await win.evaluate(() => { const p = window.__feuillet.editor.doc.pages[0]; return { w: p.width, h: p.height } })
  await win.keyboard.press('KeyP')
  ;[x, y] = await P(-60, 300) // à gauche de la page
  await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x + 40, y + 30, { steps: 5 }); await win.mouse.up()
  check('pen stroke starting outside the page draws nothing', (await count()) === 0)
  // Trait qui sort de la page puis y revient : coupé au bord, rien dehors, une seule annulation
  const [s1, s2] = await P(pg.w - 100, 200), [o1, o2] = await P(pg.w + 80, 250), [r1, r2] = await P(pg.w - 100, 300)
  await win.mouse.move(s1, s2); await win.mouse.down(); await win.mouse.move(o1, o2, { steps: 10 }); await win.mouse.move(r1, r2, { steps: 10 }); await win.mouse.up()
  const parts = await win.evaluate(() => {
    const { doc } = window.__feuillet.editor
    const p = doc.pages[0]
    return doc.content.map((o) => { const pts = o.ink?.points ?? []; return pts.every(([x, y]) => x >= p.left - 0.01 && x <= p.left + p.width + 0.01 && y >= p.top && y <= p.top + p.height) })
  })
  check('stroke leaving the page is cut at the edge (2 pieces, nothing outside)', parts.length === 2 && parts.every(Boolean), JSON.stringify(parts))
  await win.keyboard.press('Control+z'); await win.waitForTimeout(150)
  check('one undo removes the whole gesture', (await count()) === 0, `n=${await count()}`)
  // Forme tirée au-delà du bord : elle s'arrête au bord
  await win.evaluate(() => window.__feuillet.settings.set('shape', 'rect'))
  await win.keyboard.press('KeyR')
  ;[x, y] = await P(pg.w - 150, 400)
  const [ex, ey] = await P(pg.w + 120, 480)
  await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(ex, ey, { steps: 6 }); await win.mouse.up()
  const right = await win.evaluate(() => { const { doc } = window.__feuillet.editor; const o = doc.content.at(-1); const p = doc.pages[0]; return [o.left + o.getScaledWidth() - o.strokeWidth, p.left + p.width] })
  check('shape stops at the page edge', right[0] <= right[1] + 0.5, JSON.stringify(right))
  // Texte : un clic hors de la page ne crée rien
  await win.keyboard.press('KeyT')
  const before6 = await count()
  ;[x, y] = await P(pg.w + 60, 100)
  await win.mouse.click(x, y)
  check('text tool does nothing outside the page', (await count()) === before6 && !(await win.evaluate(() => window.__feuillet.editor.canvas.getActiveObject()?.isEditing)))
  await win.keyboard.press('Escape')
  // Formes : choix visible dans la barre rapide (indispensable sur téléphone)
  await win.keyboard.press('KeyR')
  const kinds = await win.locator('.quickbar .qb-shape').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
  check('shape choices in the quick bar', kinds.join() === 'Ligne,Flèche,Rectangle,Ellipse,Triangle,Remplissage', kinds.join())
  await win.locator('.quickbar .qb-shape[aria-label=Ellipse]').click()
  check('pick ellipse from the quick bar', (await win.evaluate(() => window.__feuillet.settings.value.shape)) === 'ellipse')
  await win.locator('.quickbar .qb-shape[aria-label=Remplissage]').click()
  check('fill toggle', /^rgba/.test(await win.evaluate(() => window.__feuillet.settings.value.shapeFill)))
  await win.locator('.quickbar .qb-shape[aria-label=Remplissage]').click()
  await win.keyboard.press('KeyV')

  // 7. Info-bulle soignée avec le raccourci
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
