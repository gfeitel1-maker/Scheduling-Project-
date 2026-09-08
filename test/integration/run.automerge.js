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
]

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
  console.log(`\n  ${passed}/${total} passed (${total} libp2p scenarios; they cover 11 of the 27 WS originals — 17 collapses 17/25/26/27)\n`)

  if (failures > 0) throw new Error(`${failures} libp2p integration scenario(s) failed`)
}

main().catch((err) => {
  if (!err.message.includes('integration scenario(s) failed')) console.error(err)
  throw err
})
