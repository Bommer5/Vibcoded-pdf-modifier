// Mesure de performance : ouverture d'un PDF de 100 pages, mémoire, défilement, annulation.
// Utilisation : xvfb-run -a node tests/e2e/perf.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

;(async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 100; i++) {
    const p = pdf.addPage([595.28, 841.89])
    for (let l = 0; l < 40; l++) p.drawText(`Page ${i} ligne ${l} : le texte du document de test pour mesurer les performances`, { x: 50, y: 790 - l * 18, size: 10, font })
    p.drawRectangle({ x: 50, y: 40, width: 495, height: 20, color: rgb(0.3, 0.5, 0.8) })
  }
  const bytes = await pdf.save()
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => window.__feuillet.welcome?.hide())
  await win.evaluate(() => (window.confirm = () => true))
  const mem = async () => {
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
    return metrics.reduce((a, m) => a + m.memory.workingSetSize, 0) /* Ko */
  }
  const m0 = await mem()
  const t0 = Date.now()
  await win.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    await window.__feuillet.importer.open([{ name: 'gros.pdf', data }])
  }, Buffer.from(bytes).toString('base64'))
  const openMs = Date.now() - t0
  await win.waitForTimeout(1500)
  const m1 = await mem()
  // Défilement sur tout le document
  const t1 = Date.now()
  for (let i = 0; i < 40; i++) await win.mouse.wheel(0, 1200)
  await win.waitForTimeout(1000)
  const scrollMs = Date.now() - t1
  // Trait + annulation
  await win.keyboard.press('KeyP')
  const box = await win.locator('#workspace').boundingBox()
  await win.mouse.move(box.x + 300, box.y + 300); await win.mouse.down(); await win.mouse.move(box.x + 500, box.y + 350, { steps: 10 }); await win.mouse.up()
  const t2 = Date.now()
  await win.keyboard.press('Control+KeyZ')
  await win.evaluate(() => window.__feuillet.editor.history.idle())
  const undoMs = Date.now() - t2
  const m2 = await mem()
  const jsHeapMB = await win.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576))
  const pageCacheMB = await win.evaluate(() => Math.round((window.__feuillet.pageRenderer?.memoryBytes ?? 0) / 1048576))
  const result = { jsHeapMB, pageCacheMB, openMs, scrollMs, undoMs, memStartMB: Math.round(m0 / 1024), memAfterOpenMB: Math.round(m1 / 1024), memEndMB: Math.round(m2 / 1024) }
  console.log(JSON.stringify(result))
  fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(result, null, 2))
  await win.evaluate(() => window.feuillet.setDirty(false)).catch(() => {})
  await app.close()
})().catch((e) => { console.error(e); process.exit(1) })
