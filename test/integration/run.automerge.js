/**
 * Stage 6a libp2p integration runner.
 *
 * Every Client here JOINS FOR REAL — types the camp's code, is approved by the
 * "director", signs in with a PIN, and receives its identity and the camp's
 * data over libp2p (docs/adr/2026-09-08-libp2p-join-flow.md). There is no
 * `seedCampIdentity` any more, so a scenario that passes is evidence about the
 * product rather than about the harness. That change is what surfaced three
 * real defects on its first run; two are fixed, one is reported (see the
 * SCENARIOS comment below).
 *
 * Runs the subset of integration scenarios that have been ported to the
 * Automerge/libp2p engine (see docs/work/plans/2026-09-07-stage6-cutover-plan.md,
 * "6a — Port the integration harness to libp2p" and this session's Stage 6a
 * report for the full 27-scenario classification: which ported cleanly,
 * which were retired as testing op-log-only mechanics with no CRDT
 * equivalent, and which remain unattempted).
 *
 * Usage: node test/integration/run.automerge.js
 */

import { run as scenario01 } from './scenarios/01-bootstrap.automerge.js'
import { run as scenario02 } from './scenarios/02-offline-restart.automerge.js'
import { run as scenario08 } from './scenarios/08-different-field-merge.automerge.js'
import { run as scenario28 } from './scenarios/28-conflicting-edit.automerge.js'
import { run as scenario05 } from './scenarios/05-revocation.automerge.js'
import { run as scenario14 } from './scenarios/14-corrupt-payload.automerge.js'
import { run as scenario16 } from './scenarios/16-role-change.automerge.js'
import { run as scenario17 } from './scenarios/17-joining-device-domain-data.automerge.js'
import { run as scenario07 } from './scenarios/07-pairing-reconnect.automerge.js'
import { run as scenario15 } from './scenarios/15-clock-skew.automerge.js'
import { run as scenario20 } from './scenarios/20-delete-used-record.automerge.js'
import { run as scenario11 } from './scenarios/11-snapshot-restore.automerge.js'
import { run as scenario22 } from './scenarios/22-location-merge.automerge.js'
import { run as scenario23 } from './scenarios/23-camp-map-sync.automerge.js'
import { run as scenario19 } from './scenarios/19-retire-orphan-slots.automerge.js'
import { run as scenario21 } from './scenarios/21-ingest-prior-year.automerge.js'
import { run as scenario13 } from './scenarios/13-host-crash-mid-sync.automerge.js'
import { run as scenario29 } from './scenarios/29-hand-edit-survives-reimport.automerge.js'

// Scenario 08 (concurrent-create data loss) and scenario 28 (two directors
// disagree about one slot) are both FIXED and both pass consistently, having
// failed ~80% and ~50% of runs respectively before the reconciler
// (docs/adr/2026-09-08-crdt-conflict-reconciliation.md).
//
// Worth keeping, because it cost a long detour: scenario 28's intermittency was
// never a sync problem. A resolution failed only when the RECORD KEY was
// contested rather than merely a field — which is exactly what happens when two
// devices each create the same slot id — and in that shape a field write lands
// INSIDE the surviving version and leaves the contest standing, so the conflict
// came straight back on the next projection. Whether that path or the
// field-level one reported depended on how the two writes interleaved, which is
// where the ~50% came from. Do not re-derive this by hunting the network.
const SCENARIOS = [
  { name: '01 bootstrap + first sync (libp2p)', fn: scenario01 },
  { name: '02 offline write survives restart (libp2p)', fn: scenario02 },
  { name: '08 different-field edits merge (libp2p)', fn: scenario08 },
  { name: '28 conflicting edit is surfaced to both (libp2p)', fn: scenario28 },
  { name: '05 a revoked device is refused, and evicted (libp2p)', fn: scenario05 },
  { name: '14 malformed payloads are rejected safely (libp2p)', fn: scenario14 },
  { name: '16 role change takes effect with no token re-issue (libp2p)', fn: scenario16 },
  { name: '17+25+26+27 a joining device receives the whole domain (libp2p)', fn: scenario17 },
  { name: '07 pairing survives a mid-flight reconnect (libp2p)', fn: scenario07 },
  { name: '15 a wrong clock does not reorder or hide a conflict (libp2p)', fn: scenario15 },
  { name: '20 deleting a used record replicates (libp2p)', fn: scenario20 },
  { name: '11 a saved version is not rewritten by later edits (libp2p)', fn: scenario11 },
  { name: '22 merging near-duplicate locations replicates both halves (libp2p)', fn: scenario22 },
  { name: '23 a large camp-map image replicates intact (libp2p)', fn: scenario23 },
  { name: '19 orphaned slots do not replicate (libp2p)', fn: scenario19 },
  { name: '21 a prior year ingest replicates in full (libp2p)', fn: scenario21 },
  { name: '13 the Host vanishes mid-exchange and nothing is lost (libp2p)', fn: scenario13 },
  // NOT a port — new coverage for a defect the port work uncovered
  // (docs/adr/2026-09-09-field-provenance-in-the-document.md).
  { name: '29 a hand edit survives a re-import on the other device (libp2p)', fn: scenario29 },
]

