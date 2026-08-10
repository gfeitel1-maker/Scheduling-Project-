// Thin CLI Grader invokes via Bash: node scripts/gateReportCli.js <input.json>
//
// Reads {taskId, round, expectedOpinionGates, reports} from the given JSON
// file, calls reduceGateReport, calls writeGateReport, prints the resulting
// GateReport (with gate_report_ref added) as JSON to stdout.
//
// A CLI-usage error (input file missing/unparseable/missing a required
// top-level field) is distinct from a malformed *gate* report inside a
// structurally valid input — the latter is the reducer's job (§5.1), not
// the CLI's.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reduceGateReport } from './gateReportReduce.js'
import { writeGateReport } from './gateReportPersist.js'

const REQUIRED_FIELDS = ['taskId', 'round', 'expectedOpinionGates', 'reports']

export class CliUsageError extends Error {}

/**
 * @param {string} inputPath - path to the input JSON file
 * @param {object} opts
 * @param {string} opts.runsDir
 * @returns {object} the GateReport, with gate_report_ref added
 */
export function runGateReportCli(inputPath, { runsDir }) {
  let raw
  try {
    raw = readFileSync(inputPath, 'utf8')
  } catch (e) {
    throw new CliUsageError(`cannot read input file: ${inputPath} (${e.message})`)
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    throw new CliUsageError(`input file is not valid JSON: ${inputPath} (${e.message})`)
  }

  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined) {
      throw new CliUsageError(`input is missing required field: ${field}`)
    }
  }
  if (!Array.isArray(input.reports)) {
    throw new CliUsageError('input field "reports" must be an array')
  }
  if (!Array.isArray(input.expectedOpinionGates)) {
    throw new CliUsageError('input field "expectedOpinionGates" must be an array')
  }

  const gateReport = reduceGateReport({
    taskId: input.taskId,
    round: input.round,
    expectedOpinionGates: input.expectedOpinionGates,
    reports: input.reports,
  })

  const gateReportRef = writeGateReport(gateReport, { runsDir })

  return { ...gateReport, gate_report_ref: gateReportRef }
}

// --- CLI ---------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('usage: node scripts/gateReportCli.js <input.json>')
    process.exit(1)
  }
  try {
    const result = runGateReportCli(inputPath, { runsDir: 'docs/work/runs' })
    console.log(JSON.stringify(result, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
