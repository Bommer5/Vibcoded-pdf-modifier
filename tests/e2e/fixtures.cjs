const R = (m) => require(m)
const fs = require('fs'), zlib = require('zlib'), path = require('path')
const out = process.argv[2]
fs.mkdirSync(out, { recursive: true })
;(async () => {
  const { PDFDocument, StandardFonts, rgb, degrees } = R('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const p = pdf.addPage([595.28, 841.89])
    p.drawText(`Page ${i} - texte original selectionnable`, { x: 60, y: 760, size: 18, font })
    p.drawRectangle({ x: 60, y: 600, width: 200, height: 100, color: rgb(0.2, 0.5, 0.9) })
    if (i === 3) p.setRotation(degrees(90))
  }
  fs.writeFileSync(path.join(out, 'sample.pdf'), await pdf.save())
  // PNG via a tiny raw encoder
  const w = 64, h = 48, raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = x * 4; raw[o + 1] = y * 5; raw[o + 2] = 200; raw[o + 3] = 255 } }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  fs.writeFileSync(path.join(out, 'image.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
  const UTIF = R('utif2')
  const rgba = new Uint8Array(w * h * 4).fill(180)
  fs.writeFileSync(path.join(out, 'image.tiff'), Buffer.from(UTIF.encodeImage(rgba.buffer, w, h)))
  fs.writeFileSync(path.join(out, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="10" y="10" width="100" height="60" fill="#e5484d"/><circle cx="150" cy="60" r="40" fill="#30a46c"/></svg>')
  fs.writeFileSync(path.join(out, 'notes.txt'), 'Note rapide\nDeuxième ligne éàç')
  fs.writeFileSync(path.join(out, 'long.txt'), Array.from({ length: 150 }, (_, i) => `Ligne ${i + 1} : éàç texte accentué`).join('\n'))
  const docx = require('docx')
  const d = new docx.Document({ sections: [{ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Bonjour depuis Word', bold: true, size: 48 })] }), new docx.Paragraph('Deuxième paragraphe.')] }] })
  fs.writeFileSync(path.join(out, 'lettre.docx'), await docx.Packer.toBuffer(d))
  const xml = `<?xml version="1.0" standalone="no"?>
<xournal creator="Xournal++ 1.2.2" fileversion="4"><title>Xournal++ document</title>
<page width="595.27559100" height="841.88976400"><background type="solid" color="#ffffffff" style="graph"/>
<layer><stroke tool="pen" ts="0" fn="" color="#ff0000ff" width="2.26 2.1 2.3 2.4">100 100 150 130 200 110 250 160</stroke>
<stroke tool="highlighter" color="#ffff0080" width="8">100 300 400 300</stroke>
<text font="Sans" size="20" x="100" y="200" color="#000000ff">Texte Xournal</text></layer></page>
<page width="595.27559100" height="841.88976400"><background type="pdf" domain="absolute" filename="${path.join(out, 'sample.pdf')}" pageno="2ll"/><layer><stroke tool="pen" color="blue" width="3">50 50 300 300</stroke></layer></page>
</xournal>`
  fs.writeFileSync(path.join(out, 'carnet.xopp'), zlib.gzipSync(xml))
  console.log(fs.readdirSync(out))
})()
