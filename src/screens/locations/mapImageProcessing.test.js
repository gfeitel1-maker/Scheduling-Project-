// @vitest-environment jsdom
//
// jsdom has no real <canvas> 2D context or image decoder, so every test here
// injects decode/makeCanvas/toBase64 fakes (processMapImage's third
// argument) rather than exercising the real browser APIs — those stay the
// production defaults, unverified by this file, exactly like every other
// browser-API-backed util in this codebase that can't be meaningfully unit
// tested without a real browser (see docs/adr/2026-08-16-locations-optional-map.md
// D2/D5 for what each guard defends against).
import { describe, it, expect, vi } from 'vitest'
import {
  processMapImage,
  MapImageError,
  MAX_DECODED_MEGAPIXELS,
  MAX_LONGEST_EDGE,
  TARGET_BYTES,
  HARD_CAP_BYTES,
  JPEG_QUALITY_PASS_1,
  JPEG_QUALITY_PASS_2,
} from './mapImageProcessing.js'

function fakeFile(type) {
  return { type }
}

function fakeDecode(width, height) {
  return vi.fn(async () => ({ width, height, drawable: { fake: true } }))
}

// Returns a makeCanvas fake plus a toBlob call log, so tests can assert how
// many passes ran and at what quality — the thing the two-pass retry logic
// (D2: 0.82 -> 0.6) actually needs to be tested, not just its final output.
function fakeCanvasFactory(blobSizesByQuality) {
  const drawCalls = []
  const toBlobCalls = []
  const makeCanvas = vi.fn((width, height) => ({
    width,
    height,
    getContext: () => ({
      drawImage: (...args) => drawCalls.push(args),
    }),
    toBlob: (cb, mime, quality) => {
      toBlobCalls.push({ mime, quality })
      const size = blobSizesByQuality[quality]
      cb({ size })
    },
  }))
  return { makeCanvas, drawCalls, toBlobCalls }
}

const fakeToBase64 = vi.fn(async (blob) => `base64-of-${blob.size}-bytes`)

describe('processMapImage — type guard (D5, checked BEFORE decode)', () => {
  it('rejects a non-allowlisted MIME type without ever calling decode', async () => {
    const decode = fakeDecode(800, 600)
    await expect(
      processMapImage(fakeFile('image/svg+xml'), { decode, makeCanvas: vi.fn(), toBase64: fakeToBase64 })
    ).rejects.toMatchObject({ code: 'bad_type' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects an unlisted-but-plausible-looking type (gif) the same way', async () => {
    await expect(
      processMapImage(fakeFile('image/gif'), { decode: fakeDecode(100, 100), makeCanvas: vi.fn(), toBase64: fakeToBase64 })
    ).rejects.toBeInstanceOf(MapImageError)
  })

  it('accepts every allowlisted type at the type-check stage (does not throw bad_type for them)', async () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const { makeCanvas } = fakeCanvasFactory({ [JPEG_QUALITY_PASS_1]: 1000 })
      const result = await processMapImage(fakeFile(type), {
        decode: fakeDecode(800, 600),
        makeCanvas,
        toBase64: fakeToBase64,
      })
      expect(result.mime).toBe('image/jpeg')
    }
  })
})

describe('processMapImage — decompression-bomb guard (D2, 40 megapixels, before any canvas draw)', () => {
  it('rejects a decoded raster over 40 megapixels and never touches the canvas', async () => {
    // Just over the limit: e.g. 8000x5001 = 40,008,000 > 40,000,000.
    const decode = fakeDecode(8000, 5001)
    const makeCanvas = vi.fn()
    await expect(
      processMapImage(fakeFile('image/png'), { decode, makeCanvas, toBase64: fakeToBase64 })
    ).rejects.toMatchObject({ code: 'decompression_bomb' })
    expect(makeCanvas).not.toHaveBeenCalled()
  })

  it('accepts a decoded raster exactly at the 40-megapixel boundary', async () => {
    // 8000 x 5000 = 40,000,000 exactly.
    const { makeCanvas } = fakeCanvasFactory({ [JPEG_QUALITY_PASS_1]: 1000 })
    const decode = fakeDecode(8000, 5000)
    const result = await processMapImage(fakeFile('image/png'), { decode, makeCanvas, toBase64: fakeToBase64 })
    expect(result).toBeTruthy()
  })

  it('the megapixel constant matches the ADR number', () => {
    expect(MAX_DECODED_MEGAPIXELS).toBe(40_000_000)
  })
})

