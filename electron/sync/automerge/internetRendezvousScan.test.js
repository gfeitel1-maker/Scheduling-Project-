// @vitest-environment node
//
// Non-vacuity for the Tier-4 guard's detection half (T207).
//
// The standing lesson this file exists to honour: a guard test that plants only the defect the
// guard was designed around proves nothing. The original boundary guard was a list of npm package
// names; every shape below is one that list would have waved straight through. Several are
// deliberately awkward variants — member access, odd whitespace, a dynamic import, a template
// literal — because the realistic way this detection fails is not "nobody wrote a rendezvous
// client", it is "somebody wrote one slightly differently than the regex author pictured".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findInternetEgress, stripComments } from './internetRendezvousScan.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('findInternetEgress — planted defects the package-list guard could not see', () => {
  const planted = [
    ['bare fetch', `const r = await fetch('/v1/peers/' + ns)`],
    ['globalThis.fetch', `const r = await globalThis.fetch(url)`],
    ['fetch with odd whitespace', `await fetch\n  (url)`],
    ['static https import', `import https from 'node:https'`],
    ['CommonJS https require', `const { request } = require('https')`],
    ['dynamic https import', `const https = await import('node:https')`],
    ['https.request call', `https.request(opts, cb)`],
    ['https . get with spaces', `https . get (url)`],
    ['undici', `import { request } from 'undici'`],
    ['axios', `import axios from 'axios'`],
    ['node-fetch', `import f from 'node-fetch'`],
    ['XMLHttpRequest', `const x = new XMLHttpRequest()`],
    ['raw tls socket', `tls.connect({ host, port })`],
    ['raw net socket', `net.connect(443, host)`],
    ['hard-coded URL in a string', `const BASE = "https://rendezvous.shoresh.org"`],
    ['hard-coded URL in a template literal', 'const u = `https://${host}/v1/register`'],
  ]

  for (const [name, source] of planted) {
    it(`flags: ${name}`, () => {
      expect(findInternetEgress(source)).not.toEqual([])
    })
  }
})

describe('findInternetEgress — does not cry wolf', () => {
  it('ignores a URL that appears only in a comment', () => {
    expect(findInternetEgress(`// see https://example.com/docs\nconst x = 1`)).toEqual([])
  })

  it('ignores a URL inside a block comment', () => {
    expect(findInternetEgress(`/*\n * https://example.com\n */\nexport const x = 1`)).toEqual([])
  })

  it('does not treat a property named fetch-something as a fetch call', () => {
    expect(findInternetEgress(`state.prefetchCount(1)`)).toEqual([])
  })

  it('returns [] for ordinary libp2p-only sync source', () => {
    expect(findInternetEgress(`import { tcp } from '@libp2p/tcp'\nawait node.dial(peerId)`)).toEqual([])
  })
})

describe('stripComments', () => {
  it('leaves a protocol-relative-looking string in code alone', () => {
    // The `:` guard in the line-comment rule is what keeps `https://` in real code from being
    // mistaken for the start of a comment and swallowing the rest of the line.
    expect(stripComments(`const u = 'https://a/b'`)).toContain('https://a/b')
  })
})

describe('the real sync tree performs no internet egress today', () => {
  it('transport.js is libp2p-only', () => {
    expect(findInternetEgress(readFileSync(join(__dirname, 'transport.js'), 'utf8'))).toEqual([])
  })
})
