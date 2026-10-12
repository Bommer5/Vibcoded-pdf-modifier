/**
 * « PDF modifiable » sans doublon : les ajouts de Feuillet sont écrits dans un flux de contenu
 * séparé, marqué `/FeuilletAnnot BMC … EMC`, ajouté à la fin de chaque page. Les flux d'origine
 * ne sont jamais modifiés. À la réouverture, on retire ce flux (et les ressources qu'il utilise)
 * pour retrouver exactement le PDF de départ : inutile d'en joindre une copie.
 */
export const ANNOT_TAG = 'FeuilletAnnot'

/** Retire les ajouts Feuillet d'un PDF modifiable et renvoie le PDF d'origine. */
export async function stripAnnotations(bytes: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  for (const page of doc.getPages()) {
    const contents = page.node.Contents()
    if (!(contents instanceof PDFArray) || contents.size() < 2) continue
    const last = contents.lookup(contents.size() - 1)
    if (!(last instanceof PDFRawStream)) continue
    const text = new TextDecoder('latin1').decode(decodePDFRawStream(last).decode())
    if (!text.trimStart().startsWith(`/${ANNOT_TAG} BMC`)) continue
    contents.remove(contents.size() - 1)
    // Ressources ajoutées par Feuillet (formes, images, polices, transparences) : supprimées aussi.
    const resources = page.node.Resources()
    for (const [, name, op] of text.matchAll(/\/([^\s/[\]()<>{}%]+)\s+(Do|Tf|gs)\b/g)) {
      const kind = op === 'Do' ? 'XObject' : op === 'Tf' ? 'Font' : 'ExtGState'
      const dict = resources?.lookup(PDFName.of(kind))
      if (dict instanceof PDFDict) dict.delete(PDFName.of(name))
    }
  }
  return doc.save({ useObjectStreams: true })
}
