// Modifier le texte d'un vrai PDF (LibreOffice : polices intégrées en sous-ensembles, retrait
// de première ligne, justification) : avant / après identiques, pas de doublon, export fidèle.
// Utilisation : xvfb-run -a node tests/e2e/pdf-edit.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { readGray, diffPercent } = require('./lib/image.cjs')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

/** Écart entre deux rendus, sans tenir compte du lissage des bords (moteurs différents). */
function inkDiff(a, b) {
  let n = 0, ink = 0
  for (let y = 1; y < a.height - 1; y++) for (let x = 1; x < a.width - 1; x++) {
    const i = y * a.width + x
    const da = a.gray[i] < 100, db = b.gray[i] < 100
    if (da) ink++
    if (da === db) continue
    // Toléré si un pixel voisin (±1) a la bonne couleur : bord lissé autrement, décalage d'un
    // demi-point dû au crénage (invisible à l'œil).
    const W = a.width
    const near = (img, want) => [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1].some((d) => (img.gray[i + d] < 100) === want)
    if (!(near(b, da) && near(a, db))) n++
  }
  return (100 * n) / Math.max(1, ink)
}

;(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  const b64 = fs.readFileSync(path.join(root, 'tests/fixtures/libreoffice.pdf')).toString('base64')
  await win.evaluate((b) => { window.__feuillet.welcome?.hide(); window.confirm = () => true; return window.__feuillet.importer.open([{ name: 'doc.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]) }, b64)
  const shot = async (name) => {
    const png = await win.evaluate(async () => (await window.__feuillet.exporter.raster(window.__feuillet.editor.doc.pages[0], 150)).toDataURL('image/png').split(',')[1])
    fs.writeFileSync(path.join(outDir, name), Buffer.from(png, 'base64'))
    return readGray(app, path.join(outDir, name))
  }
  const ws = await win.locator('#workspace').boundingBox()
  const clickAt = async (x, y) => {
    const s = await win.evaluate(([x, y]) => { const p = window.__feuillet.editor.doc.pages[0]; const v = window.__feuillet.editor.canvas.viewportTransform; return [(p.left + x) * v[0] + v[4], (p.top + y) * v[3] + v[5]] }, [x, y])
    await win.mouse.click(ws.x + s[0], ws.y + s[1])
    await win.waitForTimeout(500)
  }
  await win.waitForTimeout(800)
  const before = await shot('before.png')

  // 1. Ouvrir chaque paragraphe en modification, puis Échap sans rien changer
  const info = []
  for (const [x, y] of [[80, 55], [100, 89], [70, 172]]) {
    await win.keyboard.press('KeyM')
    await clickAt(x, y)
    info.push(await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && { text: o.text, family: o.fontFamily, align: o.textAlign, indent: o.firstIndent, lines: o._textLines.length } }))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
  }
  await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  await win.waitForTimeout(500)
  const after = await shot('after.png')
  check('three separate paragraphs (title, justified, Carlito)', info.length === 3 && info.every(Boolean) && /^Titre/.test(info[0].text) && /^Ceci/.test(info[1].text) && /^Deuxième/.test(info[2].text), JSON.stringify(info.map((i) => i?.text.slice(0, 15))))
  check('original PDF fonts are reused', info.every((i) => /^'PDF /.test(i.family)), info.map((i) => i.family).join(' | '))
  check('justified paragraph with first-line indent', info[1].align === 'justify-left' && info[1].indent > 20 && info[1].lines === 5, JSON.stringify(info[1] && { a: info[1].align, i: info[1].indent, l: info[1].lines }))
  check('left-aligned paragraph stays left-aligned', info[2].align === 'left' && info[2].lines === 2, JSON.stringify(info[2] && { a: info[2].align, l: info[2].lines }))
  const d = inkDiff(before, after)
  check('page looks the same before and after (no change typed)', d < 3, `${d.toFixed(2)} % des pixels d'encre`)

  // 2. Exporter : le texte une seule fois, polices d'origine, rendu identique
  const exportPdf = async (name) => {
    const pdf = await win.evaluate(async () => {
      const { exporter, editor, formats } = window.__feuillet
      const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
      let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
    })
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(pdf, 'base64'))
    return file
  }
  const file = await exportPdf('edited.pdf')
  const text = execFileSync('pdftotext', [file, '-']).toString()
  check('no duplicated text in the export', (text.match(/Titre du document/g) || []).length === 1 && (text.match(/Deuxième paragraphe/g) || []).length === 1, JSON.stringify(text.slice(0, 120)))
  const fonts = execFileSync('pdffonts', [file]).toString()
  check('export embeds the original fonts', /DejaVu/.test(fonts) && /Carlito/.test(fonts), '\n' + fonts)
  execFileSync('pdftoppm', ['-r', '150', '-png', '-singlefile', file, path.join(outDir, 'exported')])
  execFileSync('pdftoppm', ['-r', '150', '-png', '-singlefile', path.join(root, 'tests/fixtures/libreoffice.pdf'), path.join(outDir, 'original')])
  const e1 = await readGray(app, path.join(outDir, 'exported.png'))
  const e0 = await readGray(app, path.join(outDir, 'original.png'))
  const de = inkDiff(e0, e1)
  check('exported PDF looks like the original', de < 3, `${de.toFixed(2)} %`)

  // 3. Modifier un mot : même police, le reste ne bouge pas
  await win.keyboard.press('KeyV')
  const box = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.find((x) => x.text?.startsWith('Deuxième')); return [o.left, o.top] })
  await win.evaluate(() => {
    const { editor } = window.__feuillet
    const o = editor.doc.content.find((x) => x.text?.startsWith('Deuxième'))
    editor.canvas.setActiveObject(o)
    o.enterEditing()
    o.selectionStart = 0
    o.selectionEnd = 'Deuxième'.length
    o._updateTextarea()
    o.hiddenTextarea.focus()
  })
  await win.keyboard.type('Second')
  await win.keyboard.press('Escape')
  const edited = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.find((x) => x.text?.startsWith('Second')); return o && { s: o.getSelectionStyles(0, 6), f: o.fontFamily, l: o.left, t: o.top } })
  check('typed word keeps the original font', !!edited && edited.s.every((st) => !st.fontFamily || st.fontFamily === edited.f) && /^'PDF /.test(edited.f), JSON.stringify(edited))
  check('edited paragraph stays in place', !!edited && Math.abs(edited.l - box[0]) < 0.01 && Math.abs(edited.t - box[1]) < 0.01)
  const file2 = await exportPdf('edited2.pdf')
  const text2 = execFileSync('pdftotext', [file2, '-']).toString()
  check('export contains the new word, not the old one', /Second paragraphe/.test(text2) && !/Deuxième/.test(text2), JSON.stringify(text2.slice(-260)))

  // 4. Une même instruction du PDF contient deux colonnes : on n'en modifie qu'une, sans doublon
  const { PDFDocument, StandardFonts } = require('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595.28, 841.89]).drawText('Gauche' + ' '.repeat(40) + 'Droite', { x: 60, y: 760, size: 14, font })
  const two = Buffer.from(await pdf.save()).toString('base64')
  await win.evaluate((b) => window.__feuillet.importer.open([{ name: 'cols.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), two)
  await win.waitForTimeout(500)
  await win.keyboard.press('KeyM')
  await clickAt(80, 841.89 - 765)
  const col = await win.evaluate(() => window.__feuillet.editor.canvas.getActiveObject()?.text)
  check('only the clicked column is edited', col === 'Gauche', JSON.stringify(col))
  await win.keyboard.press('Escape')
  await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  await win.waitForTimeout(600)
  const colShot = await shot('columns.png')
  // Rangée du texte : l'encre de « Gauche » ne doit pas être doublée (texte d'origine recouvert).
  const scale = 150 / 72
  const y0 = Math.round((841.89 - 775) * scale), y1 = Math.round((841.89 - 755) * scale)
  let ink = 0
  for (let y = y0; y < y1; y++) for (let x = Math.round(55 * scale); x < Math.round(115 * scale); x++) if (colShot.gray[y * colShot.width + x] < 100) ink++
  const origShot = await (async () => {
    execFileSync('pdftoppm', ['-r', '150', '-png', '-singlefile', '-', path.join(outDir, 'cols-orig')], { input: Buffer.from(two, 'base64') })
    return readGray(app, path.join(outDir, 'cols-orig.png'))
  })()
  let ink0 = 0
  for (let y = y0; y < y1; y++) for (let x = Math.round(55 * scale); x < Math.round(115 * scale); x++) if (origShot.gray[y * origShot.width + x] < 100) ink0++
  check('no doubled text when the PDF instruction spans both columns', ink0 > 50 && Math.abs(ink - ink0) / ink0 < 0.25, `${ink} vs ${ink0}`)
  const droite = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].masks.length)
  check('the other column is untouched', droite === 1)

  // 5. Le paragraphe modifié grandit : le paragraphe suivant descend (et remonte s'il rétrécit)
  await win.evaluate((b) => window.__feuillet.importer.open([{ name: 'doc.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), b64)
  await win.waitForTimeout(500)
  const deuxTop = () => win.evaluate(async () => {
    const { editor, pdfEngine } = window.__feuillet
    const page = editor.doc.pages[0]
    const words = await pdfEngine.words(page.bg.assetId, page.bg.index)
    const w = words.find((x) => x.text === 'Deuxième')
    // position affichée = origine + décalage
    const dy = (page.shifts ?? []).filter((s) => w.y0 >= s.y - 0.5 && (w.x0 + w.x1) / 2 >= s.x0 && (w.x0 + w.x1) / 2 <= s.x1).reduce((a, s) => a + s.dy, 0)
    return w.y0 + dy
  })
  const yBefore = await deuxTop()
  await win.keyboard.press('KeyM')
  await clickAt(100, 89)
  await win.keyboard.press('Control+End')
  await win.keyboard.type(' Une phrase ajoutée pour allonger le paragraphe de plusieurs lignes, afin de vérifier que la suite de la colonne descend bien comme dans Word.')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  const grown = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].shifts)
  const yAfter = await deuxTop()
  check('next paragraph moves down when the edited one grows', grown?.length === 1 && grown[0].dy > 10 && Math.abs(yAfter - yBefore - grown[0].dy) < 0.01, JSON.stringify({ grown, yBefore, yAfter }))
  await win.waitForTimeout(800)
  await shot('grown.png')
  const file3 = await exportPdf('grown.pdf')
  const bb = execFileSync('pdftotext', ['-bbox', file3, '-']).toString()
  const yd = Number(/yMin="([\d.]+)"[^>]*>Deuxième</.exec(bb)?.[1])
  check("export: the next paragraph is moved down too", Math.abs(yd - yAfter) < 2, `${yd} vs ${yAfter}`)
  check('export: nothing overlaps (text read in order)', /Word\.\s*\n?Deuxième/.test(execFileSync('pdftotext', [file3, '-']).toString().replace(/\n/g, ' ').replace(/\s+/g, ' ').replace(' Deuxième', '\nDeuxième')))
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(400)
  const undone = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].shifts ?? [])
  check('undo puts the next paragraph back', undone.every((s) => !s.dy), JSON.stringify(undone))

  // PDF écrits par Chrome (formulaires, pages web) : texte en « px » dans une page réduite à
  // 75 %, polices Type 3 découpées en morceaux sans nom (Inter), ou CID TrueType (DejaVu).
  for (const [fixture, label] of [['chrome-type3.pdf', 'Chrome, Type 3'], ['chrome-cid.pdf', 'Chrome, CID TrueType']]) {
    await win.evaluate(() => window.feuillet.setDirty(false))
    const data = fs.readFileSync(path.join(root, 'tests/fixtures', fixture)).toString('base64')
    await win.evaluate((b) => window.__feuillet.importer.open([{ name: 'form.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), data)
    await win.waitForTimeout(600)
    for (const [word, size, bold] of [['Suivez', 11, false], ['Affections', 16, true]]) {
      const at = await win.evaluate(async (word) => {
        const { editor, pdfEngine } = window.__feuillet
        const p = editor.doc.pages[0]
        const r = await pdfEngine.chars(p.bg.assetId, 0)
        const c = r.chars[r.chars.map((x) => x.c).join('').indexOf(word)]
        editor.viewport.showRect(editor.doc.box(p))
        return [c.x + 2, c.y - c.size * 0.3]
      }, word)
      await win.evaluate(() => window.__feuillet.tools.set('edittext'))
      await clickAt(at[0], at[1])
      await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject()?.text !== undefined, null, { timeout: 8000 }).catch(() => {})
      const o = await win.evaluate(() => {
        const o = window.__feuillet.editor.canvas.getActiveObject()
        if (!o) return null
        const ctx = document.createElement('canvas').getContext('2d')
        ctx.font = `bold ${o.fontSize}px ${o.fontFamily}`
        const boldW = ctx.measureText(o._textLines[0].join('')).width
        ctx.font = `${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`
        const w = ctx.measureText(o._textLines[0].join('')).width
        return { size: o.fontSize, cs: o.charSpacing, lh: o.lineHeight, lines: o._textLines.length, family: o.fontFamily, weight: o.fontWeight, heavy: Math.abs(w - boldW) < 0.5 }
      })
      check(`${label} : « ${word} » à sa vraie taille (${size} pt), lettres non tassées`, o && Math.abs(o.size - size) < 0.3 && Math.abs(o.cs) < 25, JSON.stringify(o))
      if (word === 'Suivez') check(`${label} : interligne d'origine, mêmes lignes`, o && o.lines === 2 && o.lh > 0.95 && o.lh < 1.3, JSON.stringify(o))
      if (bold) check(`${label} : titre en gras`, o && (o.weight === 'bold' || o.heavy || /Bold/.test(o.family)), JSON.stringify(o))
      await win.keyboard.press('Escape')
      await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
      await win.waitForTimeout(200)
    }
  }

  // Liste à étiquettes (« (c) », « (d) ») en retrait suspendu, mots en italique, justifié
  // (mise en page LaTeX / Word) : le paragraphe entier, sans la fin de l'élément précédent.
  {
    await win.evaluate(() => window.feuillet.setDirty(false))
    const data = fs.readFileSync(path.join(root, 'tests/fixtures/list-items.pdf')).toString('base64')
    await win.evaluate((b) => window.__feuillet.importer.open([{ name: 'liste.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), data)
    await win.waitForTimeout(600)
    const at = await win.evaluate(async () => {
      const { editor, pdfEngine } = window.__feuillet
      const p = editor.doc.pages[0]
      const r = await pdfEngine.chars(p.bg.assetId, 0)
      const s = r.chars.map((x) => x.c).join('')
      const c = r.chars[s.indexOf('que deux')]
      editor.viewport.showRect(editor.doc.box(p))
      return [c.x + 2, c.y - c.size * 0.3]
    })
    await win.evaluate(() => window.__feuillet.tools.set('edittext'))
    await clickAt(at[0], at[1])
    await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject()?.text !== undefined, null, { timeout: 8000 }).catch(() => {})
    const item = await win.evaluate(() => {
      const o = window.__feuillet.editor.canvas.getActiveObject()
      if (!o) return null
      const italic = []
      for (const line of Object.values(o.styles)) for (const [i, st] of Object.entries(line)) if (st.fontStyle === 'italic') italic.push(o._unwrappedTextLines[0][i])
      return { lines: o._textLines.map((l) => l.join('')), indent: o.firstIndent, italic: italic.join(''), cs: o.charSpacing }
    })
    check('list item: whole item taken (label line + hanging lines, not the previous item)', item && item.lines.length === 4 && /^\(d\)/.test(item.lines[0]) && !/sous-tendant \?$/.test(item.lines[0]), JSON.stringify(item?.lines))
    check('list item: label hangs left of the following lines', item && item.indent < -10, JSON.stringify(item?.indent))
    check('list item: italic words kept (forêt sous-tendante, G, n, m, c)', item && /forêtsous-tendante/.test(item.italic) && (item.italic.match(/G/g) ?? []).length === 3 && /nmc$/.test(item.italic), item?.italic)
    await win.keyboard.press('Escape')
    await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  }

  // Débordement : un paragraphe en bas de page grandit ; la dernière ligne poussée hors de la
  // page passe en haut d'une page de suite (vectorielle), qui disparaît s'il rétrécit.
  {
    const { PDFDocument, StandardFonts } = require('pdf-lib')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pg = pdf.addPage([595.28, 841.89])
    pg.drawText('Titre en haut de page', { x: 60, y: 780, size: 18, font })
    const para = ['Ce paragraphe se trouve vers le bas de la page et va grandir', 'beaucoup quand on lui ajoute des phrases pendant le test.']
    para.forEach((l, i) => pg.drawText(l, { x: 60, y: 160 - i * 16, size: 12, font }))
    pg.drawText('Derniere ligne tout en bas', { x: 60, y: 40, size: 12, font })
    const data = Buffer.from(await pdf.save()).toString('base64')
    await win.evaluate(() => window.feuillet.setDirty(false))
    await win.evaluate((b) => window.__feuillet.importer.open([{ name: 'bas.pdf', data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), data)
    await win.waitForTimeout(600)
    await win.evaluate(() => { const { editor } = window.__feuillet; editor.viewport.showRect(editor.doc.box(editor.doc.pages[0])); window.__feuillet.tools.set('edittext') })
    await clickAt(100, 841.89 - 160 - 4)
    await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject()?.text !== undefined, null, { timeout: 8000 }).catch(() => {})
    await win.keyboard.press('Control+End')
    await win.keyboard.type(' Une longue phrase ajoutée pour pousser la suite vers le bas de la page. Encore une phrase, puis une autre, et encore une autre pour être bien sûr de déborder de la page. Et une dernière phrase assez longue pour ajouter encore deux lignes au paragraphe.')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(1200)
    const st = await win.evaluate(async () => {
      const { editor } = window.__feuillet
      const pages = editor.doc.pages
      const ov = editor.doc.content.find((o) => o.flowOverflow)
      return { shifts: pages[0].shifts, pages: pages.length, flowFrom: !!pages[1]?.flowFrom, overflow: !!ov, onPage2: ov ? editor.doc.pageAt(ov.getCenterPoint()) === pages[1] : false, crop: ov && { y: ov.cropY, h: ov.height } }
    })
    check('overflow: a continuation page is created after the page', st.pages === 2 && st.flowFrom, JSON.stringify(st))
    check('overflow: the pushed line is shown at the top of the next page', st.overflow && st.onPage2, JSON.stringify(st))
    const file = await exportPdf('overflow.pdf')
    const page2 = execFileSync('pdftotext', ['-f', '2', '-l', '2', file, '-']).toString()
    const page1 = execFileSync('pdftotext', ['-f', '1', '-l', '1', file, '-']).toString()
    check('overflow export: the line is on page 2, as real text', /Derniere ligne tout en bas/.test(page2) && !/Derniere ligne/.test(page1.replace(/\s+/g, ' ').split('page.').pop() ?? ''), JSON.stringify(page2.slice(0, 80)))
    // Rétrécit : Ctrl+Z jusqu'à revenir au texte d'origine → plus de page de suite
    for (let i = 0; i < 6; i++) { await win.keyboard.press('Control+z'); await win.waitForTimeout(150) }
    await win.waitForTimeout(600)
    const back = await win.evaluate(() => ({ pages: window.__feuillet.editor.doc.pages.length, overflow: window.__feuillet.editor.doc.content.some((o) => o.flowOverflow) }))
    check('overflow: undo removes the continuation page', back.pages === 1 && !back.overflow, JSON.stringify(back))
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
