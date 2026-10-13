// Banc d'essai de l'OCR : pages « scannées » générées avec un texte connu à l'avance, dans
// des conditions variées (polices, tailles, ponctuation française, basse résolution, JPEG,
// bruit, flou, page penchée, couleurs, texte clair sur fond sombre, colonnes, plusieurs pages).
// Mesures : taux d'erreur par caractère (CER), police et taille retrouvées, position, temps.
// Un tableau de résultats est écrit dans <sortie>/ocr-bench.md.
// Utilisation : xvfb-run -a node tests/e2e/ocr-bench.cjs <racine> <sortie>
const { _electron } = require('playwright')
const fs = require('fs'), path = require('path')
const [root, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

const FR = [
  'Le vieux château, perché sur la colline, domine la vallée depuis des siècles.',
  'Où sont passés les élèves ? Ils étudient l’histoire et la géographie.',
  'Ça coûte 25,90 € — soit 3 % de moins qu’hier : « une bonne affaire » !'
]
const SCENARIOS = [
  // nom, police, taille (pt), options ; seuil de CER (%) ; famille attendue (classe)
  { name: 'Arial 12 pt, propre', font: 'Arial', size: 12, maxCer: 3, family: /Arial|Helvetica|Verdana|Tahoma|Segoe|DejaVu Sans|Noto Sans/ },
  { name: 'Times 12 pt, propre', font: 'Times New Roman', size: 12, maxCer: 3, family: /Times|Georgia|Cambria|Garamond|Antiqua|Serif/ },
  { name: 'Calibri 11 pt, propre', font: 'Calibri', size: 11, maxCer: 3, family: /Calibri|Carlito/ },
  { name: 'Cambria 12 pt, propre', font: 'Cambria', size: 12, maxCer: 3, family: /Cambria|Caladea|Times|Georgia|Serif/ },
  { name: 'Courier 11 pt, propre', font: 'Courier New', size: 11, maxCer: 4, family: /Courier|Mono/ },
  { name: 'Arial 8 pt (petit)', font: 'Arial', size: 8, maxCer: 6 },
  { name: 'Arial 36 pt (titre)', font: 'Arial', size: 36, maxCer: 4, lines: ['Grand Titre Été 2026'], family: /Arial|Helvetica|Verdana|Tahoma|Segoe|Sans/ },
  { name: 'Arial gras 14 pt', font: 'Arial', size: 14, weight: 'bold', maxCer: 3, bold: true },
  { name: 'Times italique 12 pt', font: 'Times New Roman', size: 12, style: 'italic', maxCer: 5, italic: true },
  { name: 'Chiffres et symboles', font: 'Arial', size: 12, maxCer: 6, lines: ['Facture n° 2026-0042 du 12/10/2026', 'Total TTC : 1 234,56 € (TVA 20 %)', 'Contact : jean.dupont@exemple.fr — 06 12 34 56 78'] },
  { name: 'Majuscules accentuées', font: 'Times New Roman', size: 14, maxCer: 5, lines: ['ÉCOLE ÉLÉMENTAIRE À PARIS', 'ÇA ET LÀ, LES ŒUVRES DE NOËL'] },
  { name: 'Basse résolution 150 ppp', font: 'Arial', size: 11, dpi: 150, maxCer: 6 },
  { name: 'Très basse résolution 100 ppp', font: 'Times New Roman', size: 12, dpi: 100, maxCer: 15 },
  { name: 'JPEG compressé + bruit', font: 'Arial', size: 12, jpeg: 0.35, noise: 0.06, maxCer: 6 },
  { name: 'Flou léger', font: 'Times New Roman', size: 12, blur: 1.2, maxCer: 6 },
  { name: 'Page penchée de 1,5°', font: 'Arial', size: 12, rotate: 1.5, maxCer: 6 },
  { name: 'Texte bleu sur papier jaune', font: 'Calibri', size: 12, color: '#1f3a93', paper: '#fff6c8', maxCer: 4, checkColor: true },
  { name: 'Texte clair sur fond sombre', font: 'Arial', size: 14, color: '#ffffff', paper: '#20242c', maxCer: 15 },
  // Mise en page de journal : deux colonnes de huit lignes, 24 pt d'écart.
  { name: 'Deux colonnes', font: 'Times New Roman', size: 11, columns: true, maxCer: 5, lines: [
    'La première colonne parle du', 'printemps et des fleurs qui', 'poussent au jardin dès que', 'le soleil revient enfin sur', 'la ville. Les enfants jouent', 'dehors jusqu’au soir et les', 'voisins discutent devant la', 'porte de leur maison.',
    'La seconde colonne parle de', 'l’hiver et de la neige qui', 'tombe sur les toits pendant', 'la nuit. Au matin, tout est', 'blanc et silencieux ; on', 'entend seulement le bruit', 'des pelles et le rire des', 'enfants qui glissent.'] }
]

/** Distance d'édition (Levenshtein) pour le taux d'erreur par caractère. */
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}
// Espaces regroupés ; apostrophes et guillemets typographiques ramenés à une forme (même sens).
const norm = (s) => s.replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
const cer = (truth, got) => (100 * levenshtein(norm(truth), norm(got))) / Math.max(1, norm(truth).length)

