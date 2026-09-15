---
title: "Gate evidence proves a green run happened, not that it happened for this diff"
document_type: ticket
status: completed
created: 2026-09-14
task_class: test-infrastructure
governing_docs: [docs/governance/standards/WORK_RECORD_STANDARD.md, docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md]
archive_when: a GateReport whose evidence_ref points at a run from a different commit is rejected rather than accepted, and the check is exercised by a test
---

# T169 — Gate evidence is not bound to the commit it verifies

Red Hat, reviewing `44b49c6..76d91fb`, named this as a gap it could not close within that
change's scope and asked that Grader be told it is still open.

`buildVerifierReport({ text, evidenceRef })` takes only the results text and a path. Nothing ties
either to the commit under review — no SHA, no tree hash, no content addressing. So a stale but
legitimately green `docs/work/runs/evidence/*.txt` from an earlier, unrelated commit can be cited
as the `evidence_ref` for a later, broken one, and it validates cleanly through
`validatePerGateReport` and the reducer.

**`evidence_ref` existing and parsing green proves a green run happened at some point. It does
not prove it happened for this diff.** That is a weaker claim than the artifact appears to make,
and the gap is silent: nothing in the reducer, the schema, or the governance checker catches it.

This matters more as filing gets automated. The whole direction of T167 is to make producing a
GateReport cheap enough that nobody skips it — and the cheaper it gets, the more the artifact is
trusted without being read, which is exactly when an unbound reference stops being theoretical.

## Shape of the fix

Have the gate runner stamp the results file with the SHA it ran against (`git rev-parse HEAD` at
the moment the run starts, plus whether the tree was dirty), and have `buildVerifierReport` refuse
— or downgrade to `UNVERIFIED` — when that stamp does not match the commit the report is for. A
dirty tree should be recorded as dirty rather than silently passing, for the same reason: the
evidence would describe a tree that no longer exists anywhere.

Note the ordering constraint this project keeps re-learning: the stamp must be written when the
run **starts**, not when it finishes, or a run that begins on one commit and is read after a
rebase will claim the wrong one — "started is not succeeded" in its other form, where the
identity rather than the outcome is the thing that drifts.

## Also still open, from the same review

A `mkdir` lock in `_consolidation/mineFromPacket.sh` left behind by `kill -9` blocks recovery for
that day indefinitely. The skip message names the lock path so a human can remove it, but nothing
expires it and nothing says how. Small, and it belongs with T168's testing work rather than here.

## Shipped 2026-09-14

`buildVerifierReport({ text, evidenceRef, expectedSha })` now binds the evidence to a commit, and
`parseGateStamp()` reads the `# gate run against <sha> dirty=<n>` line the runner writes at run
start. Three ways the binding can fail, all downgrading to `UNVERIFIED` with a BLOCKING finding
that names the problem:

- **mismatch** — the results file was produced against a different commit, so it does not verify
  this diff. This is the ticket's own acceptance criterion and is tested directly.
- **unbound** — a `expectedSha` was supplied but the file carries no stamp. Unbound is not
  verified; it is not allowed to read as a pass just because nothing contradicts it.
- **dirty** — the run was made against a tree with uncommitted files. That tree exists in no
  commit, so the run verified something unreproducible. Checked even when no `expectedSha` is
  supplied, because it is a defect regardless of what the report is for.

A genuine `FAIL` outranks all three: a failed run is never softened into "we cannot tell" by a
binding problem. 21 tests in `scripts/verifierReport.test.js`.

The gate runner moved into the repo as `scripts/gate.sh` (`npm run gate`) so the stamping is
version-controlled rather than living in a scratch file. It writes the SHA when the run **starts**
— not when it finishes — because a run that begins on one commit and is read after a rebase would
otherwise claim the wrong one.

### Known limitation, found by testing this against the real merged artifact

**The stamp binds to the branch commit that was gated, not to the commit that lands on `main`.**
PR #404 was squash-merged: the evidence file is stamped `55c3782` (the branch HEAD the gate
actually ran against) while `main` carries `f3c5c16`. Binding that file to `f3c5c16` correctly
returns `UNVERIFIED`; binding it to `55c3782` returns `PASS`.

That is the honest answer rather than a bug — the gate did run against `55c3782` and did not run
against `f3c5c16` — but it constrains how the check is usable: **verify the binding before
merging, against the branch HEAD.** After a squash merge no evidence file can ever bind to the
resulting commit, because that commit did not exist when the gate ran. Closing the remaining gap
would mean either merge commits instead of squashes, or a post-merge re-gate, and neither is worth
it for what it buys. Recorded so the next reader does not mistake the limitation for a defect.