describe('processMapImage — downscale to the 1600px longest edge (D2)', () => {
  it('scales a wide image down so its longest edge is exactly 1600, preserving aspect ratio', async () => {
    const { makeCanvas } = fakeCanvasFactory({ [JPEG_QUALITY_PASS_1]: 1000 })
    const decode = fakeDecode(3200, 1600) // 2:1, longest edge 3200
    const result = await processMapImage(fakeFile('image/jpeg'), { decode, makeCanvas, toBase64: fakeToBase64 })
    expect(result.width).toBe(MAX_LONGEST_EDGE)
    expect(result.height).toBe(800)
  })

  it('does not upscale an image already smaller than the cap', async () => {
    const { makeCanvas } = fakeCanvasFactory({ [JPEG_QUALITY_PASS_1]: 1000 })
    const decode = fakeDecode(400, 300)
    const result = await processMapImage(fakeFile('image/jpeg'), { decode, makeCanvas, toBase64: fakeToBase64 })
    expect(result.width).toBe(400)
    expect(result.height).toBe(300)
  })
})

describe('processMapImage — two-pass JPEG quality retry and hard cap (D2)', () => {
  it('happy path: a single pass at quality 0.82 when the first export is already under TARGET_BYTES', async () => {
    const { makeCanvas, toBlobCalls } = fakeCanvasFactory({ [JPEG_QUALITY_PASS_1]: TARGET_BYTES - 1 })
    const decode = fakeDecode(800, 600)
    const result = await processMapImage(fakeFile('image/jpeg'), { decode, makeCanvas, toBase64: fakeToBase64 })
    expect(toBlobCalls).toEqual([{ mime: 'image/jpeg', quality: JPEG_QUALITY_PASS_1 }])
    expect(result.base64).toBe(`base64-of-${TARGET_BYTES - 1}-bytes`)
  })

  it('retries once at quality 0.6 when the first pass exceeds TARGET_BYTES, and succeeds if the retry lands under the hard cap', async () => {
    const { makeCanvas, toBlobCalls } = fakeCanvasFactory({
      [JPEG_QUALITY_PASS_1]: TARGET_BYTES + 1,
      [JPEG_QUALITY_PASS_2]: HARD_CAP_BYTES - 1,
    })
    const decode = fakeDecode(800, 600)
    const result = await processMapImage(fakeFile('image/jpeg'), { decode, makeCanvas, toBase64: fakeToBase64 })
    expect(toBlobCalls).toEqual([
      { mime: 'image/jpeg', quality: JPEG_QUALITY_PASS_1 },
      { mime: 'image/jpeg', quality: JPEG_QUALITY_PASS_2 },
    ])
    expect(result.base64).toBe(`base64-of-${HARD_CAP_BYTES - 1}-bytes`)
  })

  it('hard-rejects when even the quality-0.6 retry stays over HARD_CAP_BYTES — never truncates, never silently accepts', async () => {
    const { makeCanvas, toBlobCalls } = fakeCanvasFactory({
      [JPEG_QUALITY_PASS_1]: TARGET_BYTES + 1,
      [JPEG_QUALITY_PASS_2]: HARD_CAP_BYTES + 1,
    })
    const decode = fakeDecode(800, 600)
    await expect(
      processMapImage(fakeFile('image/jpeg'), { decode, makeCanvas, toBase64: fakeToBase64 })
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(toBlobCalls).toHaveLength(2)
  })
})

describe('processMapImage — the REAL default decoder wraps a decode failure as bad_type (D5, the polyglot/spoofed-extension case)', () => {
  // Exercises the production defaultDecode (no injected `decode` override)
  // by stubbing the global createImageBitmap jsdom does not implement — this
  // is what actually proves the "spoofed extension" defense: a file whose
  // Blob.type passed the allowlist but whose real bytes fail to decode as
  // that format must surface as bad_type, not a raw, unhandled rejection.
  it('converts a rejected createImageBitmap into MapImageError bad_type', async () => {
    const previous = globalThis.createImageBitmap
    globalThis.createImageBitmap = vi.fn(async () => {
      throw new Error('not a valid PNG')
    })
    try {
      await expect(
        processMapImage(fakeFile('image/png'), { makeCanvas: vi.fn(), toBase64: fakeToBase64 })
      ).rejects.toMatchObject({ code: 'bad_type' })
    } finally {
      globalThis.createImageBitmap = previous
    }
  })

  it('converts a missing createImageBitmap (unsupported browser) into MapImageError bad_type', async () => {
    const previous = globalThis.createImageBitmap
    delete globalThis.createImageBitmap
    try {
      await expect(
        processMapImage(fakeFile('image/png'), { makeCanvas: vi.fn(), toBase64: fakeToBase64 })
      ).rejects.toMatchObject({ code: 'bad_type' })
    } finally {
      globalThis.createImageBitmap = previous
    }
  })
})
