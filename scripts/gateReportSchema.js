// Validates a single PerGateReport against
// docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md §3/§5.1.
//
// Pure, no I/O. Exports the enums so the reducer and CLI share one source of
// truth instead of re-declaring them.

export const GATE_NAMES = ['verifier', 'security', 'red_hat', 'tester', 'code_reviewer']
export const OPINION_GATE_NAMES = ['security', 'red_hat', 'tester', 'code_reviewer']
export const VERDICTS = ['PASS', 'FAIL', 'N/A', 'UNVERIFIED']
export const SEVERITIES = ['BLOCKING', 'HIGH', 'MEDIUM', 'LOW']

/**
 * @returns {{malformed: boolean, problem?: string}}
 */
export function validatePerGateReport(report) {
  if (!report || typeof report !== 'object') {
    return { malformed: true, problem: 'report is not an object' }
  }

  const { gate_name, verdict, score, na_reason, findings, evidence_ref } = report

  if (!GATE_NAMES.includes(gate_name)) {
    return { malformed: true, problem: `missing or invalid gate_name: ${gate_name}` }
  }
  if (!VERDICTS.includes(verdict)) {
    return { malformed: true, problem: `missing or invalid verdict: ${verdict}` }
  }
  if (!Array.isArray(findings)) {
    return { malformed: true, problem: 'findings is required and must be an array' }
  }
  if (gate_name === 'verifier' && evidence_ref == null) {
    return { malformed: true, problem: 'evidence_ref is required for verifier' }
  }

  const isOpinion = gate_name !== 'verifier'

  if (isOpinion && verdict === 'UNVERIFIED') {
    return { malformed: true, problem: 'UNVERIFIED is verifier-only' }
  }
  if (!isOpinion && score !== null && score !== undefined) {
    return { malformed: true, problem: 'verifier must not carry a score' }
  }
  if (!isOpinion && verdict === 'N/A') {
    return { malformed: true, problem: 'N/A is opinion-only, not valid for verifier' }
  }

  const hasBlocking = findings.some((f) => f && f.severity === 'BLOCKING')
  if (verdict === 'FAIL' && !hasBlocking) {
    return { malformed: true, problem: 'FAIL verdict with no BLOCKING finding' }
  }
  if (hasBlocking && verdict !== 'FAIL') {
    return { malformed: true, problem: 'BLOCKING finding present but verdict is not FAIL' }
  }

  if (verdict === 'N/A' || verdict === 'UNVERIFIED') {
    if (score !== null && score !== undefined) {
      return { malformed: true, problem: `score must be null when verdict is ${verdict}` }
    }
  } else {
    // PASS or FAIL — a scored verdict, but only for opinion gates.
    if (isOpinion) {
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
        return { malformed: true, problem: `score must be an integer 1-5 for verdict ${verdict}` }
      }
    }
  }

  if (verdict === 'N/A') {
    if (typeof na_reason !== 'string' || na_reason.trim() === '') {
      return { malformed: true, problem: 'na_reason is required and non-empty when verdict is N/A' }
    }
  } else if (na_reason !== null && na_reason !== undefined) {
    return { malformed: true, problem: 'na_reason must be null unless verdict is N/A' }
  }

  return { malformed: false }
}