// COVERAGE, so the count above is readable without arithmetic:
//   20 of the 27 WS originals are covered by the 17 scenarios listed here
//      (17 collapses 17/25/26/27, and 28 replaces 04).
//    6 are retired with a stated reason, one section each, in
//      docs/work/evidence/2026-09-08-retired-ws-scenarios.md — 03, 06, 09, 10,
//      12, and the watermark half of 24. Retiring is a decision to record, not
//      a silent deletion; that document is what explains their absence once the
//      WS files are deleted with the transport in 6c.
//    1 is DEFERRED, not retired — 18, below.
//
// WRITTEN BUT NOT LISTED, deliberately: scenarios/18-restore-queue.automerge.js.
//
// It is correct and it fails, on a real gap rather than anything it can fix:
// `trash.js` and `restore.js` answer their questions by querying the
// `operations` table, so a device that RECEIVED a deletion through document
// sync has no rows for it and cannot restore it. That is broken today, and
// removing the op-log would break Trash entirely.
//
// The agreed fix (owner, 2026-09-08) is to narrow what "retire the op-log"
// means: drop it as a SYNC mechanism, keep `operations` as a local-only history
// ledger fed by both local writes and received merges. Scenario 18 is that
// slice's exit criterion, and it goes into this list when the ledger exists.
//
// It is left out rather than weakened into passing, and left in the tree rather
// than deleted, because a failing scenario that names a real gap is worth more
// than either. See docs/current/CRDT_SECURITY_GAPS.md item 7.

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const DIM  = '\x1b[2m'
const RST  = '\x1b[0m'

async function main() {
  console.log(`\n${DIM}Shoresh integration tests — libp2p engine (Stage 6a subset)${RST}\n`)
  let failures = 0

  for (const { name, fn } of SCENARIOS) {
    const label = name.padEnd(48)
    const t0 = Date.now()
    try {
      const result = await fn()
      const ms = Date.now() - t0
      if (result === 'PASS') {
        console.log(`  ${PASS}  ${label}  ${DIM}${ms}ms${RST}`)
      } else {
        console.log(`  ${FAIL}  ${label}  unexpected result: ${result}`)
        failures++
      }
    } catch (err) {
      const ms = Date.now() - t0
      console.log(`  ${FAIL}  ${label}  ${DIM}${ms}ms${RST}`)
      console.log(`         ${err.message}`)
      failures++
    }
  }

  const total = SCENARIOS.length
  const passed = total - failures
  console.log(`\n  ${passed}/${total} passed (${total} libp2p scenarios; they cover 20 of the 27 WS originals — 17 collapses 17/25/26/27)\n`)

  if (failures > 0) throw new Error(`${failures} libp2p integration scenario(s) failed`)
}

main().catch((err) => {
  if (!err.message.includes('integration scenario(s) failed')) console.error(err)
  throw err
})
