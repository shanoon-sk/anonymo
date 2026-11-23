import type { DocumentAdapter } from './adapter'
import { addRelTargets, CHART_SCAN, DRAWING_SCAN, imagesRemovedWarning, OoxmlPackage, WORD_SCAN } from './ooxml'

const WORD_TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments(Extended)?)\.xml$/
const AUTHOR_ATTRS = ['w:author', 'w:initials', 'w15:author', 'w15:userId', 'w15:providerId']

export async function loadDocx(buf: Uint8Array): Promise<DocumentAdapter> {
  const pkg = await OoxmlPackage.load(buf)
  if (!pkg.zip.file('word/document.xml')) throw new Error('Súbor nie je platný dokument Word (.docx).')

  // Who edited/commented is personal data too.
  await pkg.replaceAttrs(/^word\/.*\.xml$/, AUTHOR_ATTRS, 'Anonym')
  await pkg.scrubDocProps()
  // Logos and signatures: the pictures go, their frames stay with a placeholder (alt text "[OBRAZOK]").
  const images = await pkg.removeImages()
  await pkg.labelPictures(/^word\/.*\.xml$/, /<wp:(inline|anchor)\b[\s\S]*?<\/wp:\1>/g)
  await pkg.replaceAttrs(/^word\/.*\.xml$/, ['o:title'], '')

  for (const f of pkg.files(WORD_TEXT_PARTS)) await pkg.addParagraphs(f, WORD_SCAN)
  // Text boxes / shapes / SmartArt / charts
  for (const f of pkg.files(/^word\/(diagrams|charts)\/.*\.xml$/)) {
    await pkg.addParagraphs(f, DRAWING_SCAN)
    await pkg.addParagraphs(f, CHART_SCAN)
  }
  // Field codes, e.g. HYPERLINK "mailto:jan@firma.sk"
  for (const f of pkg.files(WORD_TEXT_PARTS)) await pkg.addValues(f, /<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>/g)
  // Image alt texts
  for (const f of pkg.files(WORD_TEXT_PARTS)) await pkg.addValues(f, /<wp:docPr\b[^>]*?\sdescr="([^"]*)"/g)
  await addRelTargets(pkg)

  return {
    segments: pkg.segments,
    write: (results) => pkg.write(results),
    outputExt: 'docx',
    warnings: images ? [imagesRemovedWarning(images)] : []
  }
}
