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

/**
 * The run's self-identification: `# gate run against <sha> dirty=<n>`, written by the gate runner
 * when the run STARTS. Start, not finish — a run that begins on one commit and is read after a
 * rebase would otherwise claim the wrong one, which is this project's recurring defect wearing
 * yet another hat: the identity drifting rather than the outcome.
 *
 * @returns {{sha: string, dirty: number}|null} null when the file carries no stamp.
 */
export function parseGateStamp(text) {
  for (const line of toLines(text)) {
    const m = /^#\s*gate run against\s+([0-9a-f]{7,40})\s+dirty=(\d+)(?:\s+chunks=(\d+))?\s*$/i.exec(line.trim())
    if (m) {
      return {
        sha: m[1].toLowerCase(),
        dirty: Number(m[2]),
        // How many test chunks the run INTENDED to execute. Absent on evidence written before
        // this existed, in which case completeness cannot be checked and is not claimed.
        chunks: m[3] === undefined ? null : Number(m[3]),
      }
    }
  }
  return null
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
 * @param {string} [input.expectedSha] - the commit this report is FOR. Supply it and the run
 *   must prove it verified that commit; omit it and the report is explicitly unbound (T169).
 * @returns {object} PerGateReport
 */
export function buildVerifierReport({ text, evidenceRef, expectedSha }) {
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

  // T169. A green results file proves a green run happened at SOME point; only the stamp ties it
  // to THIS commit. Unbound, mismatched, or run against a dirty tree all mean the same thing —
  // we do not know that this diff was verified — so they downgrade to UNVERIFIED rather than
  // being allowed to read as a pass.
  const stamp = parseGateStamp(text)
  const bindingProblems = []
  if (expectedSha) {
    if (!stamp) {
      bindingProblems.push(`results file carries no commit stamp, so it cannot be bound to ${expectedSha.slice(0, 12)}`)
    } else if (!stamp.sha.startsWith(expectedSha.toLowerCase()) && !expectedSha.toLowerCase().startsWith(stamp.sha)) {
      bindingProblems.push(
        `results file was produced against a different commit (${stamp.sha.slice(0, 12)}), not ${expectedSha.slice(0, 12)} — it does not verify this diff`,
      )
    }
  }
  // Red Hat, 2026-09-15: lint + integration + security + governance alone satisfy "some steps ran
  // and DONE is terminal", so a run that executed ZERO unit tests reported PASS. gate.sh's header
  // told the reader to "check the chunk totals sum to a whole-suite count" — a rule the file
  // stated and nothing enforced. The stamp now declares the intended chunk count and this checks
  // it, which is that manual step automated.
  if (stamp && stamp.chunks !== null) {
    const ran = steps.filter((s) => /^tests-\d+$/.test(s.name)).length
    if (ran !== stamp.chunks) {
      bindingProblems.push(
        `run declared ${stamp.chunks} test chunk(s) but ${ran} executed — the results file does not match its own header`,
      )
    }
  }
  if (stamp && stamp.dirty > 0) {
    bindingProblems.push(`run was made against a dirty tree (${stamp.dirty} uncommitted file(s)) — that tree exists in no commit`)
  }

  let verdict
  // A real failure is never softened into "we cannot tell": FAIL outranks a binding problem.
  if (failed.length > 0) verdict = 'FAIL'
  else if (steps.length === 0 || !complete) verdict = 'UNVERIFIED'
  else if (bindingProblems.length > 0) verdict = 'UNVERIFIED'
  else verdict = 'PASS'

  return {
    gate_name: 'verifier',
    verdict,
    score: null,
    findings: [
      ...failed.map((s) => ({
        severity: 'BLOCKING',
        ref: s.name,
        summary: `gate step "${s.name}" exited ${s.rc}${s.summary ? ` — ${s.summary}` : ''}`,
      })),
      // HIGH, not BLOCKING. gateReportSchema.js rejects a BLOCKING finding unless the verdict
      // is FAIL, and a binding problem is not a failure — it is "we cannot tell whether this
      // passed", which is UNVERIFIED. Marking it BLOCKING made the whole report MALFORMED, so
      // the reducer reached BLOCK by accident and discarded the explanation. UNVERIFIED already
      // forces BLOCK through §5.2, so the verdict does the blocking and the finding explains it.
      ...bindingProblems.map((problem) => ({
        severity: 'HIGH',
        ref: evidenceRef ?? 'evidence',
        summary: `evidence binding: ${problem}`,
      })),
    ],
    evidence_ref: evidenceRef,
  }
}
