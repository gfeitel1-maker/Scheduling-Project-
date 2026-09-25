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
import { buildVerifierReport } from './verifierReport.js'
import { writeGateReport } from './gateReportPersist.js'
import { OPINION_GATE_NAMES } from './gateReportSchema.js'
import { checkOpinionProvenance, SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'

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

  // T167. Verifier's PerGateReport is a function of exit codes, so nobody should be typing it by
  // hand. Name a gate results file and the CLI derives it, leaving the caller only the opinion
  // gates — the part that actually needs a model. The step Grader keeps skipping is clerical, and
  // this is most of the clerical work.
  let reports = input.reports
  if (input.gateResults !== undefined) {
    if (reports.some((r) => r?.gate_name === 'verifier')) {
      throw new CliUsageError(
        'input supplies both "gateResults" and a hand-written verifier report — ' +
        'remove one. Silently preferring either would hide which evidence was actually used.',
      )
    }
    let resultsText
    try {
      resultsText = readFileSync(input.gateResults, 'utf8')
    } catch (e) {
      throw new CliUsageError(`cannot read gateResults file: ${input.gateResults} (${e.message})`)
    }
    // `commit` is passed through to the T169 binding check: a green results file from an
    // unrelated commit proves a green run happened, not that it verified THIS work.
    const verifier = buildVerifierReport({
      text: resultsText,
      evidenceRef: input.gateResults,
      expectedSha: input.commit,
    })
    // The reducer's output carries blocking_findings only, by design, and a binding problem is
    // HIGH rather than BLOCKING (it means "we cannot tell", not "it failed"). So the reason a
    // derived verifier report is not PASS would otherwise be visible nowhere: the GateReport
    // says BLOCK with no explanation. Surface it here instead of widening the reducer, whose
    // unchanged semantics are the thing worth protecting.
    if (verifier.verdict !== 'PASS' && verifier.findings.length > 0) {
      for (const f of verifier.findings) {
        console.error(`verifier ${verifier.verdict} — ${f.summary}`)
      }
    }
    reports = [verifier, ...reports]
  }

  // T171. The reducer trusts `reports` to actually have come from the gates they claim — that
  // trust is the last unguarded input, demonstrated by hand-typing a clean PASS_ELIGIBLE with no
  // reviewer having seen the diff. Bind every opinion report (security/red_hat/tester/
  // code_reviewer) to a real, completed dispatch of the matching subagent_type in the supplied
  // session transcript before it ever reaches reduceGateReport. Mandatory, not opt-in — an
  // omitted sessionTranscript is treated exactly like an absent one: every opinion report in this
  // run is unbound. This mirrors validatePerGateReport's own stance on verifier's evidence_ref
  // (required, not optional) rather than verifierReport's SHA-binding stance (downgrade, still
  // countable) — because an unbound opinion score is precisely the failure mode this module
  // exists to stop, not a "we simply cannot tell" case Verifier's UNVERIFIED represents.
  let transcriptText = ''
  if (input.sessionTranscript !== undefined) {
    try {
      transcriptText = readFileSync(input.sessionTranscript, 'utf8')
    } catch (e) {
      throw new CliUsageError(`cannot read sessionTranscript file: ${input.sessionTranscript} (${e.message})`)
    }
  }
  // A report that fails provenance binding cannot be turned into a GateReport at all — not even
  // a BLOCK one. Substituting a sentinel and writing it (the pre-fix behavior) produces a
  // plausible-looking artifact recording a verdict about inputs the tool never actually saw.
  // That is worse than no file: a reader (or a committed run record) mistakes fabricated content
  // for a real "failed the gates" result. So an unbound opinion report throws before any write,
  // naming every unbound gate and why — a CLI-usage-shaped failure (the caller didn't supply
  // provable evidence), not a gate verdict, hence CliUsageError.
  const unbound = []
  reports = reports.map((report) => {
    const gateName = report?.gate_name
    if (!OPINION_GATE_NAMES.includes(gateName)) return report

    const provenance = checkOpinionProvenance({ text: transcriptText, gateName })
    if (provenance.bound) return report

    const reason = input.sessionTranscript === undefined
      ? `no sessionTranscript was supplied — cannot verify a ${SUBAGENT_TYPE_BY_GATE[gateName]} dispatch produced this report`
      : provenance.reason
    console.error(`${gateName} report is UNBOUND — ${reason}`)
    unbound.push(`${gateName}: ${reason}`)
    return report
  })
  if (unbound.length > 0) {
    throw new CliUsageError(
      `cannot produce a GateReport — provenance for ${unbound.length} opinion report(s) could not be ` +
      `established, so no verdict can be written:\n${unbound.join('\n')}`,
    )
  }

  const gateReport = reduceGateReport({
    taskId: input.taskId,
    round: input.round,
    expectedOpinionGates: input.expectedOpinionGates,
    reports,
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
