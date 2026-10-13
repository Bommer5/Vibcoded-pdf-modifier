// Banc d'essai « écriture → texte », de bout en bout dans l'application : de vrais traits de
// stylo (écriture tirée de polices manuscrites jamais vues à l'entraînement) sont posés sur la
// page puis convertis comme en mode automatique. Variantes : écriture penchée, ondulée, mots
// serrés, petite / grande écriture, deux lignes, texte souligné ou entouré ; et des dessins
// (traits, flèches, cercles, cadres, axes, courbes, gribouillis) qui doivent rester de l'encre.
// Utilisation : xvfb-run -a node tests/e2e/hwr-bench.cjs <racine> <sortie> [nombre]
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
const [root, outDir, countArg] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const bench = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/hwr-bench.json'), 'utf8'))
const N = Number(countArg) || 60

function lev(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = t
    }
  }
  return prev[b.length]
}
const norm = (s) => s.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

// Transformations des traits (repère local, origine en haut à gauche de l'écriture)
const bbox = (strokes) => {
  const xs = strokes.flat().map((p) => p[0]), ys = strokes.flat().map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
const tf = (strokes, f) => strokes.map((s) => s.map(([x, y]) => f(x, y)))
const VARIANTS = {
  normal: (s) => s,
  'penchée +8°': (s) => rot(s, 8),
  'penchée -8°': (s) => rot(s, -8),
  'penchée +15°': (s) => rot(s, 15),
  ondulée: (s) => { const b = bbox(s); const H = b.y1 - b.y0; return tf(s, (x, y) => [x, y + H * 0.25 * Math.sin((x - b.x0) / (H * 3))]) },
  'petite (×0,5)': (s) => tf(s, (x, y) => [x * 0.5, y * 0.5]),
  'grande (×2,5)': (s) => tf(s, (x, y) => [x * 2.5, y * 2.5])
}
function rot(s, deg) {
  const b = bbox(s), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a)
  return tf(s, (x, y) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c])
}

