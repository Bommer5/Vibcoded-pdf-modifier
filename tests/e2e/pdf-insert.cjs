// Insérer un PDF portrait dans un document paysage : comme image (redimensionnable,
// vectorielle à l'export), comme pages au format du PDF, ou au format du document.
// Utilisation : xvfb-run -a node tests/e2e/pdf-insert.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib')
  const make = async (w, h, n, label) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= n; i++) pdf.addPage([w, h]).drawText(`${label} ${i}`, { x: 50, y: h - 80, size: 28, font })
    return Buffer.from(await pdf.save()).toString('base64')
  }
  const landscape = await make(841.89, 595.28, 1, 'Paysage')
  const portrait = await make(595.28, 841.89, 2, 'Portrait page')

  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => {
    (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove())
    localStorage.removeItem('feuillet.pdfInsert')
    window.__file = (name, b64) => ({ name, path: undefined, data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) })
    window.confirm = () => true
  })
  await win.evaluate((b) => window.__feuillet.importer.open([window.__file('paysage.pdf', b)]), landscape)
  const insert = () => win.evaluate((b) => { window.__done = false; window.__feuillet.importer.insert([window.__file('portrait.pdf', b)], null).then(() => (window.__done = true)) }, portrait)
  const done = () => win.waitForFunction(() => window.__done, null, { timeout: 20000 })
  const state = () => win.evaluate(() => {
    const { doc } = window.__feuillet.editor
    return {
      pages: doc.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.bg.kind]),
      images: doc.content.filter((o) => o.pdfPage).map((o) => { const b = o.getBoundingRect(); const p = doc.pageAt(o.getCenterPoint()); return { w: Math.round(o.getScaledWidth()), h: Math.round(o.getScaledHeight()), inside: !!p && b.left >= p.left - 1 && b.top >= p.top - 1 && b.left + b.width <= p.left + p.width + 1 && b.top + b.height <= p.top + p.height + 1, page: doc.pages.indexOf(p), index: o.pdfPage.index } })
    }
  })

  // 1. Comme image (choix par défaut)
  await insert()
  await win.waitForSelector('dialog.pdf-insert[open]')
  check('dialog shows file info', /2 pages/.test(await win.locator('.pi-meta').innerText()) && /portrait/.test(await win.locator('.pi-meta').innerText()))
  check('default = as image on the page', await win.locator('.pi-mode input[value=image]').isChecked())
  await win.waitForTimeout(300)
  await win.screenshot({ path: path.join(outDir, 'pdf-insert-dialog.png') })
  await win.click('dialog.pdf-insert button.primary')
  await done()
  let s = await state()
  check('as image: one image per PDF page, fitted inside landscape pages', s.images.length === 2 && s.images.every((i) => i.inside) && s.images[0].page === 0 && s.images[1].page === 1, JSON.stringify(s))
  check('as image: new page keeps the document format (landscape)', s.pages.length === 2 && s.pages[1][0] > s.pages[1][1], JSON.stringify(s.pages))
  check('as image: tool back to Select, image selected', await win.evaluate(() => window.__feuillet.tools.tool === 'select' && !!window.__feuillet.editor.canvas.getActiveObject()?.pdfPage))
  // Redimensionnée et déplacée librement, puis export : la page reste vectorielle (texte réel)
  await win.evaluate(() => {
    const { editor } = window.__feuillet
    const img = editor.doc.content.find((o) => o.pdfPage && o.pdfPage.index === 0)
    img.set({ scaleX: img.scaleX * 0.5, scaleY: img.scaleY * 0.5, left: editor.doc.pages[0].left + 30, top: editor.doc.pages[0].top + 30, angle: 0 })
    img.setCoords()
  })
  const pdf = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: [editor.doc.pages[0]], dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  const file = path.join(outDir, 'inserted.pdf')
  fs.writeFileSync(file, Buffer.from(pdf, 'base64'))
  const text = execFileSync('pdftotext', [file, '-']).toString()
  check('export keeps the inserted page as vector (real text)', /Portrait page 1/.test(text) && /Paysage 1/.test(text), JSON.stringify(text.slice(0, 80)))
  const bbox = execFileSync('pdftotext', ['-bbox', file, '-']).toString()
  const m = /xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)"[^>]*>Portrait</.exec(bbox)
  // Image réduite de moitié et posée à (30, 30) : son texte (en 50, 80-28 sur la page d'origine) suit.
  check('vector page follows position and size', m && Math.abs(Number(m[1]) - (30 + 25 * (s.images[0].w / 595.28) * 0.5 * 2)) < 6, m ? m.slice(1, 4).join(',') : 'absent')

  // 2. Nouvelles pages au format du PDF (portrait), page 2 seulement, à la fin
  await insert()
  await win.waitForSelector('dialog.pdf-insert[open]')
  await win.check('.pi-mode input[value="pages-pdf"]')
  await win.selectOption('dialog.pdf-insert select[name=pages]', 'range')
  await win.fill('dialog.pdf-insert input[name=range]', '2')
  await win.selectOption('dialog.pdf-insert select[name=position]', 'end')
  await win.click('dialog.pdf-insert button.primary')
  await done()
  s = await state()
  const last = s.pages.at(-1)
  check('as pages (PDF format): portrait page added at the end', s.pages.length === 3 && last[1] > last[0] && last[2] === 'pdf', JSON.stringify(s.pages))

  // 3. Nouvelles pages au format du document
  await insert()
  await win.waitForSelector('dialog.pdf-insert[open]')
  check('last choice is remembered', await win.locator('.pi-mode input[value="pages-pdf"]').isChecked())
  await win.check('.pi-mode input[value="pages-doc"]')
  await win.selectOption('dialog.pdf-insert select[name=pages]', 'first')
  await win.selectOption('dialog.pdf-insert select[name=position]', 'after')
  await win.click('dialog.pdf-insert button.primary')
  await done()
  s = await state()
  const added = s.images.find((i) => i.page === 1 && i.h > 500)
  check('as pages (document format): landscape page with the PDF centred, not distorted', s.pages.length === 4 && s.pages[1][0] > s.pages[1][1] && !!added && Math.abs(added.w / added.h - 595.28 / 841.89) < 0.01, JSON.stringify(s))

  // 4. Annuler
  await insert()
  await win.waitForSelector('dialog.pdf-insert[open]')
  await win.click('dialog.pdf-insert button[value=cancel]')
  await done()
  check('cancel inserts nothing', (await state()).pages.length === 4)
  // Une seule étape d'annulation par insertion
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(300)
  check('undo removes the last insertion in one step', (await state()).pages.length === 3, JSON.stringify((await state()).pages))

  // 5. Projet : la page insérée comme image garde la référence de son PDF d'origine (enregistrée)
  const reopened = await win.evaluate(() => {
    const { editor } = window.__feuillet
    const json = editor.canvas.toObject()
    return json.objects.filter((o) => o.pdfPage).length >= 2 && json.objects.every((o) => !o.pdfPage || typeof o.pdfPage.assetId === 'string')
  })
  check('image keeps a reference to its PDF page', reopened)

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
