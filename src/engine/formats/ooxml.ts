import { posix } from 'node:path'
import JSZip from 'jszip'
import type { Segment, SegmentResult } from '../types'
import { applyEntitiesToPieces } from '../rewrite'

// ─── XML helpers ────────────────────────────────────────────────────────────

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const l = e.toLowerCase()
    if (l === 'amp') return '&'
    if (l === 'lt') return '<'
    if (l === 'gt') return '>'
    if (l === 'quot') return '"'
    if (l === 'apos') return "'"
    return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10))
  })
}

export function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface Edit {
  start: number
  end: number
  text: string
}

export function applyEdits(xml: string, edits: Edit[]): string {
  if (!edits.length) return xml
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const e of sorted) {
    if (e.start < pos) continue // overlapping edit – keep the first
    out += xml.slice(pos, e.start) + e.text
    pos = e.end
  }
  return out + xml.slice(pos)
}

// ─── Paragraph scanning ─────────────────────────────────────────────────────

export interface Piece {
  kind: 'text' | 'sep'
  /** Range of the whole element in the XML */
  start: number
  end: number
  tag: string
  attrs: string
  text: string
}

export interface Paragraph {
  pieces: Piece[]
}

export interface ScanConfig {
  /** Element names that carry text, e.g. ['w:t', 'w:delText'] */
  textTags: string[]
  /** Closing tags that end a logical paragraph, e.g. ['</w:p>'] */
  paraEnd: string[]
  /** Self-closing elements that act as whitespace, e.g. { 'w:tab': '\t' } */
  seps?: Record<string, string>
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function scanParagraphs(xml: string, cfg: ScanConfig, from = 0, to = xml.length): Paragraph[] {
  const textAlt = cfg.textTags.map(esc).join('|')
  const sepAlt = Object.keys(cfg.seps ?? {}).map(esc).join('|')
  const endAlt = cfg.paraEnd.map(esc).join('|')
  const re = new RegExp(
    `<(${textAlt})(\\s[^>]*)?>([^<]*)</\\1>` + (sepAlt ? `|<(${sepAlt})(?:\\s[^>]*)?/>` : '') + `|(${endAlt})`,
    'g'
  )
  re.lastIndex = from
  const paras: Paragraph[] = []
  let cur: Piece[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) && m.index < to) {
    if (m[1]) {
      cur.push({ kind: 'text', start: m.index, end: m.index + m[0].length, tag: m[1], attrs: m[2] ?? '', text: decodeXml(m[3]) })
    } else if (sepAlt && m[4]) {
      cur.push({ kind: 'sep', start: m.index, end: m.index + m[0].length, tag: m[4], attrs: '', text: cfg.seps![m[4]] })
    } else {
      if (cur.some((p) => p.kind === 'text')) paras.push({ pieces: cur })
      cur = []
    }
  }
  if (cur.some((p) => p.kind === 'text')) paras.push({ pieces: cur })
  return paras
}

export const paragraphText = (p: Paragraph) => p.pieces.map((x) => x.text).join('')

/** XML edits that write the anonymized paragraph back, run by run. */
export function paragraphEdits(p: Paragraph, res: SegmentResult): Edit[] {
  if (!res.entities.length) return []
  const newTexts = applyEntitiesToPieces(
    p.pieces.map((x) => x.text),
    res.entities
  )
  const edits: Edit[] = []
  p.pieces.forEach((piece, i) => {
    if (piece.kind !== 'text' || newTexts[i] === piece.text) return
    let attrs = piece.attrs
    if (piece.tag.endsWith(':t') && !/xml:space=/.test(attrs)) attrs += ' xml:space="preserve"'
    edits.push({ start: piece.start, end: piece.end, text: `<${piece.tag}${attrs}>${encodeXml(newTexts[i])}</${piece.tag}>` })
  })
  return edits
}

// ─── Package wrapper ────────────────────────────────────────────────────────

type Writer = (res: SegmentResult) => void

/** An OOXML zip being anonymized: collects segments and the edits that write results back. */
export class OoxmlPackage {
  readonly segments: Segment[] = []
  private writers: (Writer | null)[] = []
  private xml = new Map<string, string>()
  private edits = new Map<string, Edit[]>()

  private constructor(readonly zip: JSZip) {}

  static async load(buf: Uint8Array): Promise<OoxmlPackage> {
    return new OoxmlPackage(await JSZip.loadAsync(buf))
  }

  files(re: RegExp): string[] {
    return Object.keys(this.zip.files)
      .filter((f) => re.test(f) && !this.zip.files[f].dir)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  }

  async read(file: string): Promise<string> {
    let x = this.xml.get(file)
    if (x === undefined) {
      x = await this.zip.file(file)!.async('string')
      this.xml.set(file, x)
    }
    return x
  }

