// N'importer qu'une partie d'un fichier (un exercice dans un long PDF, un détail d'une image) :
// fenêtre de cadrage (pages, cadre à la souris), objet rogné, export PDF vectoriel limité à la
// zone, « Rogner » pour ajuster ensuite, annulation.
// Utilisation : xvfb-run -a node tests/e2e/crop.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { readGray } = require('./lib/image.cjs')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
  // Cours de trois pages ; page 2 : trois exercices les uns sous les autres.
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const p = pdf.addPage([595.28, 841.89])
    p.drawText(`Chapitre ${i}`, { x: 50, y: 790, size: 24, font })
    if (i === 2) {
      p.drawText('Exercice 1', { x: 50, y: 700, size: 28, font })
      p.drawRectangle({ x: 50, y: 400, width: 300, height: 100, color: rgb(0, 0, 0) })
      p.drawText('Exercice 2', { x: 50, y: 520, size: 28, font })
      p.drawText('Exercice 3', { x: 50, y: 150, size: 28, font })
    }
  }
  const b64 = Buffer.from(await pdf.save()).toString('base64')

  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => {
    (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove())
    window.confirm = () => true
    localStorage.removeItem('feuillet.pdfInsert')
  })

  /** Glisse dans la fenêtre de cadrage, de (fx0, fy0) à (fx1, fy1) en fractions de la page. */
  const dragCrop = async (fx0, fy0, fx1, fy1) => {
    await win.waitForSelector('.crop-dialog .crop-canvas')
    const b = await win.locator('.crop-dialog .crop-page').boundingBox()
    await win.mouse.move(b.x + b.width * fx0, b.y + b.height * fy0)
    await win.mouse.down()
    await win.mouse.move(b.x + b.width * fx1, b.y + b.height * fy1, { steps: 6 })
    await win.mouse.up()
  }
  const object = () => win.evaluate(() => {
    const { editor } = window.__feuillet
    const o = editor.canvas.getActiveObject()
    if (!o) return null
    const p = editor.doc.pages[0]
    const r = o.getBoundingRect()
    const el = o.getElement()
    return { pdf: o.pdfPage ?? null, cropX: o.cropX, cropY: o.cropY, w: o.width, h: o.height, natW: el.naturalWidth || el.width, natH: el.naturalHeight || el.height,
      box: { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height }, n: editor.doc.content.length }
  })

  // 1. Insertion > Une partie d'un PDF : page 2, exercice 2 seulement (y 330 à 450 pt du haut)
  const files = (name, data) => win.evaluate(([n, d]) => { void window.__feuillet.importer.insertPart([{ name: n, data: Uint8Array.from(atob(d), (c) => c.charCodeAt(0)) }], null) }, [name, data])
  await files('cours.pdf', b64)
  await win.waitForSelector('.crop-dialog')
  check('crop window opens on the first page', (await win.locator('.crop-num').inputValue()) === '1' && (await win.locator('.crop-count').innerText()) === '3')
  check('insert disabled until a zone is chosen', await win.locator('.crop-ok').isDisabled())
  await win.waitForSelector('.crop-dialog .crop-canvas')
  await win.click('.crop-next')
  await win.waitForFunction(() => document.querySelector('.crop-num')?.value === '2')
  await dragCrop(0.05, 300 / 841.89, 0.7, 460 / 841.89)
  check('rectangle drawn with the mouse', await win.locator('.crop-rect').isVisible())
  await win.screenshot({ path: path.join(outDir, 'crop-dialog.png') })
  await win.click('.crop-ok')
  await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject())
  const part = await object()
  check('page 2 inserted, cropped to the zone', part?.pdf?.index === 1 && Math.abs(part.cropY / part.natH - 300 / 841.89) < 0.01 && Math.abs(part.h / part.natH - 160 / 841.89) < 0.01, JSON.stringify(part))
  check('cropped part keeps its real size (points)', Math.abs(part.box.h - 160) < 3 && Math.abs(part.box.w - 0.65 * 595.28) < 4, JSON.stringify(part.box))
  check('crop button shown for the selection', await win.locator('#selection-bar [data-action=crop]').isVisible())

  // 2. Export PDF : vectoriel, seule la zone est dessinée
  const exportPdf = async (name) => {
    const data = await win.evaluate(async () => {
      const { exporter, editor, formats } = window.__feuillet
      const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
      let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
    })
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
  const file = await exportPdf('part.pdf')
  execFileSync('pdftoppm', ['-r', '72', '-png', '-singlefile', file, path.join(outDir, 'part')])
  const img = await readGray(app, path.join(outDir, 'part.png'))
  let inside = 0, outside = 0
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.gray[y * img.width + x] > 128) continue
    const b = part.box
    if (x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2) inside++
    else outside++
  }
  check('export: the exercise is drawn', inside > 3000, `${inside} px`)
  check('export: nothing outside the chosen zone (no other exercise)', outside < 20, `${outside} px`)
  const text = execFileSync('pdftotext', [file, '-']).toString()
  check('export: the exercise stays real text (vector)', /Exercice 2/.test(text), JSON.stringify(text.slice(0, 80)))
  check('export: text outside the zone removed (not just hidden)', !/Exercice 1|Exercice 3|Chapitre/.test(text), JSON.stringify(text.slice(0, 80)))

  // 3. Rogner : on agrandit vers le bas ; la partie déjà visible ne bouge pas sur la page
  await win.click('#selection-bar [data-action=crop]')
  await win.waitForSelector('.crop-dialog .crop-canvas')
  check('crop window shows the current zone', await win.locator('.crop-rect').isVisible())
  const h = await win.locator('.crop-handle[data-corner=se]').boundingBox()
  const pageBox = await win.locator('.crop-page').boundingBox()
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await win.mouse.down()
  await win.mouse.move(h.x + h.width / 2, pageBox.y + pageBox.height * (700 / 841.89), { steps: 6 })
  await win.mouse.up()
  await win.click('.crop-ok')
  await win.waitForTimeout(200)
  const grown = await object()
  check('crop: zone enlarged (exercise 3 now included)', Math.abs(grown.h / grown.natH - 400 / 841.89) < 0.015, JSON.stringify(grown))
  check('crop: the visible part stays in place', Math.abs(grown.box.y - part.box.y) < 1.5 && Math.abs(grown.box.x - part.box.x) < 1.5, `${JSON.stringify(part.box)} → ${JSON.stringify(grown.box)}`)
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(200)
  const undone = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.find((x) => x.pdfPage); return o && { h: o.height, cropY: o.cropY } })
  check('undo restores the previous crop', undone && Math.abs(undone.h - part.h) < 1, JSON.stringify(undone))

  // 4. Une partie d'une image : moitié basse (bleue) d'une image rouge / bleue
  const png = await win.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 400
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 400, 200)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(0, 200, 400, 200)
    return c.toDataURL('image/png').split(',')[1]
  })
  await files('photo.png', png)
  await dragCrop(0, 0.55, 1, 1)
  await win.click('.crop-ok')
  await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject()?.type === 'image' && !window.__feuillet.editor.canvas.getActiveObject().pdfPage)
  const photo = await win.evaluate(() => {
    const o = window.__feuillet.editor.canvas.getActiveObject()
    const c = document.createElement('canvas')
    c.width = Math.round(o.getScaledWidth())
    c.height = Math.round(o.getScaledHeight())
    const ctx = c.getContext('2d')
    ctx.drawImage(o.toCanvasElement({ multiplier: 1 }), 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0, blue = 0
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 2] < 60) red++; if (d[i + 2] > 200 && d[i] < 60) blue++ }
    return { cropY: o.cropY, h: o.height, red, blue }
  })
  check('image: only the chosen part is inserted', Math.abs(photo.cropY - 220) <= 2 && Math.abs(photo.h - 180) <= 2 && photo.red === 0 && photo.blue > 1000, JSON.stringify(photo))

  // 5. « Insérer un PDF » : choix « Une partie d'une page »
  await win.evaluate((d) => { void window.__feuillet.importer.insert([{ name: 'cours.pdf', data: Uint8Array.from(atob(d), (c) => c.charCodeAt(0)) }], null) }, b64)
  await win.waitForSelector('.pdf-insert')
  check('insert PDF dialog offers a part of a page', await win.locator('.pdf-insert input[value=part]').count() === 1)
  await win.check('.pdf-insert input[value=part]')
  check('page choice moves to the crop window', await win.locator('.pdf-insert .pi-row').isHidden())
  await win.click('.pdf-insert button[value=ok]')
  await dragCrop(0.05, 0.02, 0.6, 0.1)
  const before = await win.evaluate(() => window.__feuillet.editor.doc.content.length)
  await win.click('.crop-ok')
  await win.waitForFunction((n) => window.__feuillet.editor.doc.content.length === n + 1, before)
  const title = await object()
  check('part of page 1 inserted from the PDF dialog', title.pdf?.index === 0 && title.h / title.natH < 0.1, JSON.stringify(title))

  // 6. Annuler la fenêtre : rien n'est inséré
  await files('cours.pdf', b64)
  await win.waitForSelector('.crop-dialog .crop-canvas')
  await win.click('.crop-dialog button[value=cancel]')
  await win.waitForTimeout(200)
  check('cancel inserts nothing', (await win.evaluate(() => window.__feuillet.editor.doc.content.length)) === before + 1)

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
