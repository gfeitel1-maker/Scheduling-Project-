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

// KNOWN FAILING, deliberately left in and left red: scenario 08 fails because
// two devices that concurrently create the SAME entity lose one side's fields
// on merge — see docs/work/evidence/2026-09-08-concurrent-entity-creation-loses-fields.md
// for the no-network reproducer and the options. It is a pre-existing document-
// model defect that this harness surfaced, not a harness problem and not
// something the join flow introduced, and fixing it is an ADR-level decision.
//
// It is NOT quarantined or skipped. This runner is not wired into
// `npm run verify`, so an honest red here costs nothing and hides nothing,
// whereas removing the scenario would leave the suite reporting 3/3 against a
// known data-loss bug. Do not "fix" this by dropping it from the list.
const SCENARIOS = [
  { name: '01 bootstrap + first sync (libp2p)', fn: scenario01 },
  { name: '02 offline write survives restart (libp2p)', fn: scenario02 },
  { name: '08 different-field edits merge (libp2p)', fn: scenario08 },
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
  console.log(`\n  ${passed}/${total} passed (${total} of 27 total scenarios ported this slice — see Stage 6a report)\n`)

  if (failures > 0) throw new Error(`${failures} libp2p integration scenario(s) failed`)
}

main().catch((err) => {
  if (!err.message.includes('integration scenario(s) failed')) console.error(err)
  throw err
})
