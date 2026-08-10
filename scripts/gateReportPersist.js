// Persists a GateReport to disk.
//
// Writes to <runsDir>/gate-reports/<task_id>-r<round>.json and returns the
// repo-relative path — this *is* gate_report_ref. `runsDir` is an injected
// parameter (default docs/work/runs in the CLI); tests always pass a scratch
// dir so no test run ever writes into the real docs/work/runs/gate-reports/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {object} gateReport
 * @param {object} opts
 * @param {string} opts.runsDir
 * @returns {string} the repo-relative path written (gate_report_ref)
 */
export function writeGateReport(gateReport, { runsDir }) {
  const dir = join(runsDir, 'gate-reports')
  mkdirSync(dir, { recursive: true })

  const filename = `${gateReport.task_id}-r${gateReport.round}.json`
  const path = join(dir, filename)
  writeFileSync(path, JSON.stringify(gateReport, null, 2) + '\n')

  return path
}