  /** Replace the stored XML wholesale (only before edits are registered for that file). */
  setXml(file: string, xml: string): void {
    this.xml.set(file, xml)
  }

  addEdit(file: string, e: Edit): void {
    const arr = this.edits.get(file) ?? []
    arr.push(e)
    this.edits.set(file, arr)
  }

  /** Register a segment; `write` is called with its result (null = context-only segment). */
  addSegment(seg: Segment, write: Writer | null): void {
    this.segments.push(seg)
    this.writers.push(write)
  }

  async addParagraphs(file: string, cfg: ScanConfig): Promise<void> {
    const xml = await this.read(file)
    for (const p of scanParagraphs(xml, cfg)) {
      const text = paragraphText(p)
      if (!text.trim()) continue
      this.addSegment({ text }, (res) => paragraphEdits(p, res).forEach((e) => this.addEdit(file, e)))
    }
  }

  /** Each match of `re` (group 1 = attribute/element value, XML-encoded) becomes a segment. */
  async addValues(file: string, re: RegExp): Promise<void> {
    const xml = await this.read(file)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(xml))) {
      const raw = m[1]
      if (!raw || !raw.trim()) continue
      const start = m.index + m[0].indexOf(raw)
      const end = start + raw.length
      const text = decodeXml(raw)
      this.addSegment({ text }, (res) => {
        if (res.output !== text) this.addEdit(file, { start, end, text: encodeXml(res.output) })
      })
    }
  }

  /** Blank out element contents everywhere in a file (e.g. dc:creator in docProps). */
  async blankElements(file: string, tags: string[]): Promise<void> {
    if (!this.zip.file(file)) return
    let xml = await this.read(file)
    for (const t of tags) xml = xml.replace(new RegExp(`(<${esc(t)}(?:\\s[^>]*)?>)[^<]*(</${esc(t)}>)`, 'g'), '$1$2')
    this.xml.set(file, xml)
  }

  /** Replace attribute values everywhere in matching files (e.g. w:author="…" → "Anonym"). */
  async replaceAttrs(fileRe: RegExp, attrs: string[], value: string): Promise<void> {
    for (const f of this.files(fileRe)) {
      let xml = await this.read(f)
      for (const a of attrs) xml = xml.replace(new RegExp(`(\\s${esc(a)}=")[^"]*(")`, 'g'), `$1${encodeXml(value)}$2`)
      this.xml.set(f, xml)
    }
  }

  /**
   * Logos, signatures and stamps identify the company or person as surely as their name does. Every image
   * relationship (inline, floating, header/footer, VML, cell pictures, linked URLs) is pointed at one plain
   * placeholder picture: the frame keeps its size and position, so the layout does not move. Image parts that
   * nothing references any more and the package thumbnail (a picture of the first page) are deleted.
   * Returns the number of distinct images removed.
   */
  async removeImages(): Promise<number> {
    const removed = new Set<string>()
    const placeholders = new Set<string>()
    const dropped = new Set<string>()
    for (const relsFile of this.files(RELS_FILE)) {
      const base = relsFile.replace(/_rels\/[^/]*$/, '') // folder of the part these rels belong to
      const top = base.split('/')[0]
      const xml = await this.read(relsFile)
      let changed = false
      const out = xml.replace(/<Relationship\b[^>]*?\/>/g, (rel) => {
        const type = relAttr(rel, 'Type')
        const target = relAttr(rel, 'Target')
        const external = /\sTargetMode="External"/.test(rel)
        if (THUMBNAIL_REL.test(type)) {
          if (!external) dropped.add(resolvePart(base, target))
          changed = true
          return ''
        }
        if (!IMAGE_REL.test(type) || !top) return rel
        let newTarget: string
        if (external) {
          removed.add(target)
          placeholders.add(`${top}/media/${IMAGE_PLACEHOLDER}`)
          newTarget = posix.relative(base, `${top}/media/${IMAGE_PLACEHOLDER}`)
        } else {
          const part = resolvePart(base, target)
          if (posix.basename(part) === IMAGE_PLACEHOLDER) return rel
          removed.add(part)
          placeholders.add(posix.join(posix.dirname(part), IMAGE_PLACEHOLDER))
          newTarget = target.replace(/[^/]*$/, IMAGE_PLACEHOLDER)
        }
        changed = true
        return rel.replace(/\sTargetMode="External"/, '').replace(/(\sTarget=")[^"]*(")/, `$1${encodeXml(newTarget)}$2`)
      })
      if (changed) this.xml.set(relsFile, out)
    }
    if (!removed.size && !dropped.size) return 0

    for (const p of placeholders) this.zip.file(p, PLACEHOLDER_PNG)
    // Delete media nothing points to any more (the originals, and orphans that were never shown).
    const referenced = new Set<string>()
    for (const relsFile of this.files(RELS_FILE)) {
      const base = relsFile.replace(/_rels\/[^/]*$/, '')
      const xml = this.xml.get(relsFile) ?? (await this.read(relsFile))
      for (const rel of xml.match(/<Relationship\b[^>]*?\/>/g) ?? [])
        if (!/\sTargetMode="External"/.test(rel)) referenced.add(resolvePart(base, relAttr(rel, 'Target')))
    }
    for (const f of this.files(/(^|\/)media\/[^/]+$/)) if (!referenced.has(f)) dropped.add(f)
    for (const f of dropped) {
      this.zip.remove(f)
      this.xml.delete(f)
    }
    const ctFile = '[Content_Types].xml'
    if (this.zip.file(ctFile)) {
      let ct = await this.read(ctFile)
      ct = ct.replace(/<Override\b[^>]*?PartName="\/([^"]*)"[^>]*\/>/g, (o, part: string) => (dropped.has(part) ? '' : o))
      if (placeholders.size && !/<Default\b[^>]*Extension="png"/i.test(ct))
        ct = ct.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>')
      this.xml.set(ctFile, ct)
    }
    return removed.size
  }

  /** Alt text and title of every picture (`blockRe` matches one picture element) become "[OBRAZOK]". */
  async labelPictures(fileRe: RegExp, blockRe: RegExp): Promise<void> {
    for (const f of this.files(fileRe)) {
      const xml = await this.read(f)
      const out = xml.replace(blockRe, (block) =>
        /<a:blip\b/.test(block)
          ? block.replace(/<(?:wp|xdr|pic):(?:docPr|cNvPr)\b[^>]*>/g, (tag) =>
              tag.replace(/\s(?:descr|title)="[^"]*"/g, '').replace(/^<([\w:]+)/, `<$1 descr="${IMAGE_LABEL}"`)
            )
          : block
      )
      if (out !== xml) this.setXml(f, out)
    }
  }

  async scrubDocProps(): Promise<void> {
    await this.blankElements('docProps/core.xml', [
      'dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:category'
    ])
    await this.blankElements('docProps/app.xml', ['Company', 'Manager'])
    // Custom properties may hold client names etc. – drop the values.
    if (this.zip.file('docProps/custom.xml')) {
      const xml = await this.read('docProps/custom.xml')
      this.xml.set('docProps/custom.xml', xml.replace(/(<vt:lpwstr>)[^<]*(<\/vt:lpwstr>)/g, '$1$2'))
    }
  }

  /**
   * Run all writers, apply the collected edits and zip everything up.
   * `post` may transform each changed file afterwards (offsets of edits no longer matter then).
   */
  async write(results: SegmentResult[], post?: (file: string, xml: string) => string): Promise<Uint8Array> {
    results.forEach((r, i) => this.writers[i]?.(r))
    for (const [file, xml] of this.xml) {
      let out = applyEdits(xml, this.edits.get(file) ?? [])
      if (post) out = post(file, out)
      this.zip.file(file, out)
    }
    return this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  }
}

