// Qualité de l'export PDF : vraies polices intégrées, texte extractible, rendu identique à l'écran,
// ordre d'empilement, repli image pour les caractères absents des polices.
// Utilisation : xvfb-run -a node tests/e2e/pdf-quality.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { readGray, diffPercent, pixel } = require('./lib/image.cjs')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

;(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => window.__feuillet.welcome?.hide())
  // Contenu créé via l'API de l'application (mêmes classes que l'interface).
  await win.evaluate(async () => {
    const { editor, tools } = window.__feuillet
    const page = editor.doc.pages[0]
    const add = (o) => editor.add(o)
    const make = window.__feuillet.make
    add(make.textbox('Été à l’école : « ça marche » — œuvre déjà vue.', { left: page.left + 50, top: page.top + 60, width: 420, fontSize: 18, fontFamily: 'Arial' }))
    const styled = make.textbox('Gras Italique Souligné Barré', { left: page.left + 50, top: page.top + 110, width: 420, fontSize: 16, fontFamily: 'Times New Roman' })
    styled.setSelectionStyles({ fontWeight: 'bold' }, 0, 4)
    styled.setSelectionStyles({ fontStyle: 'italic' }, 5, 13)
    styled.setSelectionStyles({ underline: true }, 14, 22)
    styled.setSelectionStyles({ linethrough: true }, 23, 28)
    add(styled)
    add(make.textbox('Texte justifié sur plusieurs lignes pour vérifier que les espaces sont élargis exactement comme à l’écran dans le PDF exporté.', { left: page.left + 50, top: page.top + 150, width: 260, fontSize: 12, textAlign: 'justify-left', fontFamily: 'Calibri', fill: '#1f4e79' }))
    const t = make.table(3, 2)
    t.set({ left: page.left + 50, top: page.top + 260 })
    t.setCell(0, 0, 'Produit'); t.setCell(0, 1, 'Quantité'); t.setCell(1, 0, 'Crème brûlée'); t.setCell(1, 1, '12')
    add(t)
    add(make.textbox('CACHÉ', { left: page.left + 50, top: page.top + 380, width: 200, fontSize: 30, fontFamily: 'Arial' }))
    add(make.rect({ left: page.left + 40, top: page.top + 375, width: 220, height: 45, fill: '#30a46c' })) // posé PAR-DESSUS le texte « CACHÉ »
    add(make.textbox('Bonjour 😀 monde', { left: page.left + 50, top: page.top + 450, width: 300, fontSize: 20, fontFamily: 'Arial' }))
    editor.canvas.requestRenderAll()
  })
  const pdf = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  const file = path.join(outDir, 'quality.pdf')
  fs.writeFileSync(file, Buffer.from(pdf, 'base64'))
  // Image de référence : rendu écran de la page (même moteur que l'affichage).
  const png = await win.evaluate(async () => {
    const { exporter, editor } = window.__feuillet
    const c = await exporter.raster(editor.doc.pages[0], 100)
    return c.toDataURL('image/png').split(',')[1]
  })
  fs.writeFileSync(path.join(outDir, 'screen.png'), Buffer.from(png, 'base64'))

  const fonts = execFileSync('pdffonts', [file]).toString()
  const embeddedLines = fonts.split('\n').slice(2).filter((l) => l.trim())
  const real = embeddedLines.filter((l) => /TrueType|CID/.test(l))
  check('real fonts embedded', real.length >= 3 && real.every((l) => /\byes\s+yes\b/.test(l)), '\n' + fonts)
  check('no standard Helvetica/Times for user text', !embeddedLines.some((l) => /^(Helvetica|Times-Roman)\s/.test(l)), '')
  const txt = execFileSync('pdftotext', ['-layout', file, '-']).toString()
  check('accents extractable', txt.includes('Été à l’école') && txt.includes('œuvre'), JSON.stringify(txt.slice(0, 200)))
  check('table text extractable', txt.includes('Crème brûlée') && txt.includes('Quantité'))
  check('emoji text kept (image fallback)', !txt.includes('Bonjour 😀'), '')
  execFileSync('pdftoppm', ['-r', '100', '-png', '-singlefile', file, path.join(outDir, 'pdf')])
  // Comparaison pixel à pixel (lecture des images par Electron)
  const screen = await readGray(app, path.join(outDir, 'screen.png'))
  const printed = await readGray(app, path.join(outDir, 'pdf.png'))
  const diff = diffPercent(screen, printed)
  check('PDF looks like the screen (pixels differing > 15%)', diff < 1.6, `${diff.toFixed(3)} % des pixels`)
  // Le rectangle vert couvre « CACHÉ » : au centre du mot, on doit voir le vert, pas le texte noir.
  const g = pixel(printed, ((50 + 100) * printed.width) / 595.28, ((380 + 15) * printed.height) / 841.89)
  check('z-order kept: shape above text', g > 80 && g < 160, `gris=${g}`)
  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
