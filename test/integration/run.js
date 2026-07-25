/**
 * Integration test runner.
 *
 * Usage:  node test/integration/run.js
 *
 * Runs every scenario in order.  Prints PASS/FAIL per scenario and exits
 * with code 0 (all pass) or 1 (any failure).
 */

import { run as scenario01 } from './scenarios/01-bootstrap.js'
import { run as scenario02 } from './scenarios/02-offline-restart.js'
import { run as scenario03 } from './scenarios/03-idempotency.js'
import { run as scenario04 } from './scenarios/04-conflict.js'
import { run as scenario05 } from './scenarios/05-revocation.js'
import { run as scenario06 } from './scenarios/06-catchup.js'

const SCENARIOS = [
  { name: '01 bootstrap + first sync', fn: scenario01 },
  { name: '02 offline write survives restart', fn: scenario02 },
  { name: '03 idempotency (no duplicate on retry)', fn: scenario03 },
  { name: '04 conflict recorded in DB', fn: scenario04 },
  { name: '05 revoked device → 4404', fn: scenario05 },
  { name: '06 catchup from watermark', fn: scenario06 },
]

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const DIM  = '\x1b[2m'
const RST  = '\x1b[0m'

async function main() {
  console.log(`\n${DIM}Shoresh integration tests${RST}\n`)
  let failures = 0

  for (const { name, fn } of SCENARIOS) {
    const label = name.padEnd(44)
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
      if (err.stack) {
        const lines = err.stack.split('\n').slice(1, 4).map(l => `         ${l.trim()}`)
        console.log(lines.join('\n'))
      }
      failures++
    }
  }

  const total = SCENARIOS.length
  const passed = total - failures
  console.log(`\n  ${passed}/${total} passed\n`)

  if (failures > 0) {
    // Let unhandled rejection exit with code 1.
    throw new Error(`${failures} integration scenario(s) failed`)
  }
}

main().catch((err) => {
  // Only print if it's not the summary error we threw above.
  if (!err.message.includes('integration scenario(s) failed')) {
    console.error(err)
  }
  // Node exits with 1 on unhandled rejection.
  throw err
})
