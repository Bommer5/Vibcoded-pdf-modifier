// Graphe : nœuds nommés, arêtes (orientées ou non), poids ; disposition avec le moins de
// croisements possible ; insertion dans la page et réédition.
// Utilisation : xvfb-run -a node tests/e2e/graph.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
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
  await win.evaluate(() => (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()))

  // 1. Disposition : graphes planaires dessinés sans aucun croisement, les autres au minimum
  const cases = {
    'triangle': ['A - B', 'B - C', 'C - A'],
    'K4': ['A - B', 'A - C', 'A - D', 'B - C', 'B - D', 'C - D'],
    'cube': ['1 - 2', '2 - 3', '3 - 4', '4 - 1', '5 - 6', '6 - 7', '7 - 8', '8 - 5', '1 - 5', '2 - 6', '3 - 7', '4 - 8'],
    'grid 3×3': ['a - b', 'b - c', 'd - e', 'e - f', 'g - h', 'h - i', 'a - d', 'd - g', 'b - e', 'e - h', 'c - f', 'f - i'],
    'tree': ['R - A', 'R - B', 'R - C', 'A - D', 'A - E', 'B - F', 'C - G', 'C - H', 'C - I', 'G - J'],
    'wheel': ['H - 1', 'H - 2', 'H - 3', 'H - 4', 'H - 5', 'H - 6', '1 - 2', '2 - 3', '3 - 4', '4 - 5', '5 - 6', '6 - 1'],
    'two triangles': ['A - B', 'B - C', 'C - A', 'X - Y', 'Y - Z', 'Z - X'],
    'DAG (orienté)': ['Lun -> Mar', 'Lun -> Mer', 'Mar -> Jeu', 'Mer -> Jeu', 'Jeu -> Ven', 'Mar -> Ven'],
    'weighted cities': ['Paris - Lyon 465', 'Lyon - Marseille 315', 'Paris - Lille 225', 'Paris - Bordeaux 585', 'Bordeaux - Toulouse 245', 'Toulouse - Marseille 405', 'Lyon - Toulouse 540']
  }
  const minimum = { 'K5 (1 croisement au mieux)': [['A - B', 'A - C', 'A - D', 'A - E', 'B - C', 'B - D', 'B - E', 'C - D', 'C - E', 'D - E'], 1], 'K3,3 (1 au mieux)': [['a - x', 'a - y', 'a - z', 'b - x', 'b - y', 'b - z', 'c - x', 'c - y', 'c - z'], 1] }
  const run = (lines) => win.evaluate((text) => {
    const { applyText, layout, crossings, renderGraph } = window.__feuillet.graphTools
    const g = { nodes: [], edges: [], directed: false, weighted: false, nodeSize: 34, color: '#2f6bff' }
    applyText(g, text)
    const t0 = performance.now()
    layout(g)
    const ms = performance.now() - t0
    // Nœuds bien séparés : jamais deux nœuds l'un sur l'autre
    let minDist = Infinity
    for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) minDist = Math.min(minDist, Math.hypot(g.nodes[i].x - g.nodes[j].x, g.nodes[i].y - g.nodes[j].y))
    const svg = renderGraph(g).svg
    return { n: g.nodes.length, e: g.edges.length, cross: crossings(g), ms: Math.round(ms), minDist, directed: g.directed, weighted: g.weighted, svg }
  }, lines.join('\n'))
  for (const [name, lines] of Object.entries(cases)) {
    const r = await run(lines)
    check(`layout ${name}: no crossing`, r.cross === 0, `${r.n} nœuds, ${r.e} arêtes, ${r.cross} croisements, ${r.ms} ms`)
    check(`layout ${name}: nodes well apart`, r.minDist > 0.55, r.minDist.toFixed(2))
    if (name === 'weighted cities') {
      check('weights detected and drawn', r.weighted && ['465', '315', '540'].every((w) => r.svg.includes(`>${w}<`)))
      check('node names drawn', ['Paris', 'Marseille', 'Toulouse'].every((w) => r.svg.includes(`>${w}<`)))
    }
    if (name.startsWith('DAG')) check('arrows: "->" makes a directed graph with arrowheads', r.directed && /<polygon/.test(r.svg))
  }
  for (const [name, [lines, best]] of Object.entries(minimum)) {
    const r = await run(lines)
    check(`layout ${name}`, r.cross <= best, `${r.cross} croisements`)
  }
  const big = await run(Array.from({ length: 30 }, (_, i) => `n${i} - n${(i * 7 + 3) % 30}`).concat(Array.from({ length: 29 }, (_, i) => `n${i} - n${i + 1}`)))
  check('layout of a 30-node graph stays fast', big.ms < 4000, `${big.ms} ms, ${big.cross} croisements`)

  // 2. Insertion > Graphe : la fenêtre, saisie rapide, validation → objet dans la page
  await win.click('.menu-button >> text=Insertion')
  await win.click('.menu-item >> text=Graphe (nœuds et arêtes)')
  await win.locator('dialog.graph-dialog').waitFor()
  check('graph dialog opens with an example', (await win.locator('.graph-stage [data-node]').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('data-node'))).size)) >= 4)
  await win.click('.graph-quick summary')
  await win.fill('[name=quick]', 'Paris - Lyon 465\nLyon - Marseille 315\nParis - Lille 225\nParis -> Brest 590')
  await win.click('.graph-apply')
  check('quick entry: nodes and edges', (await win.locator('.graph-stage [data-node]').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('data-node'))).size)) === 5, await win.locator('.graph-cross').innerText())
  check('quick entry: crossing count shown', /0 croisement/.test(await win.locator('.graph-cross').innerText()), await win.locator('.graph-cross').innerText())
  // Clic dans le vide : nouveau nœud ; puis clic sur un autre nœud : arête
  const stage = await win.locator('.graph-stage').boundingBox()
  await win.mouse.click(stage.x + 12, stage.y + 12)
  check('click on empty space adds a node', (await win.locator('.graph-stage [data-node]').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('data-node'))).size)) === 6)
  const target = await win.locator('.graph-stage [data-node]').first().boundingBox()
  await win.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
  check('then clicking another node links them', /5 arêtes/.test(await win.locator('.graph-cross').innerText()), await win.locator('.graph-cross').innerText())
  await win.click('.graph-sel button.danger')
  check('"Supprimer cette arête" removes the selected edge', /4 arêtes/.test(await win.locator('.graph-cross').innerText()), await win.locator('.graph-cross').innerText())
  await win.click('.graph-layout-btn')
  await win.click('dialog.graph-dialog button[value=ok]')
  await win.waitForTimeout(300)
  const obj = await win.evaluate(() => {
    const o = window.__feuillet.editor.canvas.getActiveObject()
    return o?.graph ? { nodes: o.graph.nodes.map((n) => n.label), edges: o.graph.edges.length, w: o.getScaledWidth(), page: window.__feuillet.editor.doc.currentPage().width } : null
  })
  check('graph inserted on the page as one object', !!obj && obj.nodes.includes('Marseille') && obj.edges === 4, JSON.stringify(obj))
  check('graph fits within the page', !!obj && obj.w <= obj.page, JSON.stringify(obj))
  check('properties panel offers "Modifier le graphe…"', await win.locator('.properties button:has-text("Modifier le graphe")').count() === 1)
  // 3. Réédition : renommer un nœud, le graphe garde sa place et sa taille
  const before = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); const c = o.getCenterPoint(); return { x: c.x, y: c.y, k: o.scaleX } })
  await win.click('.properties button:has-text("Modifier le graphe")')
  await win.locator('dialog.graph-dialog').waitFor()
  await win.click('.graph-quick summary')
  const text = await win.inputValue('[name=quick]')
  await win.fill('[name=quick]', text.replace(/Brest/g, 'Rennes'))
  await win.click('.graph-apply')
  await win.click('dialog.graph-dialog button[value=ok]')
  await win.waitForTimeout(300)
  const after = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); const c = o.getCenterPoint(); return { x: c.x, y: c.y, k: o.scaleX, labels: o.graph.nodes.map((n) => n.label) } })
  check('re-edit renames the node', after.labels.includes('Rennes') && !after.labels.includes('Brest'), after.labels.join())
  check('re-edit keeps position and scale', Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1 && Math.abs(after.k - before.k) < 1e-6, JSON.stringify({ before, after }))
  await win.keyboard.press('Control+z')
  const undone = await win.evaluate(() => window.__feuillet.editor.doc.content.find((o) => o.graph)?.graph.nodes.map((n) => n.label))
  check('undo restores the previous graph', undone?.includes('Brest'), String(undone))
  // 4. Le graphe est enregistré dans le projet et revient éditable
  const saved = await win.evaluate(() => window.__feuillet.editor.doc.content.find((o) => o.graph).toObject().graph?.nodes.length)
  check('graph description saved with the object (project, re-edit after reopening)', saved === 6, String(saved))
  await win.screenshot({ path: path.join(outDir, 'graph.png') })
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