const RELS_FILE = /(^|\/)_rels\/[^/]*\.rels$/
const IMAGE_REL = /\/relationships\/image$/
const THUMBNAIL_REL = /\/relationships\/metadata\/thumbnail$/
export const IMAGE_PLACEHOLDER = 'anonymo.png'
export const IMAGE_LABEL = '[OBRAZOK]'
/** 1×1 px in the placeholder box colour (same as the PDF boxes); Word and Excel stretch it to the frame. */
const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49ukDAAWKAsnoBlZ9AAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0)
)

function relAttr(rel: string, name: string): string {
  return decodeXml(new RegExp(`\\s${name}="([^"]*)"`).exec(rel)?.[1] ?? '')
}

/** Package path of a relationship target, relative to the folder of its source part. */
function resolvePart(base: string, target: string): string {
  return target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target))
}

/** The same sentence in every format's report. */
export function imagesRemovedWarning(n: number): string {
  return `Odstránené obrázky (logá, podpisy, pečiatky): ${n}.`
}

/** Hyperlink / external targets in .rels files (mailto:, http…). */
export async function addRelTargets(pkg: OoxmlPackage): Promise<void> {
  for (const f of pkg.files(/_rels\/.*\.rels$/)) {
    const xml = await pkg.read(f)
    if (!/TargetMode="External"/.test(xml)) continue
    await pkg.addValues(f, /<Relationship\b[^>]*?Target="([^"]*)"[^>]*TargetMode="External"/g)
  }
}

export const WORD_SCAN: ScanConfig = {
  textTags: ['w:t', 'w:delText'],
  paraEnd: ['</w:p>'],
  seps: { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n' }
}
export const DRAWING_SCAN: ScanConfig = { textTags: ['a:t'], paraEnd: ['</a:p>'], seps: { 'a:br': '\n' } }
export const CHART_SCAN: ScanConfig = { textTags: ['c:v'], paraEnd: ['</c:pt>'] }
