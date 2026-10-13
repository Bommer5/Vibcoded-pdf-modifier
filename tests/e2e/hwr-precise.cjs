// Moteur d'écriture précis (TrOCR) : téléchargement (ici depuis un dossier local), chargement,
// lecture d'une ligne, décodage avec cache = sans cache, accents rétablis, repli sur le modèle
// intégré. Le modèle de test est un TrOCR miniature à poids aléatoires (même format de
// fichiers que le vrai) : on vérifie la mécanique, pas la qualité de lecture.
// Utilisation : xvfb-run -a node tests/e2e/hwr-precise.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path'), os = require('os')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

async function launch(variant, userData) {
  const app = await _electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [root, '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, FEUILLET_HWR_DIR: variant ? path.join(root, 'tests/fixtures/trocr-mini', variant) : '' }
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()))
  return { app, win, errors }
}

// Une ligne d'écriture : « le » en traits simples
const line = [
  [[0, 0], [0, 40], [2, 42]],
  [[10, 30], [24, 28], [22, 20], [12, 22], [10, 34], [22, 42], [28, 40]]
]

;(async () => {
  const outputs = {}
  for (const variant of ['merged', 'plain']) {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'feuillet-hwr-'))
    const { app, win, errors } = await launch(variant, ud)
    const before = await win.evaluate(() => window.__feuillet.hwrTools.precise.installed())
    check(`${variant}: not installed at first`, before === false)
    const progress = []
    const ready = await win.evaluate(async () => {
      const seen = []
      const ok = await window.__feuillet.hwrTools.precise.download((f) => seen.push(f))
      return { ok, seen }
    })
    progress.push(...ready.seen)
    check(`${variant}: download then load`, ready.ok === true, JSON.stringify(ready).slice(0, 120))
    check(`${variant}: progress reported`, progress.length > 0 && progress.every((f) => f >= 0 && f <= 1), progress.slice(-3).join(','))
    check(`${variant}: files kept in the app data`, fs.existsSync(path.join(ud, 'hwr-models', 'Xenova--trocr-small-handwritten', 'files.json')))
    const r = await win.evaluate(async (lines) => {
      const t0 = performance.now()
      const res = await window.__feuillet.hwrTools.handwriting.recognize(lines)
      return { res, ms: performance.now() - t0 }
    }, [line, line.map((s) => s.map(([x, y]) => [x + 100, y]))])
    const c = r.res[0]?.[0]
    check(`${variant}: one result per line, with a confidence`, r.res.length === 2 && typeof c?.text === 'string' && c.conf > 0 && c.conf <= 1, JSON.stringify(c)?.slice(0, 100))
    check(`${variant}: same line → same reading (position does not matter)`, r.res[1]?.[0]?.text === c?.text)
    outputs[variant] = c?.text
    outputs[variant + 'Score'] = c?.score
    await win.evaluate(() => window.feuillet.setDirty(false))
    check(`${variant}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '))
    // Redémarrage : le moteur est déjà là, sans nouveau téléchargement
    await app.close()
    const again = await launch('', ud)
    check(`${variant}: still installed after restart (offline)`, (await again.win.evaluate(() => window.__feuillet.hwrTools.precise.ready())) === true)
    await again.win.evaluate(() => window.feuillet.setDirty(false))
    await again.app.close()
  }
  // Même texte et mêmes probabilités pas à pas (à l'arrondi de la quantification près)
  check('decoding with cache = without cache', outputs.merged === outputs.plain && !!outputs.merged && Math.abs(outputs.mergedScore - outputs.plainScore) < 0.5, JSON.stringify([outputs.mergedScore, outputs.plainScore]))

  // Accents rétablis avec le dictionnaire ; repli sur le modèle intégré sans moteur précis
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'feuillet-hwr-'))
  const { app, win } = await launch('', ud)
  const acc = await win.evaluate(async () => {
    const { precise } = window.__feuillet.hwrTools
    const map = await precise.accentMap()
    const { restoreAccents } = window.__feuillet.hwrTools
    return ['ete', 'Ete', 'francais', 'ou', 'a', 'eleve', 'deja', 'COUCOU', 'probleme'].map((w) => restoreAccents(w, map))
  })
  check('accents restored from the French dictionary', acc.join(' ') === 'été Été français ou a élevé déjà COUCOU problème', acc.join(' '))
  const fallback = await win.evaluate(async () => {
    const res = await window.__feuillet.hwrTools.handwriting.recognize([[[[0, 0], [0, 40]], [[10, 30], [24, 28], [22, 20], [12, 22], [10, 34], [22, 42]]]])
    return Array.isArray(res) && res.length === 1
  })
  check('without the precise engine, the built-in model still answers', fallback)
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()

  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
