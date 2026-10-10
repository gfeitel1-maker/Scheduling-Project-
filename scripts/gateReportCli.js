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

import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reduceGateReport } from './gateReportReduce.js'
import { buildVerifierReport } from './verifierReport.js'
import { writeGateReport } from './gateReportPersist.js'
import { OPINION_GATE_NAMES } from './gateReportSchema.js'
import { checkOpinionProvenance, SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'
import { loadWorkflowRun, checkWorkflowProvenance } from './workflowDispatchProvenance.js'

const REQUIRED_FIELDS = ['taskId', 'round', 'expectedOpinionGates', 'reports']

export class CliUsageError extends Error {}

// The only workflow whose run is the gate of record. Pinned by the workflow's database id, resolved
// from this path: a workflow's display name is free text any other workflow can reuse, its path is not.
// (`gh run view --json` has no `path` field, so the run is matched by workflowDatabaseId instead.)
export const GATE_WORKFLOW_PATH = '.github/workflows/gate.yml'
export const GATE_WORKFLOW_NAME = 'gate' // gate.yml's `name:`

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Default run fetcher: asks GitHub, never the caller, what the run actually was. */
export function defaultFetchRun(id) {
  const run = JSON.parse(gh(['run', 'view', String(id), '--json', 'headSha,status,conclusion,workflowName,workflowDatabaseId']))
  const gateWorkflow = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/workflows/${GATE_WORKFLOW_PATH.split('/').pop()}`]))
  return JSON.stringify({ ...run, gateWorkflowId: gateWorkflow.id })
}

/**
 * Confirm a typed ciRun against GitHub. Returns the FETCHED values, or null (with a reason) when
 * the run cannot be confirmed: fetch failed/unparseable, not gate.yml, or a typed field disagrees.
 * Fails closed — an unconfirmable run is simply not counted.
 */
export function confirmCiRun(ciRun, fetchRun) {
  if (!ciRun || ciRun.id == null || ciRun.id === '') return { run: null, reason: 'ciRun has no id' }
  // The id becomes a gh argv element. execFile rules out shell injection but not ARGUMENT
  // injection: '--repo=other/fork' would let a caller confirm a run from a repo they control.
  if ((typeof ciRun.id !== 'number' && typeof ciRun.id !== 'string') || !/^[0-9]+$/.test(String(ciRun.id))) {
    return { run: null, reason: `ciRun id ${JSON.stringify(ciRun.id)} is not a numeric run id` }
  }
  let fetched
  try {
    fetched = JSON.parse(fetchRun(ciRun.id))
  } catch (e) {
    return { run: null, reason: `could not confirm run ${ciRun.id} via gh (${e.message})` }
  }
  if (!fetched || typeof fetched !== 'object') return { run: null, reason: `gh returned no run object for ${ciRun.id}` }
  const isGate = fetched.gateWorkflowId != null && fetched.workflowDatabaseId === fetched.gateWorkflowId &&
    fetched.workflowName === GATE_WORKFLOW_NAME
  if (!isGate) {
    return { run: null, reason: `run ${ciRun.id} is workflow "${fetched.workflowName}" (id ${fetched.workflowDatabaseId}), not the gate (${GATE_WORKFLOW_PATH}, id ${fetched.gateWorkflowId})` }
  }
  for (const k of ['headSha', 'status', 'conclusion']) {
    if (ciRun[k] !== undefined && ciRun[k] !== fetched[k]) {
      return { run: null, reason: `run ${ciRun.id}: typed ${k} "${ciRun[k]}" does not match GitHub's "${fetched[k]}"` }
    }
  }
  return { run: { id: ciRun.id, headSha: fetched.headSha, status: fetched.status, conclusion: fetched.conclusion }, reason: null }
}

// A local evidence file counts only if it IS green gate results bound to the commit under review —
// an arbitrary existing file (package.json, a test file) proves nothing.
function isGreenGateResultsFor(p, commit) {
  if (typeof commit !== 'string' || commit === '') return false
  let text
  try {
    if (!statSync(p).isFile()) return false
    text = readFileSync(p, 'utf8')
  } catch { return false }
  return buildVerifierReport({ text, evidenceRef: p, expectedSha: commit }).verdict === 'PASS'
}

