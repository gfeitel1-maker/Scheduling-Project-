---
title: "gateReportCli writes a false gate report when it cannot verify its inputs"
document_type: ticket
status: completed
created: 2026-09-25
archive_when: archived once gateReportCli fails closed — when it cannot produce a VALID report (e.g. an opinion report whose dispatch provenance cannot be established because the session transcript is missing or unreachable), it writes NO file to disk and exits non-zero with a diagnostic naming the cause, and never emits a skeleton/placeholder GateReport a reader could mistake for a real verdict. Proven by scripts/gateReportCli.test.js driving the unbound-provenance path and asserting (a) no file is created and (b) a throw naming the unbound gate(s)
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
---

# T258 — gateReportCli emits a false gate report on provenance failure

## Why

Found 2026-09-23 during T226. `scripts/gateReportCli.js` had two defects.

**Defect (2) — fixed here.** When an opinion report (security / red_hat / tester / code_reviewer)
failed dispatch-provenance binding — because no `sessionTranscript` was supplied, or the transcript
showed no completed dispatch of the matching subagent — the CLI did not stop. It substituted an
`UNBOUND_NO_DISPATCH_EVIDENCE` sentinel report, passed it to `reduceGateReport` (which flagged it
malformed → BLOCK), then called `writeGateReport` and returned. The result was a committed-looking
`<taskId>-r<round>.json` recording `verifier_pass:false` / gates malformed / BLOCK — a verdict about
inputs the tool never actually verified. A reader, or a durable run record, mistakes that fabricated
skeleton for a real "the work failed the gates" result. **A committed false gate report is worse than
none.**

**Defect (1) — NOT fixed, deferred.** The CLI cannot run under a subagent at all: it needs
session-transcript provenance a subagent process cannot reach. This is not a 1–2 line change — a
subagent has no alternate provenance channel, and giving it one is a design effort. Deferred.
Useful synergy from the defect-(2) fix: a subagent that cannot reach the transcript now fails closed
(throws, writes nothing) instead of emitting a false artifact.

## What changed

A GateReport is a *verdict about the work* and is legitimately written even when it is BLOCK —
provided every claimed opinion gate's provenance was established and the reports are structurally
sound. It is INVALID and must not be written when the tool had to fabricate/substitute content
because it could not obtain or verify an input.

- `scripts/gateReportCli.js` — the provenance-binding loop no longer substitutes a sentinel for an
  unbound opinion report. It collects the unbound gate names and reasons and, if any are unbound,
  throws `CliUsageError` (naming every unbound gate and why) before `reduceGateReport` /
  `writeGateReport` are ever called. No file is written on this path. The top-level CLI wrapper's
  existing `catch` turns the throw into exit 1 + stderr.
- `scripts/gateReportCli.test.js` — the two T171 tests whose proven property changed ("THE
  ACCEPTANCE SCENARIO" and the incomplete-dispatch case) now assert a throw plus `existsSync(...)
  === false`, strengthening their anti-fabrication intent. Genuine written verdicts are unchanged:
  bound-and-passing → PASS_ELIGIBLE, and a verifier report derived from a results file for a
  different commit → written BLOCK.

### Reading chosen

Two readings of "cannot produce a valid report" existed. **Reading A (implemented):** only the
provenance-unreachable path (unbound opinion report) converts to throw + no-write; reducer-detected
`malformed` entries for structurally-broken *hand-written* reports remain a written BLOCK verdict.
**Reading B (rejected):** treat any reducer `malformed` entry as unwritable. A was chosen because
the owner's concrete false artifact is the provenance-unreachable skeleton, and B would suppress
legitimate "your report is structurally broken" verdicts that a reader should see.

## Evidence

`npx vitest run --no-file-parallelism scripts/gateReportCli.test.js`: red before the fix (2 failed
/ 13 passed — the new assertions failed because the old code returned a BLOCK result and wrote a
file instead of throwing), green after (15 / 15).
