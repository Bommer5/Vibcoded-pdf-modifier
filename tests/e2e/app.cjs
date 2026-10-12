const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
// Utilisation : node tests/e2e/fixtures.cjs <fx> && node tests/e2e/app.cjs <racine> <fx> <sortie>
// (sous Linux sans écran : xvfb-run -a …). Nécessite LibreOffice pour les tests bureautiques.
const [root, fx, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const b64 = (f) => fs.readFileSync(path.join(fx, f)).toString('base64')
const results = []
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`) }

;(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => window.__feuillet.welcome?.hide())
  await win.evaluate(() => { window.__file = (name, b64) => ({ name, path: undefined, data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }); window.confirm = () => true })
  const stats = () => win.evaluate(() => { const { doc } = window.__feuillet.editor; return { pages: doc.pages.length, content: doc.content.length } })

  // 1. Open PDF
  await win.evaluate(([b]) => window.__feuillet.importer.open([window.__file('sample.pdf', b)]), [b64('sample.pdf')])
  let s = await stats(); check('open pdf', s.pages === 3, JSON.stringify(s))
  await win.screenshot({ path: path.join(outDir, '1-pdf.png') })

  // 2. Insert images/svg/text at center of page 1
  for (const f of ['image.png', 'image.tiff', 'drawing.svg', 'notes.txt']) {
    await win.evaluate(([n, b]) => window.__feuillet.importer.insert([window.__file(n, b)], null), [f, b64(f)])
  }
  s = await stats(); check('insert 4 objects', s.content === 4, JSON.stringify(s))

  // 3. Pen stroke
  const box = await win.locator('#workspace').boundingBox()
  await win.keyboard.press('KeyP')
  await win.mouse.move(box.x + 300, box.y + 150); await win.mouse.down()
  for (let i = 0; i < 15; i++) await win.mouse.move(box.x + 300 + i * 8, box.y + 150 + (i % 3) * 6)
  await win.mouse.up()
  s = await stats(); check('pen stroke', s.content === 5, JSON.stringify(s))

  // 4. Select via rubber band, copy, paste at pointer, drag
  await win.keyboard.press('KeyV')
  await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
  await win.mouse.move(box.x + 290, box.y + 140); await win.mouse.down(); await win.mouse.move(box.x + 450, box.y + 190, { steps: 5 }); await win.mouse.up()
  const selCount = await win.evaluate(() => window.__feuillet.editor.canvas.getActiveObjects().length)
  check('rubber-band selects stroke', selCount >= 1, `selected=${selCount}`)
  await win.keyboard.press('Control+KeyC')
  await win.mouse.move(box.x + 600, box.y + 400)
  await win.keyboard.press('Control+KeyV')
  s = await stats(); check('paste adds copy', s.content === 5 + selCount, JSON.stringify(s))
  const pasted = await win.evaluate(() => { const c = window.__feuillet.editor.canvas; const a = c.getActiveObject(); const p = a.getCenterPoint().transform(c.viewportTransform); return { x: p.x, y: p.y, n: c.getActiveObjects().length } })
  const ws = await win.evaluate(() => { const r = window.__feuillet.editor.canvas.upperCanvasEl.getBoundingClientRect(); return { x: r.left, y: r.top } })
  check('pasted under pointer & selected', Math.abs(pasted.x + ws.x - (box.x + 600)) < 3 && Math.abs(pasted.y + ws.y - (box.y + 400)) < 3, JSON.stringify(pasted))
  // drag pasted object
  const before = await win.evaluate(() => window.__feuillet.editor.canvas.getActiveObject().left)
  await win.mouse.move(box.x + 600, box.y + 400); await win.mouse.down(); await win.mouse.move(box.x + 650, box.y + 450, { steps: 6 }); await win.mouse.up()
  await win.mouse.move(box.x + 600, box.y + 400)
  const after = await win.evaluate(() => { const c = window.__feuillet.editor.canvas; return c.getActiveObject().left })
  check('drag moves selection', before !== null && after !== null && Math.abs(after - before) > 20, `${before} -> ${after}`)
  // second paste offset
  await win.keyboard.press('Control+KeyV')
  s = await stats(); check('second paste', s.content === 5 + 2 * selCount, JSON.stringify(s))
  await win.keyboard.press('Control+KeyZ')
  await win.evaluate(() => window.__feuillet.editor.history.idle())
  s = await stats(); check('undo paste = one step', s.content === 5 + selCount, JSON.stringify(s))
  // duplicate, group, ungroup
  await win.keyboard.press('Control+KeyA')
  const all = await win.evaluate(() => window.__feuillet.editor.canvas.getActiveObjects().length)
  check('select all', all === (await stats()).content, `all=${all}`)
  await win.keyboard.press('Control+KeyG')
  s = await stats(); check('group', s.content === 1, JSON.stringify(s))
  await win.keyboard.press('Control+Shift+KeyG')
  s = await stats(); check('ungroup', s.content === all, JSON.stringify(s))
  await win.keyboard.press('Escape')
  await win.screenshot({ path: path.join(outDir, '2-edited.png') })

  // 5. Exports
  const formats = ['pdf', 'png', 'jpg', 'webp', 'tiff', 'svg', 'docx', 'feuillet', 'docx-text', 'odt', 'rtf']
  for (const id of formats) {
    try {
      const out = await win.evaluate(async (id) => {
        const { exporter, editor } = window.__feuillet
        const format = window.__feuillet.formats.find((f) => f.id === id)
        const parts = await exporter.render({ format, pages: editor.doc.pages, dpi: 100, name: 'test' })
        const enc = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
        return { ext: format.ext, parts: parts.map(enc) }
      }, id)
      out.parts.forEach((p, i) => fs.writeFileSync(path.join(outDir, `export-${id}-${i + 1}.${out.ext}`), Buffer.from(p, 'base64')))
      check(`export ${id}`, out.parts.length > 0 && out.parts[0].length > 100, `${out.parts.length} file(s)`)
    } catch (e) { check(`export ${id}`, false, String(e).slice(0, 300)) }
  }

  // 6. Reopen project
  const before2 = await stats()
  await win.evaluate(([b]) => window.__feuillet.importer.open([window.__file('test.feuillet', b)]), [fs.readFileSync(path.join(outDir, 'export-feuillet-1.feuillet')).toString('base64')])
  s = await stats(); check('reopen project', s.pages === before2.pages && s.content === before2.content, JSON.stringify(s))

  // 6b. Rotated page overlay
  await win.evaluate(([b]) => window.__feuillet.importer.open([window.__file('sample.pdf', b)]), [b64('sample.pdf')])
  const out3 = await win.evaluate(async ([png]) => {
    const { importer, exporter, editor, formats } = window.__feuillet
    const p3 = editor.doc.pages[2]
    const at = { x: p3.left + 100, y: p3.top + 80, distanceFrom: () => 99 }
    await importer.insert([window.__file('image.png', png)], at)
    await importer.insert([window.__file('t.txt', btoa('Texte ajouté ici'))], { x: p3.left + 200, y: p3.top + 200 })
    const parts = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; const u = parts[0]; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  }, [b64('image.png')])
  fs.writeFileSync(path.join(outDir, 'rotated.pdf'), Buffer.from(out3, 'base64'))
  await win.evaluate(() => { const { viewport, doc } = window.__feuillet.editor; viewport.fit(doc.box(doc.pages[2])) })
  await win.screenshot({ path: path.join(outDir, '5-rotated-screen.png') })

  // 7. Office + Xournal
  await win.evaluate(([b]) => window.__feuillet.importer.open([window.__file('lettre.docx', b)]), [b64('lettre.docx')])
  s = await stats(); check('open docx via LibreOffice', s.pages >= 1 && await win.evaluate(() => window.__feuillet.editor.doc.pages[0].bg.kind === 'pdf'), JSON.stringify(s))
  await win.screenshot({ path: path.join(outDir, '3-docx.png') })
  await win.evaluate(([b, p]) => window.__feuillet.importer.open([{ ...window.__file('carnet.xopp', b), path: p }]), [b64('carnet.xopp'), path.join(fx, 'carnet.xopp')])
  s = await stats(); check('open xopp', s.pages === 2 && s.content === 4, JSON.stringify(s))
  await win.evaluate(() => { const { viewport, doc } = window.__feuillet.editor; viewport.fit(doc.bounds()) })
  await win.screenshot({ path: path.join(outDir, '4-xopp.png') })

  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
