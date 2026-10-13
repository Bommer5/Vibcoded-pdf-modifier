// Barre de mise en forme du texte façon Word : boutons, menus, raccourcis, listes,
// espacement des paragraphes, annulation, export PDF.
// Utilisation : xvfb-run -a node tests/e2e/word-format.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const NB = ' '

;(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()))
  const box = await win.locator('#workspace').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const obj = () => win.evaluate(() => {
    const o = window.__feuillet.editor.doc.content.at(-1)
    const st = (i) => o.getSelectionStyles(i, i + 1)[0] ?? {}
    return { text: o.text, fontWeight: o.fontWeight, textAlign: o.textAlign, lineHeight: o.lineHeight, height: o.height, ps: o.paragraphSpacing ?? 0,
      s0: st(0), s8: st(8), s14: st(14), editing: o.isEditing, sel: [o.selectionStart, o.selectionEnd] }
  })
  const tb = (title) => win.locator(`.text-toolbar button[title="${title}"]`)
  const menu = async (title, item) => {
    await win.locator(`.text-toolbar button[title="${title}"]`).click()
    await win.locator(`.tt-menu [title="${item}"]`).click()
  }

  check('toolbar hidden without text', await win.locator('.text-toolbar').isHidden())
  await win.keyboard.press('KeyT')
  await win.mouse.click(...at(250, 150))
  await win.keyboard.type('Bonjour le monde')
  check('toolbar visible while typing', await win.locator('.text-toolbar').isVisible())
  const groups = await win.locator('.text-toolbar .tt-group').evaluateAll((g) => g.map((x) => x.getAttribute('aria-label')))
  check('toolbar organised like Word (Police · Caractères · Paragraphe)', groups.join() === 'Police,Caractères,Paragraphe', groups.join())

  // Ctrl+B, curseur dans un mot → tout le mot (comme Word)
  await win.keyboard.press('Home')
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('Control+b')
  let o = await obj()
  check('Ctrl+B on caret bolds the word', o.s0.fontWeight === 'bold' && o.s8.fontWeight !== 'bold' && o.fontWeight !== 'bold', JSON.stringify([o.s0, o.s8]))
  check('bold button reflects state', (await tb('Gras (Ctrl+B)').getAttribute('aria-pressed')) === 'true')

  // Sélection « monde » : bouton Souligné + Ctrl+I
  await win.keyboard.press('End')
  for (let i = 0; i < 5; i++) await win.keyboard.press('Shift+ArrowLeft')
  await tb('Souligné (Ctrl+U)').click()
  await win.keyboard.press('Control+i')
  o = await obj()
  check('underline + italic on selection', o.s14.underline === true && o.s14.fontStyle === 'italic' && !o.s0.underline, JSON.stringify(o.s14))
  check('still editing after toolbar click', o.editing)

  await win.fill('.text-toolbar .tt-size', '28')
  await win.press('.text-toolbar .tt-size', 'Enter')
  o = await obj()
  check('size field on selection', o.s14.fontSize === 28 && o.s0.fontSize !== 28, JSON.stringify([o.s14.fontSize, o.s0.fontSize]))
  await win.keyboard.press('Control+Shift+Period')
  o = await obj()
  check('Ctrl+Shift+> grows to next size', o.s14.fontSize === 36, String(o.s14.fontSize))
  await win.keyboard.press('Control+Shift+Equal')
  o = await obj()
  check('superscript', o.s14.deltaY < 0, JSON.stringify(o.s14))
  await win.keyboard.press('Control+Shift+Equal')
  o = await obj()
  check('superscript toggles off to previous size', !o.s14.deltaY && o.s14.fontSize === 36, JSON.stringify(o.s14))

  // Couleur : menu ▾ avec palette
  await menu('Couleur du texte', '#ff0000')
  o = await obj()
  check('text color from menu', o.s14.fill === '#ff0000', String(o.s14.fill))
  check('menu closes after choice', (await win.locator('.tt-menu').count()) === 0)

  // Listes : puces (raccourci), puis numérotation (bouton)
  await win.keyboard.press('Control+e')
  await win.keyboard.press('Control+Shift+l')
  o = await obj()
  check('Ctrl+E centers, Ctrl+Shift+L bullets', o.textAlign === 'center' && o.text.startsWith(`•${NB}Bonjour`), JSON.stringify([o.textAlign, o.text]))
  check('styles follow inserted bullet', o.s0.fontWeight !== 'bold', JSON.stringify(o.s0))
  check('selection follows inserted bullet', o.sel[0] === 13 && o.sel[1] === 18, JSON.stringify(o.sel))
  await tb('Numérotation').click()
  o = await obj()
  check('numbered list replaces bullets', o.text.startsWith(`1.${NB}Bonjour`), o.text)

  // Entrée continue la liste et renumérote ; Entrée sur un élément vide la termine
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.type('deux')
  await win.keyboard.press('Enter')
  await win.keyboard.type('trois')
  o = await obj()
  check('Enter continues numbering', o.text === `1.${NB}Bonjour le monde\n2.${NB}deux\n3.${NB}trois`, JSON.stringify(o.text))
  // Tab : sous-niveau, numérotation repart à 1 ; Maj+Tab revient
  await win.keyboard.press('Home')
  await win.keyboard.press('Tab')
  o = await obj()
  check('Tab indents list item', o.text.endsWith(`\n${NB.repeat(4)}1.${NB}trois`), JSON.stringify(o.text))
  await win.keyboard.press('Shift+Tab')
  o = await obj()
  check('Shift+Tab outdents', o.text.endsWith(`\n3.${NB}trois`), JSON.stringify(o.text))
  // Style de numérotation depuis le menu ▾
  await menu('Numérotation : styles et niveaux', 'Numérotation a.')
  o = await obj()
  check('numbering style from library', o.text.endsWith(`\nc.${NB}trois`) || o.text.includes(`c.${NB}trois`), JSON.stringify(o.text))
  await menu('Numérotation : styles et niveaux', 'Numérotation 1.')
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter')
  o = await obj()
  check('Enter on empty item ends the list', o.text.endsWith(`3.${NB}trois\n`), JSON.stringify(o.text))
  await win.keyboard.type('Fin')
  // Puces depuis la bibliothèque, puis Retour arrière juste après la puce enlève la puce
  await menu('Puces : styles et niveaux', 'Puce ✓')
  o = await obj()
  check('bullet style from library', o.text.endsWith(`✓${NB}Fin`), JSON.stringify(o.text))
  await win.keyboard.press('Home')
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('Backspace')
  o = await obj()
  check('Backspace after bullet removes it', o.text.endsWith('\nFin'), JSON.stringify(o.text))
  await win.keyboard.type('X')
  o = await obj()
  check('typing after list edits stays in sync', o.text.endsWith('\nXFin'), JSON.stringify(o.text))
  await win.keyboard.press('Backspace')

  // Interligne et espacement entre paragraphes : menu ▾
  const h0 = (await obj()).height
  await menu('Interligne et espacement des paragraphes', 'Espacement 12 pt')
  o = await obj()
  check('paragraph spacing adds 12 pt between the 4 paragraphs', o.ps === 12 && Math.abs(o.height - h0 - 36) < 0.5, JSON.stringify([h0, o.height]))
  await menu('Interligne et espacement des paragraphes', 'Interligne 1.5')
  o = await obj()
  check('line spacing from menu', o.lineHeight === 1.5, String(o.lineHeight))
  const checked = await (async () => {
    await tb('Interligne et espacement des paragraphes').click()
    const c = await win.locator('.tt-menu [aria-checked="true"]').evaluateAll((b) => b.map((x) => x.title))
    await win.keyboard.press('Escape')
    return c
  })()
  check('menu shows current values with a check mark', checked.join() === 'Interligne 1.5,Espacement 12 pt', checked.join())
  check('Escape closes the menu', (await win.locator('.tt-menu').count()) === 0)

  // Annulation : une étape par mise en forme
  await win.keyboard.press('Escape')
  await win.keyboard.press('Control+z')
  o = await obj()
  check('undo restores line spacing only', o.lineHeight !== 1.5 && o.ps === 12, JSON.stringify([o.lineHeight, o.ps]))
  await win.keyboard.press('Control+Shift+z')

  // Mise en forme de tout l'objet quand il est sélectionné sans écrire
  await win.evaluate(() => { const { canvas, doc } = window.__feuillet.editor; canvas.setActiveObject(doc.content.at(-1)); canvas.fire('selection:created', {}) })
  await tb('Barré').click()
  check('strike on whole object', await win.evaluate(() => window.__feuillet.editor.doc.content.at(-1).linethrough === true))
  await tb('Barré').click()
  const props = await win.locator('.properties').innerText()
  check('no duplicated text options in the side panel', !/Interligne|Alignement|Gras/.test(props), JSON.stringify(props.slice(0, 120)))
  await win.screenshot({ path: path.join(outDir, 'word-format.png') })
  await tb('Interligne et espacement des paragraphes').click()
  await win.screenshot({ path: path.join(outDir, 'word-format-menu.png') })
  await win.keyboard.press('Escape')
  await tb('Numérotation : styles et niveaux').click()
  await win.screenshot({ path: path.join(outDir, 'word-format-numbering.png') })
  await win.keyboard.press('Escape')

  await tb('Effacer la mise en forme (Ctrl+Espace)').click()
  const cleared = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.at(-1); return { l: o.linethrough, styles: Object.keys(o.styles).length } })
  check('clear formatting', !cleared.l && cleared.styles === 0, JSON.stringify(cleared))
  await win.keyboard.press('Control+z')

  // Survit à l'enregistrement : espacement conservé par le format projet
  const saved = await win.evaluate(() => JSON.stringify(window.__feuillet.editor.doc.content.at(-1).toObject()))
  check('paragraph spacing saved with the object', JSON.parse(saved).paragraphSpacing === 12)

  // Export PDF : polices grasse/italique intégrées, espacement identique à l'écran
  const pdf = await win.evaluate(async () => {
    const { exporter, editor, formats } = window.__feuillet
    const [u] = await exporter.render({ format: formats[0], pages: editor.doc.pages, dpi: 100, name: 't' })
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s)
  })
  const file = path.join(outDir, 'word-format.pdf')
  fs.writeFileSync(file, Buffer.from(pdf, 'base64'))
  const fonts = execFileSync('pdffonts', [file]).toString()
  check('PDF embeds bold and italic fonts', /Bold\s.*yes\s+yes/.test(fonts) && /Italic\s.*yes\s+yes/.test(fonts), '\n' + fonts)
  const bbox = execFileSync('pdftotext', ['-bbox', file, '-']).toString()
  const ys = [...bbox.matchAll(/yMin="([\d.]+)"[^>]*>(deux|trois|Fin)</g)].map((m) => [m[2], Number(m[1])])
  const y = Object.fromEntries(ys)
  const screen = await win.evaluate(() => { const o = window.__feuillet.editor.doc.content.at(-1); return [o.getHeightOfLine(1), o.getHeightOfLine(2)] })
  check('PDF line gaps match the screen (with spacing)', ys.length === 3 && Math.abs((y.trois - y.deux) - screen[1]) < 1.5, JSON.stringify({ y, screen }))

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
