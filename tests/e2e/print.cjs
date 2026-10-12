// Impression : l'envoi à l'imprimante est redirigé vers un PDF pour vérifier pages, formats et contenu.
// Utilisation : xvfb-run -a node tests/e2e/print.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { readGray, darkCount } = require('./lib/image.cjs')
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
  // Imprimante simulée : chaque impression produit un PDF (même moteur que l'impression réelle).
  await app.evaluate(({ app }) => {
    app.on('web-contents-created', (_e, wc) => {
      wc.print = (_opts, cb) => {
        wc.printToPDF({ preferCSSPageSize: true, printBackground: true }).then((buf) => {
          globalThis.__printed = buf
          cb(true, '')
        })
      }
    })
  })
  // Document : page A4 portrait avec texte + page paysage
  await win.evaluate(async () => {
    const { editor, make } = window.__feuillet
    const page = editor.doc.pages[0]
    editor.add(make.textbox('Imprimé par Feuillet', { left: page.left + 60, top: page.top + 60, width: 400, fontSize: 28, fontFamily: 'Arial' }))
    editor.doc.addPage({ width: 841.89, height: 595.28 })
  })
  await win.keyboard.press('Control+KeyP')
  await win.waitForFunction(() => document.querySelector('.toast.success')?.textContent?.includes('imprimante'), null, { timeout: 30000 })
  const b64 = await app.evaluate(() => Buffer.from(globalThis.__printed).toString('base64'))
  const file = path.join(outDir, 'printed.pdf')
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  const info = execFileSync('pdfinfo', ['-f', '1', '-l', '2', file]).toString()
  const pages = Number(info.match(/Pages:\s+(\d+)/)[1])
  const sizes = [...info.matchAll(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => [Math.round(m[1]), Math.round(m[2])])
  check('print: one sheet per page', pages === 2, `pages=${pages}`)
  check('print: each page at its own size (A4 portrait, then landscape)', sizes[0]?.[0] === 595 && sizes[0]?.[1] === 842 && sizes[1]?.[0] === 842 && sizes[1]?.[1] === 595, JSON.stringify(sizes))
  execFileSync('pdftoppm', ['-r', '50', '-f', '1', '-l', '1', '-png', '-singlefile', file, path.join(outDir, 'printed')])
  const dark = darkCount(await readGray(app, path.join(outDir, 'printed.png')))
  check('print: page content rendered (text visible)', Number(dark) > 200, `pixels sombres=${dark}`)
  console.log(results.join('\n'))
  console.log('errors:', errors)
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exit(1)
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1) })