// Same predicate as the reducer's ciRunPass: completed, success, on exactly the head under review.
function ciRunPasses(run, commit) {
  return Boolean(run && typeof commit === 'string' && commit !== '' && run.headSha === commit &&
    run.status === 'completed' && run.conclusion === 'success')
}

// Does evidenceRef name the confirmed run (bare id, `runs/<id>`, or a URL ending in it)?
function citesRun(evidenceRef, runId) {
  const id = String(runId).replace(/[^0-9A-Za-z]/g, '')
  return id !== '' && new RegExp(`(^|[^0-9A-Za-z])${id}($|[^0-9A-Za-z])`).test(evidenceRef)
}

/**
 * @param {string} inputPath - path to the input JSON file
 * @param {object} opts
 * @param {string} opts.runsDir
 * @returns {object} the GateReport, with gate_report_ref added
 */
export function runGateReportCli(inputPath, { runsDir, fetchRun = defaultFetchRun }) {
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
  // A Workflow-tool run writes its reviewers to a run directory instead of the Governor transcript;
  // `workflowDir` binds against that. Either source may bind a report.
  let workflowAgents
  if (input.workflowDir !== undefined) {
    try {
      workflowAgents = loadWorkflowRun(input.workflowDir)
    } catch (e) {
      throw new CliUsageError(`cannot read workflowDir: ${input.workflowDir} (${e.message})`)
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
    const viaWorkflow = workflowAgents && checkWorkflowProvenance({ ...workflowAgents, taskId: input.taskId, report })
    if (viaWorkflow?.bound) return report

    const reason = viaWorkflow ? viaWorkflow.reason
      : input.sessionTranscript === undefined
      ? `no sessionTranscript or workflowDir was supplied — cannot verify a ${SUBAGENT_TYPE_BY_GATE[gateName]} dispatch produced this report`
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

  // A typed ciRun is a claim; GitHub is the evidence. Count only the fetched, gate.yml run.
  let ciRun
  if (input.ciRun !== undefined && input.ciRun !== null) {
    const confirmed = confirmCiRun(input.ciRun, fetchRun)
    if (confirmed.run) ciRun = confirmed.run
    else console.error(`ciRun NOT counted — ${confirmed.reason}`)
  }

  // A hand-written verifier PASS is a claim too. It counts only if its evidence_ref resolves to a
  // green gate-results file stamped with `commit`, or to the run just confirmed AND passing on `commit`; otherwise it is downgraded to UNVERIFIED.
  // (A derived report from gateResults already carries its file as evidence and is exempt.)
  if (input.gateResults === undefined) {
    reports = reports.map((r) => {
      if (r?.gate_name !== 'verifier' || r.verdict !== 'PASS') return r
      const ref = typeof r.evidence_ref === 'string' ? r.evidence_ref : ''
      if (ref !== '' && (isGreenGateResultsFor(ref, input.commit) || (ciRunPasses(ciRun, input.commit) && citesRun(ref, ciRun.id)))) return r
      const why = `hand-written verifier PASS cites evidence_ref "${ref}" which is neither a green gate-results file stamped with commit ${input.commit} nor a confirmed, successful gate.yml run on that commit`
      console.error(`verifier downgraded to UNVERIFIED — ${why}`)
      return { ...r, verdict: 'UNVERIFIED', findings: [...(r.findings || []), { severity: 'HIGH', ref: ref || 'evidence', summary: why }] }
    })
  }

  const gateReport = reduceGateReport({
    taskId: input.taskId,
    round: input.round,
    expectedOpinionGates: input.expectedOpinionGates,
    reports,
    // CI is the gate of record: a completed, successful run on `commit` satisfies verifier_pass
    // without a local results file. The reducer checks the binding and records the run.
    ciRun,
    headSha: input.commit,
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
