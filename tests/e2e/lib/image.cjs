// Lecture d'images PNG via Electron (nativeImage) : pas de dépendance Python dans les tests.
async function readGray(app, file) {
  const { width, height, data } = await app.evaluate(({ nativeImage }, f) => {
    const img = nativeImage.createFromPath(f)
    const { width, height } = img.getSize()
    return { width, height, data: img.toBitmap().toString('base64') }
  }, file)
  const bgra = Buffer.from(data, 'base64')
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i++) gray[i] = (bgra[i * 4] + bgra[i * 4 + 1] + bgra[i * 4 + 2]) / 3
  return { width, height, gray }
}

/** Pourcentage de pixels dont le gris diffère de plus de `threshold` (images de même taille, sinon échantillonnage). */
function diffPercent(a, b, threshold = 40) {
  let n = 0
  for (let y = 0; y < a.height; y++) {
    const by = Math.min(b.height - 1, Math.round((y * b.height) / a.height))
    for (let x = 0; x < a.width; x++) {
      const bx = Math.min(b.width - 1, Math.round((x * b.width) / a.width))
      if (Math.abs(a.gray[y * a.width + x] - b.gray[by * b.width + bx]) > threshold) n++
    }
  }
  return (100 * n) / (a.width * a.height)
}

const pixel = (img, x, y) => img.gray[Math.round(y) * img.width + Math.round(x)]
const darkCount = (img, below = 100) => img.gray.reduce((n, v) => n + (v < below ? 1 : 0), 0)

module.exports = { readGray, diffPercent, pixel, darkCount }
