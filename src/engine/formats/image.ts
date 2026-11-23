import type { DocumentAdapter } from './adapter'
import { loadPdf, type OcrFn } from './pdf'

// A photo or a scan saved as JPG/PNG goes through the same path as a scanned PDF page: it becomes a one-page
// PDF in memory, is read by OCR, the values are blanked in the pixels, and the page is rendered back to an
// image of the original size and format. Rendering anew also drops the file's metadata (EXIF: GPS, device).

export type ImageKind = 'png' | 'jpg'

/** The page is sized so that this many dots per inch give back the image's own pixels (72/288 = 0.25 exactly). */
const IMAGE_DPI = 288
const JPEG_QUALITY = 92

const SCAN_WARNING = /^Strana 1: sken/

export async function loadImage(
  buf: Uint8Array,
  kind: ImageKind,
  opts: { ocr?: OcrFn; onOcrPage?: (i: number, total: number) => void }
): Promise<DocumentAdapter> {
  if (!opts.ocr) throw new Error('Text na obrázku sa číta cez OCR, ktoré nie je dostupné.')
  const mupdf = await import('mupdf')

  // Opened as an image document, MuPDF applies the EXIF orientation (phone photos) and the resolution.
  let photo
  try {
    const src = mupdf.Document.openDocument(buf.slice(), kind === 'png' ? 'image/png' : 'image/jpeg')
    const raw = new mupdf.Image(buf.slice())
    const page = src.loadPage(0)
    photo = page.toPixmap(
      mupdf.Matrix.scale(raw.getXResolution() / 72, raw.getYResolution() / 72),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true
    )
  } catch {
    throw new Error('Obrázok sa nepodarilo otvoriť. Uložte ho znova ako JPG alebo PNG.')
  }

  const pt = 72 / IMAGE_DPI
  const w = photo.getWidth() * pt
  const h = photo.getHeight() * pt
  const doc = new mupdf.PDFDocument()
  const res = doc.addObject({ XObject: { Im0: doc.addImage(new mupdf.Image(photo)) } })
  doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, res, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`))
  const pdf = await loadPdf(doc.saveToBuffer('').asUint8Array().slice(), opts)

  /** The PDF's page-level messages, worded for a single picture. */
  const warnings = () =>
    (pdf.warnings ?? []).map((m) =>
      SCAN_WARNING.test(m) ? 'Logá a podpisy priamo na obrázku sa nedajú spoľahlivo odstrániť, skontrolujte ich.' : m
    )

  return {
    segments: pdf.segments,
    outputExt: kind,
    ocrPages: pdf.ocrPages,
    get warnings() {
      return warnings()
    },
    toText: pdf.toText,
    async write(results) {
      const out = mupdf.Document.openDocument(await pdf.write(results), 'application/pdf')
      const scale = IMAGE_DPI / 72
      const pix = out.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
      return (kind === 'png' ? pix.asPNG() : pix.asJPEG(JPEG_QUALITY)).slice()
    }
  }
}