;(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => { (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()); window.confirm = () => true })

  /** Pose des groupes de traits sur la page, convertit, renvoie les textes créés et l'encre restante. */
  const run = (groups, manual = false) => win.evaluate(async ([groups, manual]) => {
    const { editor, make, hwr } = window.__feuillet
    for (const o of [...editor.doc.content]) editor.canvas.remove(o)
    const p = editor.doc.pages[0]
    const inks = []
    for (const g of groups) for (const s of g.strokes) {
      const o = make.ink(s.map(([x, y]) => [p.left + g.x + x, p.top + g.y + y]))
      editor.add(o)
      inks.push(o)
    }
    const t0 = performance.now()
    await hwr.convert(inks, manual)
    const ms = performance.now() - t0
    const texts = editor.doc.content.filter((o) => o.hwr).sort((a, b) => a.top - b.top || a.left - b.left).map((o) => ({ text: o.text, top: o.top - p.top, left: o.left - p.left, size: o.fontSize, angle: o.angle }))
    const ink = editor.doc.content.filter((o) => o.ink).length
    return { texts, ink, ms }
  }, [groups, manual])
  // Première conversion : chargement du modèle
  const t0 = Date.now()
  await run([{ x: 40, y: 80, strokes: bench.writing[0].strokes }])
  const loadMs = Date.now() - t0

  const rows = []
  const stats = {}
  let lineMs = 0, lines = 0
  for (const [vname, f] of Object.entries(VARIANTS)) {
    const items = bench.writing.slice(0, vname === 'normal' ? N : Math.ceil(N / 2))
    let errs = 0, chars = 0, exact = 0, converted = 0, wordsOk = 0, words = 0
    for (const it of items) {
      const st = f(it.strokes)
      const b = bbox(st)
      const r = await run([{ x: 40 - b.x0, y: 120 - b.y0, strokes: st }])
      const got = norm(r.texts.map((t) => t.text).join(' '))
      const truth = norm(it.text)
      if (r.texts.length) converted++
      lineMs += r.ms
      lines++
      errs += lev(got, truth)
      chars += truth.length
      exact += got === truth
      const tw = truth.split(' '), gw = got.split(' ')
      words += tw.length
      wordsOk += tw.filter((w, i) => gw[i] === w).length
      if (vname === 'normal' && rows.length < 400) rows.push(`| ${truth.replace(/\|/g, '\\|')} | ${got.replace(/\|/g, '\\|') || '*(encre gardée)*'} | ${it.font}${it.tight ? ', serré' : ''} |`)
    }
    stats[vname] = { cer: (100 * errs) / chars, exact: (100 * exact) / items.length, conv: (100 * converted) / items.length, words: (100 * wordsOk) / words, n: items.length }
  }

  // Maths, parenthèses et symboles (∑ / % \\ √ …) : série fixe
  const mathRows = []
  let mErr = 0, mChars = 0, mExact = 0, parTotal = 0, parOk = 0
  for (const it of bench.math ?? []) {
    const b = bbox(it.strokes)
    const r = await run([{ x: 40 - b.x0, y: 120 - b.y0, strokes: it.strokes }])
    const got = norm(r.texts.map((t) => t.text).join(' '))
    const truth = norm(it.text)
    mErr += lev(got, truth)
    mChars += truth.length
    mExact += got === truth
    for (const ch of '()[]{}') {
      const want = [...truth].filter((c) => c === ch).length
      parTotal += want
      parOk += Math.min(want, [...got].filter((c) => c === ch).length)
    }
    mathRows.push(`| ${truth.replace(/\|/g, '\\|')} | ${got.replace(/\|/g, '\\|') || '*(encre gardée)*'} |`)
  }
  stats.maths = { cer: (100 * mErr) / Math.max(1, mChars), exact: (100 * mExact) / Math.max(1, mathRows.length), conv: 100, words: NaN, n: mathRows.length }

  // Dessins seuls : doivent rester de l'encre
  let kept = 0
  const falsePos = []
  for (const d of bench.drawings) {
    const b = bbox(d.strokes)
    // Hauteur d'écriture de référence : on ajoute une ligne de texte loin au-dessus (contexte réel)
    const r = await run([{ x: 60 - b.x0, y: 400 - b.y0, strokes: d.strokes }, { x: 40, y: 60, strokes: bench.writing[1].strokes }])
    const drew = r.texts.filter((t) => t.top > 200)
    if (!drew.length) kept++
    else falsePos.push(`${d.kind} → « ${drew.map((t) => t.text).join(' ')} »`)
  }

  // Texte souligné, entouré, deux lignes
  const compo = []
  {
    const it = bench.writing[2], b = bbox(it.strokes), W = b.x1 - b.x0, H = b.y1 - b.y0
    const under = [[...Array(30)].map((_, i) => [b.x0 + (W * i) / 29, b.y1 + H * 0.35])]
    const r = await run([{ x: 40, y: 120, strokes: [...it.strokes, ...under] }])
    compo.push(['souligné', norm(r.texts.map((t) => t.text).join(' ')), norm(it.text), r.ink])
    const circle = [[...Array(48)].map((_, i) => [(b.x0 + b.x1) / 2 + (W / 2 + H) * Math.cos((i / 46) * 2 * Math.PI), (b.y0 + b.y1) / 2 + H * 1.3 * Math.sin((i / 46) * 2 * Math.PI)])]
    const r2 = await run([{ x: 80, y: 160, strokes: [...it.strokes, ...circle] }])
    compo.push(['entouré', norm(r2.texts.map((t) => t.text).join(' ')), norm(it.text), r2.ink])
    const a = bench.writing[3], c = bench.writing[4], ha = bbox(a.strokes)
    const r3 = await run([{ x: 40, y: 120, strokes: a.strokes }, { x: 40, y: 120 + (ha.y1 - ha.y0) * 1.5, strokes: c.strokes }])
    compo.push(['deux lignes', r3.texts.map((t) => norm(t.text)).join(' / '), `${norm(a.text)} / ${norm(c.text)}`, r3.ink])
  }

  const table = [
    '## Écriture → texte : résultats', '',
    `Chargement du modèle : ${loadMs} ms ; conversion : ${(lineMs / lines).toFixed(0)} ms par ligne en moyenne`, '',
    '| Variante | CER | Lignes exactes | Mots exacts | Converties | Échantillons |', '|---|---|---|---|---|---|',
    ...Object.entries(stats).map(([k, s]) => `| ${k} | ${s.cer.toFixed(1)} % | ${s.exact.toFixed(0)} % | ${Number.isNaN(s.words) ? "—" : s.words.toFixed(0) + " %"} | ${s.conv.toFixed(0)} % | ${s.n} |`),
    '', `Dessins gardés en encre : ${kept} / ${bench.drawings.length}`, ...falsePos.map((f) => `- converti à tort : ${f}`),
    '', '| Cas | Lu | Attendu | Traits d’encre restants |', '|---|---|---|---|', ...compo.map((c) => `| ${c.join(' | ')} |`),
    '', `Parenthèses et crochets retrouvés : ${parOk} / ${parTotal}`,
    '', '| Maths écrit | Lu |', '|---|---|', ...mathRows,
    '', '| Écrit | Lu | Police |', '|---|---|---|', ...rows
  ]
  fs.writeFileSync(path.join(outDir, 'hwr-bench.md'), table.join('\n') + '\n')
  console.log(table.slice(0, 30).join('\n'))
  check('normal: CER ≤ 12 %', stats.normal.cer <= 12, stats.normal.cer.toFixed(1))
  check('tilted ±8°: CER ≤ 15 %', stats['penchée +8°'].cer <= 15 && stats['penchée -8°'].cer <= 15)
  check('parentheses recognized (≥ 85 %)', parOk >= parTotal * 0.85, `${parOk}/${parTotal}`)
  check('drawings kept as ink (≥ 90 %)', kept >= bench.drawings.length * 0.9, `${kept}/${bench.drawings.length}`)
  check('underline stays ink, text converted', compo[0][3] >= 1 && compo[0][1].length > 0)
  check('two lines → two texts', compo[2][1].includes(' / '))
  check('conversion time ≤ 400 ms per line', lineMs / lines <= 400, (lineMs / lines).toFixed(0))
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
