// Fonctions essentielles : recherche, texte du PDF (sélection, surlignage aimanté, modification),
// navigation, miniatures, calques, lasso, reconnaissance de formes, tailles de trait.
// Utilisation : xvfb-run -a node tests/e2e/essentials.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  // PDF de test : 60 pages, paragraphes de 4 lignes.
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 60; i++) {
    const p = pdf.addPage([595.28, 841.89])
    for (let para = 0; para < 3; para++) {
      for (let l = 0; l < 4; l++) {
        p.drawText(`Paragraphe ${para + 1} de la page ${i}, ligne ${l + 1} : texte original du document.`, { x: 60, y: 760 - para * 120 - l * 16, size: 12, font })
      }
    }
  }
  const bytes = Buffer.from(await pdf.save()).toString('base64')

  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => window.__feuillet.welcome?.hide())
  await win.evaluate(() => (window.confirm = () => true))
  await win.evaluate(async (b64) => {
    await window.__feuillet.importer.open([{ name: 'doc.pdf', data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }])
  }, bytes)
  const F = (fn, arg) => win.evaluate(fn, arg)
  const toScreen = (x, y) => F(([x, y]) => {
    const c = window.__feuillet.editor.canvas
    const r = c.upperCanvasEl.getBoundingClientRect()
    const v = c.viewportTransform
    return [r.left + x * v[0] + v[4], r.top + y * v[3] + v[5]]
  }, [x, y])
  const page1 = await F(() => { const p = window.__feuillet.editor.doc.pages[0]; return { left: p.left, top: p.top, h: p.height } })
  // y écran d'une ligne PDF (repère PDF en bas à gauche → repère document)
  const lineY = (pdfY) => page1.top + (page1.h - pdfY) - 4

  // Aller à la page
  await win.keyboard.press('KeyG')
  await win.keyboard.type('45')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  const cur = await F(() => window.__feuillet.editor.doc.pages.indexOf(window.__feuillet.editor.doc.currentPage()) + 1)
  check('go to page 45', cur === 45, `page=${cur}`)
  await F(() => window.__feuillet.goToPage(1))
  await win.waitForTimeout(300)

  // Recherche (insensible aux accents et à la casse)
  await win.keyboard.press('Control+KeyF')
  await win.keyboard.type('PARAGRAPHE 2 de la page 3,')
  await win.waitForTimeout(2500)
  const count = await win.locator('.find-count').textContent()
  check('search finds lines', /^1 \/ 4$/.test(count.trim()), count)
  await win.keyboard.press('Escape')
  await F(() => window.__feuillet.goToPage(1))
  await win.waitForTimeout(300)

  // Sélection de texte → surligner
  await win.keyboard.press('KeyX')
  let [x1, y1] = await toScreen(62, lineY(760))
  let [x2, y2] = await toScreen(300, lineY(760 - 16))
  await win.mouse.move(x1, y1); await win.mouse.down(); await win.waitForTimeout(300); await win.mouse.move(x2, y2, { steps: 6 }); await win.mouse.up()
  await win.waitForSelector('.text-bar:not([hidden])')
  await win.click('.text-bar button:has-text("Surligner")')
  await win.waitForTimeout(200)
  const markup = await F(() => window.__feuillet.editor.doc.content.find((o) => o.markup)?.markup)
  check('text selection → highlight', markup?.kind === 'highlight' && markup.text.startsWith('Paragraphe 1 de la page 1, ligne 1'), JSON.stringify(markup))

  // Surligneur aimanté au texte
  await win.keyboard.press('KeyS')
  ;[x1, y1] = await toScreen(70, lineY(760 - 120) + 2)
  ;[x2, y2] = await toScreen(250, lineY(760 - 120) - 1)
  await win.mouse.move(x1, y1); await win.mouse.down(); await win.mouse.move(x2, y2, { steps: 8 }); await win.mouse.up()
  await win.waitForTimeout(500)
  const snapped = await F(() => window.__feuillet.editor.doc.content.filter((o) => o.markup).map((o) => o.markup.text))
  check('highlighter snaps to text line', snapped.length === 2 && snapped[1].startsWith('Paragraphe 2'), JSON.stringify(snapped))

  // Modifier le texte d'origine (double-clic)
  await win.keyboard.press('KeyV')
  ;[x1, y1] = await toScreen(120, lineY(760 - 240 - 16))
  await win.mouse.dblclick(x1, y1)
  await win.waitForTimeout(800)
  const edited = await F(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && { text: o.text, size: o.fontSize, pdfEdit: o.pdfEdit, editing: o.isEditing } })
  check('edit PDF text: paragraph becomes editable', !!edited?.pdfEdit && edited.text.startsWith('Paragraphe 3 de la page 1, ligne 1') && edited.text.includes('ligne 4') && Math.abs(edited.size - 12) < 0.6, JSON.stringify(edited))
  await win.keyboard.press('Control+KeyA')
  await win.keyboard.type('Nouveau paragraphe écrit par moi.')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  const typed = await F(() => window.__feuillet.editor.doc.content.find((o) => o.pdfEdit)?.text)
  check('typed text kept exactly (accents)', typed === 'Nouveau paragraphe écrit par moi.', JSON.stringify(typed))
  await win.screenshot({ path: path.join(outDir, 'ess-1-edit.png') })
  const out = await F(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages.slice(0, 2), dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  fs.writeFileSync(path.join(outDir, 'edited.pdf'), Buffer.from(out, 'base64'))
  const txt = execFileSync('pdftotext', ['-f', '1', '-l', '1', path.join(outDir, 'edited.pdf'), '-']).toString()
  check('export: old text really removed', !txt.includes('Paragraphe 3 de la page 1') && txt.includes('Paragraphe 2 de la page 1'), '')
  check('export: new text present', /Nouveau\s+paragraphe\s+écrit/.test(txt), JSON.stringify(txt.slice(0, 400)))

  // Miniatures, dupliquer, supprimer
  await win.keyboard.press('F9')
  await win.waitForTimeout(800)
  const thumbs = await win.locator('.thumb').count()
  check('sidebar thumbnails', thumbs === 60, `thumbs=${thumbs}`)
  await win.locator('.thumb').first().hover()
  await win.locator('.thumb').first().locator('button[title="Dupliquer la page"]').click()
  await win.waitForTimeout(500)
  let pages = await F(() => window.__feuillet.editor.doc.pages.length)
  check('duplicate page', pages === 61, `pages=${pages}`)
  await win.locator('.thumb').nth(1).hover()
  await win.locator('.thumb').nth(1).locator('button[title="Supprimer la page"]').click()
  await win.waitForTimeout(500)
  pages = await F(() => window.__feuillet.editor.doc.pages.length)
  check('delete page', pages === 60, `pages=${pages}`)
  await win.screenshot({ path: path.join(outDir, 'ess-2-sidebar.png') })

  // Calques
  await win.click('.side-tabs button[data-tab=layers]')
  await win.click('.layers button:has-text("+ Calque")')
  await win.keyboard.press('KeyP')
  ;[x1, y1] = await toScreen(100, page1.top + 600)
  await win.mouse.move(x1, y1); await win.mouse.down(); await win.mouse.move(x1 + 120, y1 + 20, { steps: 6 }); await win.mouse.up()
  const layerInfo = await F(() => { const L = window.__feuillet.layers; const o = window.__feuillet.editor.doc.content.at(-1); return { n: L.list.length, onActive: o.layer === L.active, active: L.active } })
  check('stroke goes to active layer', layerInfo.n === 2 && layerInfo.onActive, JSON.stringify(layerInfo))
  await win.click('.layer.active button[title="Masquer"]')
  const hidden = await F(() => window.__feuillet.editor.doc.content.at(-1).visible)
  check('hide layer hides its objects', hidden === false)
  await win.click('.layer.active button[title="Afficher"]')

  // Lasso
  await reset()
  async function reset() { await F(() => { const { canvas, doc } = window.__feuillet.editor; canvas.remove(...doc.content); canvas.discardActiveObject() }) }
  await win.keyboard.press('KeyP')
  for (const yy of [650, 720]) {
    ;[x1, y1] = await toScreen(100, page1.top + yy)
    await win.mouse.move(x1, y1); await win.mouse.down(); await win.mouse.move(x1 + 100, y1 + 10, { steps: 5 }); await win.mouse.up()
  }
  await win.keyboard.press('KeyL')
  const loop = []
  for (let i = 0; i <= 24; i++) { const t = (i / 24) * Math.PI * 2; loop.push(await toScreen(150 + 80 * Math.cos(t), page1.top + 655 + 30 * Math.sin(t))) }
  await win.mouse.move(...loop[0]); await win.mouse.down()
  for (const p of loop.slice(1)) await win.mouse.move(...p)
  await win.mouse.up()
  const lassoSel = await F(() => window.__feuillet.editor.canvas.getActiveObjects().length)
  check('lasso selects only surrounded stroke', lassoSel === 1, `selected=${lassoSel}`)

  // Reconnaissance de forme : cercle tenu immobile
  await reset()
  await win.keyboard.press('KeyP')
  const circle = []
  for (let i = 0; i <= 36; i++) { const t = (i / 36) * Math.PI * 2; circle.push(await toScreen(300 + 60 * Math.cos(t) + (i % 3), page1.top + 400 + 60 * Math.sin(t))) }
  await win.mouse.move(...circle[0]); await win.mouse.down()
  for (const p of circle.slice(1)) await win.mouse.move(...p)
  await win.waitForTimeout(900)
  await win.mouse.up()
  const shape = await F(() => window.__feuillet.editor.doc.content.at(-1)?.shape)
  check('hold to perfect circle', shape === 'ellipse', String(shape))

  // Taille du trait : touches [ et ]
  const w0 = await F(() => window.__feuillet.settings.value.penWidth)
  await win.keyboard.press('BracketRight')
  const w1 = await F(() => window.__feuillet.settings.value.penWidth)
  check('] increases pen size', w1 > w0, `${w0} -> ${w1}`)
  await win.screenshot({ path: path.join(outDir, 'ess-3-quickbar.png') })

  // Zoom taille réelle
  await win.keyboard.press('Control+Digit1')
  const label = await win.locator('#zoom-label').textContent()
  check('actual size = 100 %', label.trim() === '100 %', label)

  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
