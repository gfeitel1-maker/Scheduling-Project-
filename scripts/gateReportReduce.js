// The GateReport reducer.
//
// Pure, no I/O. Implements
// docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md §5.1-5.8 in
// order. Same inputs -> same aggregate, always.

import { validatePerGateReport, OPINION_GATE_NAMES } from './gateReportSchema.js'

/**
 * @param {object} input
 * @param {string} input.taskId
 * @param {number} input.round
 * @param {string[]} input.expectedOpinionGates - opinion gate_names Governor
 *   declared for this task before dispatch (selected_agents minus verifier).
 * @param {object[]} input.reports - the PerGateReport objects actually
 *   received this round (some gates may be absent).
 * @returns {object} GateReport per spec §4
 */
export function reduceGateReport({ taskId, round, expectedOpinionGates, reports }) {
  // --- §5.1 validate shape first ---------------------------------------
  const malformed = []
  const byGate = new Map() // gate_name -> well-formed report (or absent if malformed/duplicate)
  const seenCounts = new Map()

  for (const report of reports) {
    const gateName = report?.gate_name
    seenCounts.set(gateName, (seenCounts.get(gateName) || 0) + 1)
  }

  for (const report of reports) {
    const gateName = report?.gate_name
    const duplicate = seenCounts.get(gateName) > 1

    if (duplicate) {
      malformed.push({
        gate_name: gateName,
        problem: `duplicate report for gate_name ${gateName}${report?.evidence_ref ? ` (evidence_ref: ${report.evidence_ref})` : ''}`,
      })
      continue
    }

    const { malformed: isMalformed, problem } = validatePerGateReport(report)
    if (isMalformed) {
      malformed.push({
        gate_name: gateName,
        problem: report?.evidence_ref ? `${problem} (evidence_ref: ${report.evidence_ref})` : problem,
      })
      continue
    }

    byGate.set(gateName, report)
  }

  // --- §5.1 (cont'd) flag a well-formed opinion report from a gate not in
  // the expected set. A live report from a gate that wasn't dispatched (or
  // was pre-declared omitted) is itself anomalous — it must not silently
  // enter S (score-inflation laundering) and must not be silently dropped
  // either (dropping would hide the anomaly). Treated as malformed, which
  // forces BLOCK via §5.7.3. Verifier is exempt: it is never a member of
  // expectedOpinionGates and is governed by §5.2, not this check.
  for (const gate of OPINION_GATE_NAMES) {
    if (expectedOpinionGates.includes(gate)) continue
    const report = byGate.get(gate)
    if (!report) continue
    const problem = `report from ${gate} which is not in the expected gate set`
    malformed.push({
      gate_name: gate,
      problem: report.evidence_ref ? `${problem} (evidence_ref: ${report.evidence_ref})` : problem,
    })
    byGate.delete(gate)
  }

  // --- §5.2 verifier_pass ------------------------------------------------
  const verifierReport = byGate.get('verifier')
  const verifierPass = verifierReport !== undefined && verifierReport.verdict === 'PASS'

  // --- §5.3 opinion aggregate ---------------------------------------------
  const gateScores = { security: null, red_hat: null, tester: null, code_reviewer: null }
  const scoredGates = []

  for (const gate of OPINION_GATE_NAMES) {
    const report = byGate.get(gate)
    if (report && (report.verdict === 'PASS' || report.verdict === 'FAIL')) {
      gateScores[gate] = report.score
      scoredGates.push(report.score)
    }
  }

  const overallScore = scoredGates.length
    ? scoredGates.reduce((a, b) => a + b, 0) / scoredGates.length
    : null
  const lowestDimension = scoredGates.length ? Math.min(...scoredGates) : null

  // --- §5.8 self_declared_na (computed before §5.4/§7 so gap logic can use it) --
  const selfDeclaredNa = []
  for (const gate of expectedOpinionGates) {
    const report = byGate.get(gate)
    if (report && report.verdict === 'N/A') {
      selfDeclaredNa.push({ gate_name: gate, na_reason: report.na_reason })
    }
  }

  // --- §7 / §5.4 incomplete + gap -----------------------------------------
  const gap = []
  for (const gate of expectedOpinionGates) {
    const report = byGate.get(gate)
    const wasMalformed = malformed.some((m) => m.gate_name === gate)
    if (report && (report.verdict === 'PASS' || report.verdict === 'FAIL' || report.verdict === 'N/A')) {
      continue // present and well-formed: contributes normally, self-N/A, never a gap
    }
    if (wasMalformed) {
      gap.push({ gate_name: gate, reason: 'malformed' })
    } else {
      gap.push({ gate_name: gate, reason: 'missing' })
    }
  }
  const incomplete = gap.length > 0

  // --- §5.5 blocking_findings ----------------------------------------------
  const blockingFindings = []
  for (const [gateName, report] of byGate.entries()) {
    for (const finding of report.findings) {
      if (finding.severity === 'BLOCKING') {
        blockingFindings.push({ ...finding, gate_name: gateName })
      }
    }
  }

  // --- §5.6 cross_gate_flags -------------------------------------------------
  const byRef = new Map()
  for (const [gateName, report] of byGate.entries()) {
    for (const finding of report.findings) {
      if (!finding.ref) continue
      if (!byRef.has(finding.ref)) byRef.set(finding.ref, new Set())
      byRef.get(finding.ref).add(gateName)
    }
  }
  const crossGateFlags = []
  for (const [ref, gates] of byRef.entries()) {
    if (gates.size >= 2) {
      crossGateFlags.push({ ref, gate_names: [...gates].sort() })
    }
  }
  crossGateFlags.sort((a, b) => a.ref.localeCompare(b.ref))

  // --- §5.7 decision_eligibility -------------------------------------------
  let decisionEligibility = 'PASS_ELIGIBLE'
  if (
    !verifierPass ||
    blockingFindings.length > 0 ||
    malformed.length > 0 ||
    overallScore === null ||
    overallScore < 4.0 ||
    lowestDimension < 3
  ) {
    decisionEligibility = 'BLOCK'
  }

  return {
    task_id: taskId,
    round,
    verifier_pass: verifierPass,
    gate_scores: gateScores,
    overall_score: overallScore,
    lowest_dimension: lowestDimension,
    blocking_findings: blockingFindings,
    incomplete,
    gap,
    cross_gate_flags: crossGateFlags,
    decision_eligibility: decisionEligibility,
    malformed,
    self_declared_na: selfDeclaredNa,
  }
}
