// Deterministic Verifier PerGateReport, built from a batched gate's own results file.
//
// Why this exists (T167). Session transcripts show the review agents genuinely running —
// code-reviewer 23, verifier 21, red_hat 16 — against grader 3. The reviewers report; almost
// nobody transcribes those reports into a GateReport, so 283 commits landed between 2026-08-25
// and 2026-09-14 with zero run records. The skipped step is clerical, and it is the step that
// produces the durable artifact.
//
// Verifier's half of that transcription needs no judgement at all: its verdict is a function of
// exit codes. This module computes it, so the expensive part of filing shrinks to the four
// opinion gates. Pure — no I/O, no clock — so it tests without spawning anything.
//
// Output is a PerGateReport per docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md §3,
// consumable directly by scripts/gateReportCli.js. Verifier carries no score by contract
// (gateReportSchema.js: "verifier must not carry a score") — it executes, it does not opine.

/** Normalise line endings once, so every consumer sees the same shape. A trailing \r defeats
 *  an unanchored `$`, which silently produced ZERO parsed steps on a CRLF results file — and
 *  zero steps with no failures is one `DONE` away from reading as a pass. */
export function toLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
}

/** One `STEP <name> | rc=<n> | <summary>` line per gate step. */
export function parseGateResults(text) {
  if (!text) return []
  const out = []
  for (const line of toLines(text)) {
    const m = /^STEP\s+(\S+)\s*\|\s*rc=(\d+)\s*\|(.*)$/.exec(line)
    if (m) out.push({ name: m[1], rc: Number(m[2]), summary: m[3].trim() })
  }
  return out
}

/**
 * @param {object} input
 * @param {string} input.text - contents of the gate results file
 * @param {string|null} input.evidenceRef - repo-relative path to that file; the reducer
 *   rejects a verifier report without one, deliberately: a deterministic verdict with no
 *   artifact behind it is exactly the unfalsifiable claim this whole program exists to stop.
 * @returns {object} PerGateReport
 */
export function buildVerifierReport({ text, evidenceRef }) {
  const steps = parseGateResults(text)
  const failed = steps.filter((s) => s.rc !== 0)

  // A run that produced no steps, or that stopped before writing DONE, did not establish a
  // pass — it established nothing. Reporting that as PASS would be the same defect this work
  // was written to close ("started" read as "succeeded"), reappearing in the evidence layer.
  // A failure already observed is still a failure: truncation cannot launder it into UNVERIFIED.
  // DONE must be the LAST non-blank line — not merely present somewhere. Red Hat found that a
  // bare "DONE" in captured step output (build tools print it as a stage marker) let a run that
  // died after step 1 report PASS, because nothing tied the marker to the end of the run. The
  // marker means "the harness reached the end", and only a terminal marker can mean that.
  const lines = toLines(text).filter((l) => l.trim() !== '')
  const complete = lines.length > 0 && lines[lines.length - 1].trim() === 'DONE'
  let verdict
  if (failed.length > 0) verdict = 'FAIL'
  else if (steps.length === 0 || !complete) verdict = 'UNVERIFIED'
  else verdict = 'PASS'

  return {
    gate_name: 'verifier',
    verdict,
    score: null,
    findings: failed.map((s) => ({
      severity: 'BLOCKING',
      ref: s.name,
      summary: `gate step "${s.name}" exited ${s.rc}${s.summary ? ` — ${s.summary}` : ''}`,
    })),
    evidence_ref: evidenceRef,
  }
}
