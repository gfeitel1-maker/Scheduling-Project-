// Client-side image downscale/re-encode for the camp map upload (M6, D2/D5,
// docs/adr/2026-08-16-locations-optional-map.md). This is the HAPPY-PATH
// guard — the AUTHORITATIVE gate is appendOp's MAX_FIELD_VALUE_LENGTH
// (electron/ops/operations.js), enforced on both the local write() path and
// the Host's handleSubmitOp path for a remote Client's WS submission. This
// util exists so a well-behaved renderer never gets that far with an
// oversized value, and so the always-re-encode-through-canvas step (D5)
// neutralizes a polyglot/SVG file before it is ever stored — the stored
// bytes are always the canvas's own JPEG output, never the uploaded file's
// original bytes.
//
// The D2 numbers below are a starting point (owner-confirmed, ADR "Open
// questions" #3) — verify against real camp images; a one-line change to
// adjust, not a redesign.
//
// decode/makeCanvas/toBase64 are injectable because jsdom (this repo's test
// environment) has no real <canvas> 2D context or image decoder — the real
// browser APIs are the defaults; tests inject fakes to exercise the guards
// deterministically.

export const MAX_DECODED_MEGAPIXELS = 40_000_000
export const MAX_LONGEST_EDGE = 1600
export const JPEG_QUALITY_PASS_1 = 0.82
export const JPEG_QUALITY_PASS_2 = 0.6
export const TARGET_BYTES = 400_000
export const HARD_CAP_BYTES = 750_000
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']

// Director-facing copy — verbatim from the Designer spec (Part 5 "Outcomes").
export const BAD_TYPE_MESSAGE = "That file isn't a photo Shoresh can use. Choose a JPG, PNG, or WEBP image."
export const DECOMPRESSION_BOMB_MESSAGE =
  'That image is too large for Shoresh to process. Try a smaller photo, or a screenshot instead of the original file.'
export const TOO_LARGE_MESSAGE =
  'This image is too detailed to store, even after shrinking it. Try a simpler photo, or crop it down before uploading.'

export class MapImageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MapImageError'
    this.code = code
  }
}

// Real browser decoder: createImageBitmap reads actual decoded pixel
// dimensions and, per Chromium/Firefox/Safari's decoder selection, sniffs
// real file content rather than trusting the declared Blob.type alone — a
// file renamed to look like a PNG but containing SVG/other bytes fails to
// decode here regardless of what the OS/browser guessed its MIME type was.
// This is "decoded-image validation, not filename/MIME sniffing alone" (D5):
// the ALLOWED_MIME_TYPES check below is the fast first-line filter (and the
// only thing that can reject a GENUINE image/svg+xml file, since some
// browsers CAN rasterize real SVG via createImageBitmap); decode success is
// the deeper check that catches a spoofed extension.
async function defaultDecode(file) {
  if (typeof createImageBitmap !== 'function') {
    throw new MapImageError('bad_type', BAD_TYPE_MESSAGE)
  }
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new MapImageError('bad_type', BAD_TYPE_MESSAGE)
  }
  return { width: bitmap.width, height: bitmap.height, drawable: bitmap }
}

function defaultMakeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new MapImageError('bad_type', BAD_TYPE_MESSAGE))
        else resolve(blob)
      },
      'image/jpeg',
      quality
    )
  })
}

function defaultToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.onerror = () => reject(new MapImageError('bad_type', BAD_TYPE_MESSAGE))
    reader.readAsDataURL(blob)
  })
}

// processMapImage(file) -> { base64, mime: 'image/jpeg', width, height }
// Throws MapImageError with .code in { 'bad_type', 'decompression_bomb', 'too_large' }.
export async function processMapImage(
  file,
  { decode = defaultDecode, makeCanvas = defaultMakeCanvas, toBase64 = defaultToBase64 } = {}
) {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new MapImageError('bad_type', BAD_TYPE_MESSAGE)
  }

  // Decompression-bomb guard (D2): decoded pixel dimensions are read and
  // checked BEFORE any canvas draw operation — a file whose declared size is
  // small but whose decoded raster is enormous is caught before a single
  // pixel is drawn, not after the canvas operation has already spent the
  // memory.
  const { width: decodedWidth, height: decodedHeight, drawable } = await decode(file)
  if (decodedWidth * decodedHeight > MAX_DECODED_MEGAPIXELS) {
    throw new MapImageError('decompression_bomb', DECOMPRESSION_BOMB_MESSAGE)
  }

  const scale = Math.min(1, MAX_LONGEST_EDGE / Math.max(decodedWidth, decodedHeight))
  const width = Math.max(1, Math.round(decodedWidth * scale))
  const height = Math.max(1, Math.round(decodedHeight * scale))

  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(drawable, 0, 0, width, height)

  let blob = await canvasToBlob(canvas, JPEG_QUALITY_PASS_1)
  if (blob.size > TARGET_BYTES) {
    blob = await canvasToBlob(canvas, JPEG_QUALITY_PASS_2)
  }
  if (blob.size > HARD_CAP_BYTES) {
    throw new MapImageError('too_large', TOO_LARGE_MESSAGE)
  }

  const base64 = await toBase64(blob)
  return { base64, mime: 'image/jpeg', width, height }
}
