// Tests des outils : stylo, surligneur, gomme, formes, texte (dont zone libre), tableau, graphique, menus.
// Utilisation : xvfb-run -a node tests/e2e/tools.cjs <racine> <sortie>
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
  const box = await win.locator('#workspace').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const content = () => win.evaluate(() => window.__feuillet.editor.doc.content.map((o) => ({ type: o.type, ink: o.ink && { tool: o.ink.tool, n: o.ink.points.length, style: o.ink.style }, shape: o.shape, opacity: o.opacity, dash: o.strokeDashArray, text: o.text })))
  const drag = async (pts, opts = {}) => {
    await win.mouse.move(...at(...pts[0]))
    await win.mouse.down()
    for (const p of pts.slice(1)) await win.mouse.move(...at(...p), { steps: opts.steps ?? 3 })
    if (opts.hold) await win.waitForTimeout(opts.hold)
    await win.mouse.up()
  }
  const reset = () => win.evaluate(() => { const { canvas, doc } = window.__feuillet.editor; canvas.remove(...doc.content); canvas.discardActiveObject() })

  // Stylo
  await win.keyboard.press('KeyP')
  await drag([[300, 200], [350, 230], [400, 210], [450, 260]])
  let c = await content()
  check('pen stroke has ink data', c.length === 1 && c[0].ink?.tool === 'pen' && c[0].ink.n > 3, JSON.stringify(c[0]?.ink))
  // Maj = ligne droite
  await win.keyboard.down('Shift')
  await drag([[300, 300], [350, 330], [420, 290], [500, 305]])
  await win.keyboard.up('Shift')
  c = await content()
  check('shift = straight line', c[1]?.ink?.n === 2, JSON.stringify(c[1]?.ink))
  // Maintenir immobile = ligne droite
  await drag([[300, 360], [340, 380], [380, 350], [480, 370]], { hold: 900 })
  c = await content()
  check('hold still = straight line', c[2]?.ink?.n === 2, JSON.stringify(c[2]?.ink))

  // Surligneur
  await win.keyboard.press('KeyS')
  await drag([[300, 420], [400, 422], [500, 421]])
  c = await content()
  check('highlighter', c[3]?.ink?.tool === 'highlighter' && c[3].opacity < 0.6, JSON.stringify(c[3]))

  // Gomme partielle au milieu de la ligne droite (300,300)→(500,~305)
  await win.keyboard.press('KeyE')
  await win.evaluate(() => window.__feuillet.editor.canvas.requestRenderAll())
  const before = (await content()).length
  await drag([[400, 280], [400, 330]], { steps: 8 })
  c = await content()
  const straightPieces = c.filter((o) => o.ink?.tool === 'pen').length
  check('partial eraser splits stroke', c.length === before + 1 || straightPieces >= 4, `${before} -> ${c.length}`)
  await win.screenshot({ path: path.join(outDir, 'tools-1-ink.png') })

  // Formes (pointillés)
  await reset()
  await win.evaluate(() => { const { settings } = window.__feuillet; settings.set('shape', 'rect'); settings.set('shapeStyle', 'dashed') })
  await win.keyboard.press('KeyR')
  await drag([[250, 150], [400, 260]])
  await win.evaluate(() => { const { settings } = window.__feuillet; settings.set('shape', 'ellipse'); settings.set('shapeStyle', 'dotted') })
  await drag([[450, 150], [600, 260]])
  await win.evaluate(() => { const { settings } = window.__feuillet; settings.set('shape', 'arrow'); settings.set('shapeStyle', 'solid') })
  await drag([[250, 320], [600, 360]])
  c = await content()
  check('shapes created', c.map((o) => o.shape).join(',') === 'rect,ellipse,arrow', JSON.stringify(c.map((o) => [o.shape, o.dash])))
  check('dashed + dotted styles', !!c[0].dash && c[1].dash?.[0] < 0.01, JSON.stringify([c[0].dash, c[1].dash]))

  // Texte : clic simple
  await reset()
  await win.keyboard.press('KeyT')
  await win.mouse.click(...at(250, 150))
  await win.keyboard.type('Bonjour le monde')
  await win.keyboard.press('Escape')
  c = await content()
  check('text click', c.length === 1 && c[0].text === 'Bonjour le monde', JSON.stringify(c))

  // Texte : zone libre (cercle)
  await win.keyboard.press('KeyT')
  const loop = Array.from({ length: 41 }, (_, i) => { const t = (i / 40) * Math.PI * 2; return [450 + 110 * Math.cos(t), 420 + 110 * Math.sin(t)] })
  await drag(loop, { steps: 1 })
  await win.keyboard.type('Ce texte remplit un cercle dessine a la main sans jouer avec les espaces. '.repeat(3))
  await win.keyboard.press('Escape')
  const shaped = await win.evaluate(() => {
    const o = window.__feuillet.editor.doc.content.find((x) => x.type === 'shapedtext' || x.constructor.type === 'ShapedText')
    if (!o) return null
    return { lines: o._textLines.length, widths: o._textLines.map((_, i) => Math.round(o.getLineWidth(i))), offsets: o._textLines.map((_, i) => Math.round(o._getLineLeftOffset(i))), w: Math.round(o.width) }
  })
  check('free-form text zone', !!shaped && shaped.lines > 3 && Math.max(...shaped.offsets) > Math.min(...shaped.offsets) + 20, JSON.stringify(shaped))
  // alignement centré + gras via le panneau
  await win.evaluate(() => { const { canvas, doc } = window.__feuillet.editor; canvas.setActiveObject(doc.content.at(-1)); canvas.fire('selection:created', {}) })
  await win.click('.properties button[title="Centrer"]')
  await win.click('.properties button[title^="Gras"]')
  const styled = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.at(-1); return [o.textAlign, o.fontWeight] })
  check('align center + bold from panel', styled[0] === 'center' && styled[1] === 'bold', JSON.stringify(styled))
  await win.screenshot({ path: path.join(outDir, 'tools-2-text.png') })
  const shapedPdf = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  fs.writeFileSync(path.join(outDir, 'shaped.pdf'), Buffer.from(shapedPdf, 'base64'))

  // Tableau
  await reset()
  await win.click('[data-tool=table]')
  await win.mouse.click(...at(250, 150))
  await win.mouse.dblclick(...at(270, 160))
  await win.keyboard.type('Nom')
  await win.keyboard.press('Tab')
  await win.keyboard.type('Quantité')
  await win.keyboard.press('Enter')
  const cells = await win.evaluate(() => window.__feuillet.editor.doc.content[0].cells)
  check('table cells editable', cells[0][0] === 'Nom' && cells[0][1] === 'Quantité', JSON.stringify(cells))
  await win.click('.properties button[title^="Insérer une ligne"]')
  const rows = await win.evaluate(() => window.__feuillet.editor.doc.content[0].cells.length)
  check('table add row', rows === 4, `rows=${rows}`)

  // Graphique
  await win.click('[data-action=chart]')
  await win.waitForSelector('.chart-dialog[open]')
  await win.click('.chart-types button[data-type=pie]')
  await win.screenshot({ path: path.join(outDir, 'tools-3-chart-dialog.png') })
  await win.click('.chart-dialog button[value=ok]')
  await win.waitForTimeout(300)
  const chart = await win.evaluate(() => window.__feuillet.editor.doc.content.find((o) => o.chart)?.chart.type)
  check('chart inserted', chart === 'pie', String(chart))
  await win.evaluate(() => { const { viewport, doc } = window.__feuillet.editor; viewport.fit(doc.box(doc.pages[0])) })
  await win.screenshot({ path: path.join(outDir, 'tools-4-table-chart.png') })

  // Menus
  await win.click('.menu-button >> text=Édition')
  await win.screenshot({ path: path.join(outDir, 'tools-5-menu.png') })
  await win.keyboard.press('Escape')

  // Export PDF de tout
  const pdf = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  fs.writeFileSync(path.join(outDir, 'tools.pdf'), Buffer.from(pdf, 'base64'))
  check('export pdf', pdf.length > 1000)

  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
