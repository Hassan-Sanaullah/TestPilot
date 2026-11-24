/**
 * Sample files for the `upload` action, generated in memory.
 *
 * Nothing is written to disk and nothing is read from it, so a compiled test
 * that attaches a file still runs on a build machine that has never seen this
 * repository. Each file is small but genuinely valid for its type: a server
 * that checks the magic bytes of an image, or opens the PDF, will accept these.
 */

export type SampleKind = 'image' | 'pdf' | 'text' | 'csv'

export interface SampleFile {
  name: string
  mimeType: string
  buffer: Buffer
}

/** A 1x1 opaque PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx' + 'xgAAAABJRU5ErkJggg=='

/**
 * The smallest PDF that real readers open: header, one empty page, the object
 * table and the trailer. Byte offsets in the xref table are deliberately zero —
 * readers rebuild a damaged table, and no test should depend on byte offsets.
 */
const PDF_SOURCE = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj',
  'trailer<</Size 4/Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n')

const TEXT_SOURCE = ['TestPilot sample upload.', 'This file was generated in memory for an automated test.', ''].join('\n')

const CSV_SOURCE = ['name,quantity,price', 'Aurora Desk Lamp,2,49.00', 'Nimbus Wireless Mouse,1,24.50', 'Cobalt Notebook,5,8.75', ''].join('\n')

const SAMPLES: Record<SampleKind, SampleFile> = {
  image: { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') },
  pdf: { name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF_SOURCE, 'utf8') },
  text: { name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT_SOURCE, 'utf8') },
  csv: { name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV_SOURCE, 'utf8') },
}

/** The sample file for a kind, optionally renamed. */
export function sampleFile(kind: SampleKind = 'image', name?: string): SampleFile {
  const base = SAMPLES[kind] ?? SAMPLES.image
  if (!name) return { ...base }
  // Keep the real extension: a server that validates by extension should see
  // the type it was actually given.
  const ext = base.name.slice(base.name.lastIndexOf('.'))
  const clean = name.replace(/[^\w.\- ]/g, '').slice(0, 80) || base.name
  return { ...base, name: clean.toLowerCase().endsWith(ext) ? clean : clean + ext }
}

/** Base64 of a sample, for embedding in an exported Playwright spec. */
export function sampleBase64(kind: SampleKind = 'image'): string {
  return (SAMPLES[kind] ?? SAMPLES.image).buffer.toString('base64')
}