;(async () => {
  const { PDFDocument } = require('pdf-lib')
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron'), args: [root, '--no-sandbox'] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForFunction(() => window.__feuillet)
  await win.evaluate(() => { (window.__feuillet.welcome?.hide(), document.querySelector('.recovery-bar')?.remove()); window.confirm = () => true })

  /** Page A4 « scannée » (dans le navigateur, avec les polices de l'application). */
  const makeScan = (spec) => win.evaluate(async (spec) => {
    const dpi = spec.dpi ?? 300
    const k = dpi / 72
    const W = Math.round(595.28 * k)
    const H = Math.round(841.89 * k)
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    ctx.fillStyle = spec.paper ?? '#ffffff'
    ctx.fillRect(0, 0, W, H)
    const font = `${spec.style ?? 'normal'} ${spec.weight ?? 'normal'} ${spec.size * k}px "${spec.font}"`
    await document.fonts.load(font, spec.lines.join(''))
    if (spec.rotate) {
      ctx.translate(W / 2, H / 2)
      ctx.rotate((spec.rotate * Math.PI) / 180)
      ctx.translate(-W / 2, -H / 2)
    }
    if (spec.blur) ctx.filter = `blur(${spec.blur}px)`
    ctx.font = font
    ctx.fillStyle = spec.color ?? '#111111'
    ctx.textBaseline = 'alphabetic'
    const lead = spec.size * 1.5
    const boxes = []
    const half = Math.ceil(spec.lines.length / 2)
    spec.lines.forEach((line, i) => {
      // Colonnes : la première moitié des lignes à gauche, la seconde à droite.
      const col = spec.columns ? (i < half ? 0 : 1) : 0
      const row = spec.columns ? i % half : i
      const x = 60 + col * 175
      const y = 100 + row * lead
      ctx.fillText(line, x * k, y * k)
      boxes.push({ x, y, w: ctx.measureText(line).width / k })
    })
    ctx.filter = 'none'
    if (spec.noise) {
      const d = ctx.getImageData(0, 0, W, H)
      let seed = 7
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
      for (let i = 0; i < d.data.length; i += 4) {
        if (rnd() < spec.noise) {
          const v = rnd() < 0.5 ? 0 : 255
          d.data[i] = d.data[i + 1] = d.data[i + 2] = v
        }
      }
      ctx.putImageData(d, 0, 0)
    }
    const url = spec.jpeg ? c.toDataURL('image/jpeg', spec.jpeg) : c.toDataURL('image/png')
    return { data: url.split(',')[1], jpeg: !!spec.jpeg, boxes }
  }, spec)

  const asPdf = async (scans) => {
    const pdf = await PDFDocument.create()
    for (const s of scans) {
      const bytes = Buffer.from(s.data, 'base64')
      const img = s.jpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes)
      pdf.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 })
    }
    return Buffer.from(await pdf.save()).toString('base64')
  }
  const open = (name, b64) => win.evaluate(([n, b]) => window.__feuillet.importer.open([{ name: n, data: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }]), [name, b64])
  const ocrPage = (i = 0) => win.evaluate(async (i) => {
    const { editor, ocr } = window.__feuillet
    const page = editor.doc.pages[i]
    const t0 = performance.now()
    const data = await ocr.recognizePage(page)
    page.set({ ocr: data })
    const lines = data.chars.map((c) => c.c).join('').split('\n').filter((l) => l.trim())
    const ink = data.chars.filter((c) => !/\s/.test(c.c))
    return { ms: performance.now() - t0, lines, chars: ink.map((c) => ({ c: c.c, x0: c.x0, y: c.y, size: c.size, color: c.color })) }
  }, i)
  const ws = await win.locator('#workspace').boundingBox()
  const editAt = async (x, y) => {
    await win.evaluate(() => window.__feuillet.tools.set('edittext'))
    const s = await win.evaluate(([x, y]) => { const p = window.__feuillet.editor.doc.pages[0]; window.__feuillet.editor.viewport.showRect(window.__feuillet.editor.doc.box(p)); const v = window.__feuillet.editor.canvas.viewportTransform; return [(p.left + x) * v[0] + v[4], (p.top + y) * v[3] + v[5]] }, [x, y])
    await win.mouse.click(ws.x + s[0], ws.y + s[1])
    // La première fois, la police est cherchée parmi celles de l'ordinateur : un peu plus long.
    await win.waitForFunction(() => window.__feuillet.editor.canvas.getActiveObject()?.text !== undefined, null, { timeout: 8000 }).catch(() => {})
    const info = await win.evaluate(() => { const o = window.__feuillet.editor.canvas.getActiveObject(); return o && o.text !== undefined ? { text: o.text, family: o.fontFamily, size: o.fontSize, weight: o.fontWeight, style: o.fontStyle, fill: o.fill, left: o.left - window.__feuillet.editor.doc.pages[0].left } : null })
    await win.keyboard.press('Escape')
    await win.evaluate(() => window.__feuillet.editor.canvas.discardActiveObject())
    return info
  }

  const table = ['| Cas | CER | Temps | Police trouvée | Taille (attendue) | Remarques |', '|---|---|---|---|---|---|']
  let totalCer = 0
  for (const sc of SCENARIOS) {
    const spec = { ...sc, lines: sc.lines ?? FR }
    delete spec.family
    const scan = await makeScan(spec)
    await open('scan.pdf', await asPdf([scan]))
    await win.waitForTimeout(200)
    const r = await ocrPage()
    const truth = spec.lines.join('\n')
    const got = r.lines.join('\n')
    const e = cer(truth, got)
    totalCer += e
    check(`${sc.name} : texte reconnu`, e <= sc.maxCer, `CER ${e.toFixed(1)} % (max ${sc.maxCer}) — ${JSON.stringify(got.slice(0, 90))}`)
    const notes = []
    let fam = '—'
    let size = '—'
    // Modification du premier paragraphe : police, taille, position
    // Clic au milieu du premier mot reconnu (une page penchée décale le début de ligne).
    const first = r.chars.find((c) => Math.abs(c.y - scan.boxes[0].y) < spec.size * 1.5)
    const info = first ? await editAt(first.x0 + 2, first.y - first.size * 0.3) : null
    if (process.env.DBG) {
      console.log('DBG', sc.name, JSON.stringify(got))
      console.log('DBG first', JSON.stringify(first))
      if (!info) await win.screenshot({ path: path.join(outDir, `miss-${sc.name.replace(/\W+/g, '_')}.png`) })
    }
    if (info) {
      fam = `${info.family}${info.weight === 'bold' ? ' gras' : ''}${info.style === 'italic' ? ' italique' : ''}`
      size = `${info.size} (${spec.size})`
      if (sc.family) check(`${sc.name} : police reconnue`, sc.family.test(info.family), fam)
      check(`${sc.name} : taille retrouvée (±12 %)`, Math.abs(info.size - spec.size) <= spec.size * 0.12, size)
      check(`${sc.name} : position retrouvée (±3 pt)`, sc.rotate || Math.abs(info.left - scan.boxes[0].x) <= 3, `${info.left.toFixed(1)} vs ${scan.boxes[0].x}`)
      if (sc.bold) check(`${sc.name} : gras reconnu`, info.weight === 'bold', fam)
      if (sc.italic) check(`${sc.name} : italique reconnu`, info.style === 'italic', fam)
      if (sc.checkColor) {
        const n = parseInt(String(info.fill).slice(1), 16)
        const [rr, gg, bb] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        check(`${sc.name} : couleur du texte reprise (bleu)`, bb > rr + 40 && bb > gg + 20, info.fill)
        notes.push(`couleur ${info.fill}`)
      }
    } else check(`${sc.name} : paragraphe modifiable`, false, 'aucun texte sous le clic')
    table.push(`| ${sc.name} | ${e.toFixed(1)} % | ${(r.ms / 1000).toFixed(1)} s | ${fam} | ${size} | ${notes.join(', ')} |`)
  }

  // Photo importée directement (image, pas PDF)
  {
    const scan = await makeScan({ font: 'Calibri', size: 12, lines: FR, dpi: 200 })
    await open('photo.png', scan.data)
    const kind = await win.evaluate(() => window.__feuillet.editor.doc.pages[0].bg.kind)
    const r = await ocrPage()
    const e = cer(FR.join('\n'), r.lines.join('\n'))
    check('Photo importée (page image) : texte reconnu', kind === 'image' && e <= 4, `${kind}, CER ${e.toFixed(1)} %`)
    table.push(`| Photo importée (image PNG) | ${e.toFixed(1)} % | ${(r.ms / 1000).toFixed(1)} s | | | page de type ${kind} |`)
  }

  // Document de trois pages : chaque page reconnue, le texte reste sur sa page
  {
    const pages = []
    for (let i = 1; i <= 3; i++) pages.push(await makeScan({ font: 'Arial', size: 12, lines: [`Page numéro ${i} du rapport annuel`, FR[i - 1]] }))
    await open('rapport.pdf', await asPdf(pages))
    let ok = true
    let detail = []
    for (let i = 0; i < 3; i++) {
      const r = await ocrPage(i)
      const has = r.lines.join(' ').includes(`Page numéro ${i + 1}`)
      ok &&= has
      detail.push(`${i + 1}:${has ? 'ok' : r.lines[0]}`)
    }
    check('Trois pages : chacune reconnue', ok, detail.join(' '))
    const found = await win.evaluate(() => window.__feuillet.editor.doc.pages.map((p) => p.ocr?.chars.length ?? 0))
    check('Trois pages : texte rangé sur chaque page', found.every((n) => n > 20), JSON.stringify(found))
  }

  // Le texte reconnu est enregistré avec le projet et revient à la réouverture
  {
    const saved = await win.evaluate(async () => {
      const { editor } = window.__feuillet
      const json = editor.canvas.toObject()
      return json.objects.filter((o) => o.type === 'Page').every((p) => p.ocr?.chars?.length > 0)
    })
    check('Texte reconnu enregistré avec le document', saved)
  }

  const avg = totalCer / SCENARIOS.length
  table.push('', `CER moyen : ${avg.toFixed(2)} %`)
  fs.writeFileSync(path.join(outDir, 'ocr-bench.md'), table.join('\n') + '\n')
  check('CER moyen sur tous les cas ≤ 4 %', avg <= 4, `${avg.toFixed(2)} %`)
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await win.evaluate(() => window.feuillet.setDirty(false))
  await app.close()
  console.log(table.join('\n'))
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
