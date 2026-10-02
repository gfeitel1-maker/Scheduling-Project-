---
task: Nested discard is depth-aware — an inner-frame discardDeferredDocWrites drops only its own frame's queued doc-writes instead of leaking them to the outer commit (board i-nested-discard-leaks-queued-doc-writes)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [governor, maker, verifier, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: the board ruled the fix shape (marks stack); no new or changed contract, IPC, wire message, or stored schema — the deferred-write accounting is an existing in-process primitive being hardened.
  - agent: designer
    reason: not-applicable
    note: no UI surface — an in-memory frame-accounting data-structure change in the sync layer.
  - agent: tester
    reason: not-applicable
    note: no render cycle or user-observable behavior change; the defect is latent (no production runAtomic nests another today) and reachable only by a future nested caller.
  - agent: security
    reason: not-applicable
    note: no auth/secret/PIN/LAN-protocol/IPC/packaging surface; pure in-process data-structure logic. The one adversarial concern (a RangeError from marks/depth desync) was audited by Red Hat and proved unreachable.
deterministic_checks: [electron/sync/automerge/liveDoc.test.js, electron/sync/automerge/deferredDiscardNesting.test.js, npm run test:integration, npm run lint, npm run check:governance]
human_gates: []
archive_when: superseded when a production runAtomic body begins nesting another runAtomic and an integration scenario exercises nested-frame discard end-to-end, or when the deferred-doc-write buffer is replaced
---

# Run record — nested discard frame accounting

- **Board item:** `i-nested-discard-leaks-queued-doc-writes`
- **Branch:** `claude/board-nested-discard-frame-accounting` (off `main`, base #721 `73574fae`)
- **Schema change:** none — in-memory sync-layer buffer accounting only.

## The defect
`electron/sync/automerge/liveDoc.js` buffered deferred Automerge doc-writes in a flat
`state = { depth, queue }`. `discardDeferredDocWrites` only cleared the queue when `depth` reached 0
after its decrement; an inner-frame discard (depth still > 0) returned without touching the queue, so
the inner frame's queued writes survived to the outer commit's flush. Latent today — no production
`runAtomic` body nests another — but the just-shipped atomic-import primitive
(`electron/ops/importSetupRows.js`, #714) is exactly the kind of multi-write boundary a future caller
might nest, so the frame accounting was hardened ahead of a nested caller.

## What landed
`electron/sync/automerge/liveDoc.js`: deferred-write state carries a `marks` stack
(`{ depth, queue, marks }`). `beginDeferredDocWrites` pushes `queue.length`; `commitDeferredDocWrites`
and `discardDeferredDocWrites` pop a mark after decrementing depth; discard truncates
`state.queue.length = mark` **even at depth > 0**, so an inner discard drops exactly its own frame's
items (and any sub-frame items committed up into it). Only the outermost commit flushes; an inner
commit keeps its items in the queue for the outer frame. The existing `depth === 0` guards and the
`resetForTests` WeakMap reset are preserved, keeping the invariant `marks.length === depth` on every
path.

## Evidence
- **Test-first, red→green:** the pinned KNOWN-GAP test `deferredDiscardNesting.knowngap.test.js` was
  flipped to assert the correct behavior (inner write ABSENT, outer write survives) and renamed to
  `deferredDiscardNesting.test.js`. Governor independently reproduced RED against the committed
  pre-fix `liveDoc.js` (exactly the 2 leak cases failed — `B-write` and `W3` surviving the inner
  discard) and GREEN after the fix, with the fixed file verified byte-for-byte by md5.
- **Sibling cases** proving the marks stack: inner commit (both survive), outer discard (neither
  survives), discard at depth 0 (no-op), three-level nest (inner discard drops only the innermost),
  and enqueue-after-discard (a write into the still-open outer frame after an inner discard lands;
  the discarded inner write does not) — the case a future `.slice()`-style simplification would break.
- **Red Hat** (required adversarial audit): proved `marks.length === depth` holds on every path; the
  feared `RangeError` from a marks/depth desync is unreachable; confirmed inner-commit-keeps-items,
  in-place truncation has no stale-array aliasing, and `resetForTests` yields fresh `marks: []`.
- **Verifier:** liveDoc + nested-discard vitest green; `npm run test:integration` 28/28 libp2p sync
  scenarios; `npm run lint` clean on changed files; `npm run check:governance` exit 0.
- **Code Reviewer:** implementation matches the board-ruled mechanism exactly; surgical; the test
  rename is a genuine assertion flip, not a weakening.

## Follow-ups addressed in this round
Two converging MEDIUM findings (Red Hat + Code Reviewer) were fixed, not deferred:
- `electron/ops/importSetupRows.js` — a stale comment described the now-fixed nested-discard hazard as
  a live reason to avoid nesting; rewritten to state the hazard is fixed while keeping the (still
  true) note that this importer opens no nested frame.
- Added the enqueue-after-discard regression test (above).

## Provenance note
Governor dispatched Maker, Verifier, Red Hat, Code Reviewer, and Grader as foreground Agent calls in
this session and relayed their verbatim outputs. The GateReport reducer's automated provenance binding
could not be established (no session transcript available to the Grader); the deterministic spine
(Verifier gates, reproducible by exit code) was independently reproduced by the Governor, and the
limitation is disclosed per the GateReport spec §7. It did not affect the content verdict.
