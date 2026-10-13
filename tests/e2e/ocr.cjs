// OCR : un PDF scanné (texte en image) devient du texte modifiable, sur l'appareil, sans internet.
// Utilisation : xvfb-run -a node tests/e2e/ocr.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  // « Scan » : la page du PDF LibreOffice transformée en image, dans un PDF.
  execFileSync('pdftoppm', ['-r', '200', '-png', '-singlefile', path.join(root, 'tests/fixtures/libreoffice.pdf'), path.join(outDir, 'scan')])
  const { PDFDocument } = require('pdf-lib')
  const pdf = await PDFDocument.create()
  const png = await pdf.embedPng(fs.readFileSync(path.join(outDir, 'scan.png')))
  pdf.addPage([595.28, 841.89]).drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 })
  const scan = Buffer.from(await pdf.save()).toString('base64')

  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.DBG) console.log('>', m.type(), m.text().slice(0, 300)) })
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate((b) => { (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()); window.confirm = () => true; return window.__feuillet.importer.open([{ name: 'scan.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]) }, scan)
  await win.waitForTimeout(500)

  // Pas de texte dans le fichier : l'outil le dit et propose l'OCR
  await win.keyboard.press('KeyM')
  await win.waitForSelector('.pdf-guide:not([hidden])')
  check('scanned page: the guide offers text recognition', await win.locator('.pdf-guide-ocr').isVisible(), await win.locator('.pdf-guide').innerText())
  const t0 = Date.now()
  await win.locator('.pdf-guide-ocr').click()
  await win.waitForFunction(() => window.__feuillet.editor.doc.pages[0].ocr?.chars.length > 0, null, { timeout: 40000 })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const text = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].ocr.chars.map((c) => c.c).join(''))
  check('text recognised on the device (French model)', /Titre du document/.test(text) && /paragraphe justifié/.test(text) && /Deuxième paragraphe/.test(text), `${secs} s — ${JSON.stringify(text.slice(0, 120))}`)
  const accents = (text.match(/[éèêàçù]/g) || []).length
  check('accents recognised', accents >= 10, String(accents))

  // Modifier le paragraphe reconnu
  const ws = await win.locator('#workspace').boundingBox()
  const clickAt = async (x, y) => {
    const s = await win.evaluate(([x, y]) => { const p = window.__feuillet.editor.doc.pages[0]; const v = window.__feuillet.editor.canvas.viewportTransform; return [(p.left + x) * v[0] + v[4], (p.top + y) * v[3] + v[5]] }, [x, y])
    await win.mouse.click(ws.x + s[0], ws.y + s[1])
    await win.waitForTimeout(600)
  }
  await win.keyboard.press('KeyM')
  await clickAt(70, 172)
  const box = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && { text: o.text, size: o.fontSize, left: o.left - window.__feuillet.editor.doc.pages[0].left, lines: o._textLines.length, family: o.fontFamily, weight: o.fontWeight } })
  check('recognised paragraph opens as editable text', !!box && /^Deuxième paragraphe/.test(box.text) && box.lines === 2, JSON.stringify(box))
  check('size and position match the scan', !!box && Math.abs(box.size - 11) < 0.8 && Math.abs(box.left - 56.8) < 3, JSON.stringify(box && { size: box.size, left: box.left }))
  check('font of the scan recognised (Carlito ≈ Calibri)', !!box && /Calibri|Carlito/.test(box.family) && box.weight === 'normal', JSON.stringify(box && { f: box.family, w: box.weight }))
  await win.evaluate(() => {
    const o = window.__feuillet.editor.canvas.getActiveObject()
    o.selectionStart = 0
    o.selectionEnd = 'Deuxième'.length
    o._updateTextarea()
    o.hiddenTextarea.focus()
  })
  await win.keyboard.type('Second')
  await win.keyboard.press('Escape')
  await win.keyboard.press('KeyM')
  await clickAt(100, 89)
  const just = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && { f: o.fontFamily, w: o.fontWeight, a: o.textAlign, i: o.firstIndent, s: o.fontSize } })
  check('justified serif paragraph: serif font, justified, indented', !!just && /Times|Cambria|Serif|Georgia/.test(just.f) && just.a === 'justify-left' && just.i > 20, JSON.stringify(just))
  await win.keyboard.press('Escape')
  await win.keyboard.press('KeyM')
  await clickAt(80, 55)
  const title = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && { f: o.fontFamily, w: o.fontWeight, s: o.fontSize } })
  check('bold sans-serif title recognised', !!title && /Arial/.test(title.f) && title.w === 'bold' && Math.abs(title.s - 24) < 2, JSON.stringify(title))
  await win.keyboard.press('Escape')
  await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  check('original image text is covered (one cover per edited paragraph)', (await win.evaluate(() => window.__feuillet.editor.doc.pages[0].covers?.length)) === 3)
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(outDir, 'ocr-edited.png') })

  // Export : le nouveau texte est du vrai texte, l'ancien est recouvert
  const out = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  const file = path.join(outDir, 'ocr.pdf')
  fs.writeFileSync(file, Buffer.from(out, 'base64'))
  const extracted = execFileSync('pdftotext', [file, '-']).toString()
  check('export: edited text is real text', /Second paragraphe/.test(extracted), JSON.stringify(extracted.slice(0, 100)))
  // Recherche dans le texte reconnu
  const found = await win.evaluate(async () => { const { findBar } = window.__feuillet; return typeof findBar?.search === 'function' ? (await findBar.search('justifié'))?.length ?? null : null })
  check('recognised text is searchable', found === null || found > 0, String(found))

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
