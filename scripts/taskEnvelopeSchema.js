// Phase 4 (shadow only) of the portable-agent-team migration — see
// docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md.
//
// Defines the proposed TaskRun/Dispatch/Result envelope from the source
// handoff document, and a pure mapping from a GateReport (the existing,
// locked, unmodified reducer output — see gateReportReduce.js) onto the
// envelope's status fields.
//
// This module is NEVER imported by gateReportCli.js, gateReportReduce.js, or
// any agent profile's required path. It exists to prove the envelope shape
// can represent everything the real reducer already produces, without
// touching the reducer, its schema, or its persistence format. Nothing here
// writes to docs/work/runs/gate-reports/ or any other live state.

export const TASK_RUN_STATUSES = ['in_progress', 'complete', 'blocked', 'escalated']

/**
 * @param {object} input
 * @param {string} input.taskId
 * @param {number} input.round
 * @param {string} input.baseCommit
 * @param {string} input.candidateRef - commit or tree hash; must change if the
 *   candidate changes, so stale evidence can never be silently reused.
 * @param {string[]} input.selectedRoles
 * @param {{role: string, reason: string}[]} input.omissions
 * @returns {{malformed: boolean, problem?: string}}
 */
export function validateTaskRunShape(input) {
  if (!input || typeof input !== 'object') return { malformed: true, problem: 'not an object' }
  const { taskId, round, baseCommit, candidateRef, selectedRoles, omissions } = input
  if (typeof taskId !== 'string' || !taskId) return { malformed: true, problem: 'taskId required' }
  if (!Number.isInteger(round) || round < 1) return { malformed: true, problem: 'round must be a positive integer' }
  if (typeof baseCommit !== 'string' || !baseCommit) return { malformed: true, problem: 'baseCommit required' }
  if (typeof candidateRef !== 'string' || !candidateRef) return { malformed: true, problem: 'candidateRef required' }
  if (!Array.isArray(selectedRoles)) return { malformed: true, problem: 'selectedRoles must be an array' }
  if (!Array.isArray(omissions)) return { malformed: true, problem: 'omissions must be an array' }
  return { malformed: false }
}

/**
 * Maps an existing, unmodified GateReport (from reduceGateReport) onto the
 * proposed TaskRun envelope's status/pending_human_decision fields. Pure,
 * read-only projection — never mutates the GateReport, never re-derives its
 * arithmetic (overall_score, decision_eligibility stay the reducer's alone,
 * per the ADR's "never silently change the existing reducer inputs" rule).
 *
 * @param {object} gateReport - output of reduceGateReport(), untouched.
 * @param {number} maxRounds - this project's constitutional cap (2).
 * @returns {{status: string, pending_human_decision: boolean, gate_report_ref_expected: boolean}}
 */
export function projectTaskRunStatus(gateReport, maxRounds = 2) {
  const { decision_eligibility, round, incomplete } = gateReport

  if (decision_eligibility === 'PASS_ELIGIBLE') {
    return {
      status: 'complete',
      // PASS_ELIGIBLE is not itself a merge/ship decision — a documented gap
      // (incomplete: true) still requires the human promotion gate to see it.
      pending_human_decision: incomplete === true,
      gate_report_ref_expected: true,
    }
  }

  // decision_eligibility === 'BLOCK'
  if (round >= maxRounds) {
    return { status: 'escalated', pending_human_decision: true, gate_report_ref_expected: true }
  }
  return { status: 'blocked', pending_human_decision: false, gate_report_ref_expected: true }
}
