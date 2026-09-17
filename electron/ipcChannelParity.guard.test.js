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
// These three are exempt because they are DEAD LISTENERS, not missing senders — verified
// 2026-09-17 (T213). They are severed halves of the Stage 6c WebSocket cutover:
//
//   * 'shoresh:pairing-approved' / 'shoresh:pairing-denied' — the live join flow is entirely the
//     POLLING IPC path (JoinByCodeScreen -> joinAwaitPairingDecision), which resolves synchronously
//     through joinSession.js's waitForPairingDecision. syncNode.js's sendPairingApproved/Denied are
//     libp2p WIRE messages to the joining peer, not webContents.send. Nothing can fire these.
//   * 'shoresh:token-renewed' — no renewal mechanism exists anywhere in electron/ or src/; only the
//     listener and its mock survive.
//
// The phases these would drive (pairing_pending / pairing_denied, useDeviceMode.js:309-310) are
// gated on `joinHost`, whose ONLY writer is selectJoinHost — which has no callers (verified by
// grep -a across src/, electron/, scripts/, test/, and by checking for dynamic `device[...]` access,
// since `graphify affected` returns "No unique node match" for a hook-returned property and is
// inconclusive here by its own documented blind spot).
//
// ONE CORRECTION to the "unreachable" framing, and it is why this is a ticket rather than a
// shrug: `joinHost` HYDRATES FROM localStorage (useDeviceMode.js:53). A device upgraded from a
// pre-Stage-6c build with a leftover `shoresh-join-host` value enters pairing_pending and — with
// these listeners dead — can never leave it. Unreachable on a fresh install; a trap on an upgraded
// one.
//
// Removing only the three listeners would leave pairingStatus able to reach 'pending' but never
// 'approved'/'denied'. The deletion is T213 and is deliberately NOT done here — it is structural
// work on the device phase machine, outside this change's approved scope. When it lands, these
// come out and the guard enforces for real.
//
// Note the asymmetry that kept this invisible: 'shoresh:pairing-request' (Host side) IS live. The
// cutover severed DIRECTIONS of a flow rather than whole flows, so a half-live channel family reads
// as healthy from either end. That is the class this guard is valuable against, beyond the one dead
// channel that prompted it.
const KNOWN_GAPS = ['shoresh:pairing-approved', 'shoresh:pairing-denied', 'shoresh:token-renewed']

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
