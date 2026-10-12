import type { FabricObject } from 'fabric'
import { assets } from '../core/assets'
import { registerFontFile } from '../io/pdf-text'
import { pdfEngine } from './engine'
import type { PdfCharFont } from './protocol'

/**
 * Polices d'origine d'un PDF, réutilisées pour modifier son texte sans changer d'aspect.
 *
 * Les polices intégrées aux PDF sont presque toujours des sous-ensembles incomplets que les
 * navigateurs refusent tels quels. On reconstruit donc une police OpenType propre à partir
 * des contours de glyphes donnés par PDFium (qui fait aussi la correspondance Unicode, même
 * pour les polices CID). Elle sert à l'écran (FontFace) et à l'export (pdf-lib), et elle est
 * gardée comme ressource du document pour être retrouvée à la réouverture d'un projet.
 * Les caractères absents du sous-ensemble passent sur la police de secours (la suivante
 * dans la liste de familles), comme le ferait un traitement de texte.
 */

export interface EmbeddedFace {
  family: string
  bold: boolean
  italic: boolean
  /** Ressource contenant le fichier de police reconstruit. */
  asset: string
}

/** Caractères essayés en plus de ceux de la page, gardés s'ils existent dans le sous-ensemble. */
const EXTRA = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x180 - 0xa0 }, (_, i) => 0xa0 + i),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x20ac, 0x2030, 0x2039, 0x203a, 0x2122
]

const built = new Map<string, Promise<EmbeddedFace | null>>()
const loaded = new Set<string>()

/** Nom de famille CSS stable pour une police d'un PDF donné. */
export function familyFor(docAsset: string, font: PdfCharFont): string {
  const base = (font.family || font.name.replace(/[-,].*$/, '')).replace(/[^\w ]+/g, ' ').trim()
  // Police sans nom (Type 3 de Chrome, Skia…) : chacune a le sien, elles ne se mélangent pas.
  return `PDF ${docAsset.slice(0, 8)} ${base || `Police ${font.sample}`}`
}

/** Police d'origine d'un caractère du PDF, reconstruite et prête (ou null si impossible). */
export function embeddedFace(
  docAsset: string,
  pageIndex: number,
  font: PdfCharFont,
  used: Iterable<number>,
  advances?: Map<number, number[]>
): Promise<EmbeddedFace | null> {
  const family = familyFor(docAsset, font)
  const key = `${family}|${font.bold}|${font.italic}|${pageIndex}`
  let p = built.get(key)
  if (!p) {
    p = build(docAsset, pageIndex, font, [...used], family, advances).catch((e) => {
      console.warn('Police du PDF non reconstruite', font.name, e)
      return null
    })
    built.set(key, p)
  }
  return p
}

async function build(docAsset: string, pageIndex: number, font: PdfCharFont, used: number[], family: string, advances?: Map<number, number[]>): Promise<EmbeddedFace | null> {
  const gf = await pdfEngine.glyphs(docAsset, pageIndex, font.sample, used, EXTRA)
  if (!gf || !gf.glyphs.some((g) => g.d.length)) return null
  const opentype = await import('opentype.js')
  const glyphs = [new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() })]
  const seen = new Set<number>()
  const drawn = new Set<number>()
  const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const usedSet = new Set(used)
  const anonymous = !font.name && !font.family
  for (const g of gf.glyphs) {
    if (seen.has(g.u)) continue
    seen.add(g.u)
    // Morceau de police sans nom qui ne contient pas l'espace : sa largeur d'espace est
    // inventée ; l'espace viendra de la police voisine qui l'a vraiment.
    if (anonymous && (g.u === 32 || g.u === 0xa0) && !usedSet.has(g.u)) continue
    // Glyphe dessiné mais sans largeur : correspondance douteuse (partie de ligature…).
    if (g.w <= 0 && g.d.length) continue
    // Le glyphe doit avoir la largeur observée dans la page (sinon : ligature, mauvaise correspondance).
    const seenAdv = advances?.get(g.u)
    if (seenAdv?.length) {
      const m = median(seenAdv)
      if (Math.abs(m - g.w) > Math.max(30, 0.12 * Math.max(m, g.w))) continue
    }
    const path = new opentype.Path()
    const d = g.d
    for (let k = 0; k < d.length; ) {
      const op = d[k]
      if (op === 0) {
        path.moveTo(d[k + 1], d[k + 2])
        k += 3
      } else if (op === 1) {
        path.lineTo(d[k + 1], d[k + 2])
        k += 3
      } else if (op === 2) {
        path.curveTo(d[k + 1], d[k + 2], d[k + 3], d[k + 4], d[k + 5], d[k + 6])
        k += 7
      } else {
        path.close()
        k += 1
      }
    }
    if (d.length) drawn.add(g.u)
    glyphs.push(new opentype.Glyph({ name: `uni${g.u.toString(16).toUpperCase().padStart(4, '0')}`, unicode: g.u, advanceWidth: Math.max(0, Math.round(g.w)), path }))
  }
  // Police dont on ne sait pas lire les lettres (Type 3 : dessins, pas des contours) : il n'en
  // resterait que l'espace. Mieux vaut une police ressemblante complète qu'un mélange.
  const letters = used.filter((u) => u > 32 && u !== 0xa0)
  if (letters.length && letters.filter((u) => drawn.has(u)).length < letters.length * 0.85) return null
  const ascent = gf.ascent > 0 ? gf.ascent : 800
  const descent = -Math.abs(gf.descent || 200)
  const style = font.bold ? (font.italic ? 'Bold Italic' : 'Bold') : font.italic ? 'Italic' : 'Regular'
  const otf = new opentype.Font({ familyName: family, styleName: style, unitsPerEm: 1000, ascender: ascent, descender: descent, glyphs })
  const bytes = new Uint8Array(otf.toArrayBuffer())
  const asset = assets.add(bytes, 'font/otf')
  const face: EmbeddedFace = { family, bold: font.bold, italic: font.italic, asset: asset.id }
  await loadFace(face)
  return face
}

/** Rend une police reconstruite utilisable (écran + export). Sans effet si déjà fait. */
export async function loadFace(face: EmbeddedFace): Promise<boolean> {
  const key = `${face.family}|${face.bold}|${face.italic}`
  if (loaded.has(key)) return true
  const asset = assets.get(face.asset)
  if (!asset) return false
  const ff = new FontFace(face.family, asset.bytes.slice().buffer as ArrayBuffer, { weight: face.bold ? '700' : '400', style: face.italic ? 'italic' : 'normal' })
  await ff.load()
  document.fonts.add(ff)
  const ps = face.family.replace(/\s+/g, '') + (face.bold || face.italic ? `-${face.bold ? 'Bold' : ''}${face.italic ? 'Italic' : ''}` : '')
  registerFontFile(face.family, face.bold, face.italic, asset.bytes, ps)
  loaded.add(key)
  return true
}

/** À l'ouverture d'un projet (ou au coller) : recharge les polices d'origine d'un texte modifié. */
export async function loadObjectFaces(obj: FabricObject): Promise<boolean> {
  const faces = (obj as FabricObject & { pdfFonts?: EmbeddedFace[] }).pdfFonts
  if (!faces?.length) return false
  const results = await Promise.all(faces.map((f) => loadFace(f).catch(() => false)))
  return results.some(Boolean)
}
