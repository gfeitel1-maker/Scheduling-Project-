// The real guard: every channel electron/preload.js registers with ipcRenderer.on must have at
// least one corresponding sender somewhere in electron/. See ipcChannelParity.js's header for why
// this exists (T207-shaped blind spot: 'shoresh:auth-rejected' had a listener and no sender for an
// entire Stage 6 cutover, caught by nothing because every test mocked the channel directly rather
// than asking whether main.js could ever actually fire it) and ipcChannelParity.test.js for
// non-vacuity proof that the detection itself works.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findChannelsWithoutSender } from './ipcChannelParity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const electronRoot = __dirname

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, files)
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js') && !entry.endsWith('.guard.test.js') && entry !== 'preload.js') {
      files.push(full)
    }
  }
  return files
}

// Pre-existing gaps this guard's own construction discovered, NOT introduced by it — same defect
// class as 'shoresh:auth-rejected' (a listener orphaned by the Stage 6 WS-layer deletion, see
// CLAUDE.md's "Stage 6 Cutover COMPLETE"), spun off separately rather than silently fixed here so
// this ticket (reconnecting shoresh:auth-rejected specifically) stays surgical. Remove an entry
// the moment its sender is restored — this list must only ever shrink.
// EMPTY, and that is the point (2026-09-18). This list once held three channels —
// 'shoresh:pairing-approved', 'shoresh:pairing-denied', 'shoresh:token-renewed' — severed halves of
// the Stage 6c WebSocket cutover: listeners in preload.js with no sender anywhere, driving phases
// (pairing_pending / pairing_denied) gated on `joinHost`, which nothing had written since that
// cutover. #470 deleted the whole dead path, so the exemption's precondition is gone and the guard
// now enforces for real against every channel.
//
// Verified before clearing rather than assumed: all three greps return 0 in electron/preload.js on
// this tree.
//
// Keep this empty. An entry here is a channel whose listener can never fire — either wire the
// sender or delete the listener. The defect that started this work (shoresh:auth-rejected had a
// listener and no sender, so every authoritative Host refusal was invisible to the director) is
// exactly what a populated allowlist would let recur silently.
const KNOWN_GAPS = []

describe('ipcChannelParity guard — every preload listener has a sender', () => {
  it('shoresh:auth-rejected has a real sender in electron/ (the defect this ticket fixes)', () => {
    const preloadSrc = readFileSync(join(electronRoot, 'preload.js'), 'utf8')
    const electronSrc = walk(electronRoot).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(findChannelsWithoutSender(preloadSrc, electronSrc)).not.toContain('shoresh:auth-rejected')
  })

  it('no NEW listener-without-sender channel exists beyond the tracked known gaps', () => {
    const preloadSrc = readFileSync(join(electronRoot, 'preload.js'), 'utf8')
    const electronSrc = walk(electronRoot).map((f) => readFileSync(f, 'utf8')).join('\n')
    const orphaned = findChannelsWithoutSender(preloadSrc, electronSrc, { knownGaps: KNOWN_GAPS })
    expect(orphaned, `Channel(s) [${orphaned.join(', ')}] are registered in preload.js via ` +
      `ipcRenderer.on but nothing in electron/ ever calls send/webContents.send for them — the ` +
      `renderer will register a listener that can never fire. Either wire a sender or, if this is ` +
      `a deliberately-tracked pre-existing gap, add it to KNOWN_GAPS with a comment saying why.`
    ).toEqual([])
  })
})
