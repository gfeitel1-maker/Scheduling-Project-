---
title: "Gate evidence proves a green run happened, not that it happened for this diff"
document_type: ticket
status: open
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
