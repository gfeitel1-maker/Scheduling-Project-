---
title: C1b-anchor-slot-drift-moved-signal
document_type: ticket
status: completed
created: 2026-08-10
governing_docs: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
related_adrs: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
archive_when: C1b lands on work/ingestion-reconciliation and the moved-signal is covered by ingest.slot-drift.test.js
---

# C1b — Fixed-event slot-identity drift → read-only MOVED signal (suppress duplicate)

- **Program:** Ingestion Reconciliation (Phase C, sibling of C1a)
- **ADR:** `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` — C1b paragraph added in the Phase C list beside C1a (no new ADR file; Architect concurred).
- **Branch:** `work/c1b-anchor-slot-drift` (isolated worktree), to merge into `work/ingestion-reconciliation`.
- **Severity:** HIGH (silent data corruption — duplicate anchors)
- **Origin:** Red Hat finding during B3 review. Pre-existing bug; not caused by B3.

## Success predicate (observable)

Given a live anchor that a director **moved** to a new day/time-block via AnchorsScreen (`saveAnchor`, `src/screens/AnchorsScreen.jsx:315`, mutates `day_id`/`time_block_id` on the same `entity_id`), re-importing the **original** source file (still showing the old slot):

- **MUST NOT** create a duplicate anchor at the old slot (current behavior: `created=1` duplicate).
- **MUST** surface the move as a read-only report item `outcome.fixedEvents.moved` (current: silent).
- **MUST NOT** write any op to the anchor row (no commit-path mutation this slice).

## Non-goals

- No actual anchor-move reconciliation (re-applying the move / offering to fix). That is the heavier future slice T72 flagged; explicitly **out of scope**.
- No change to `created`/`unchanged`/`skipped`/`partial`/`rejected` semantics, `anchorSlotKey`, `rejectedSlotKeys`, teardown, or any commit-path write. **ADD-only.**
- No group-scope (`is_all_groups`/`group_ids`) diffing in the MOVED item — that is C1a's territory and is deliberately excluded from anchor slot identity.

## Detection predicate (LOCKED — Red Hat)

A naïve "match by name at a different slot" is **unsafe**: names are not unique and per-day fan-out breaks 1:1 cardinality, so it can silently suppress a legitimate create (worse than the bug). The predicate is therefore a **set-cardinality pre-pass**, computed after the live-anchor scan and teardown, **not** an inline per-day check:

1. Partition both the incoming file slots and the live anchor rows by `(cohort_id, normalizeName(name))`. (Cohort is stable — `saveAnchor` edit never mutates `cohort_id`, confirmed at `AnchorsScreen.jsx:315` vs `:326`. So the drift dimension is exactly `(day_id, time_block_id)`.)
2. Within each group: `liveUnmatched = liveSlots − fileSlots`, `fileUnmatched = fileSlots − liveSlots` (set difference on `(day_id, time_block_id)`). **Exclude anything in `rejectedSlots` from `liveSlots`** — a human tombstone is never reinterpreted as a move source (preserves the "live wins over tombstone" invariant and the restore escape hatch).
3. **Only if `|liveUnmatched| === 1 && |fileUnmatched| === 1`:** report the single `fileUnmatched` slot as MOVED (`{ name, reason }`) and **suppress its create**.
4. **Every other cardinality** (`0:N`, `N:0`, `N:M` with N or M ≥ 2): do **not** guess. `fileUnmatched` slots fall through to the existing create path (T72 recognize-then-skip / `rejectedSlots` check unchanged); `liveUnmatched` rows are left untouched and unreported.
5. Predicate is a pure function of `(live anchor rows, file slots, rejectedSlots)` — no op timestamps/history beyond the existing `source==='human'` rejection check — so repeated identical imports re-derive the identical verdict (idempotent, must not oscillate `created↔moved`).
6. Replace mode: `liveSlots` is the post-teardown scan, so `liveUnmatched` is empty by construction → predicate is inert. Asserted explicitly.

## Report shape (LOCKED — Architect)

- New category `outcome.fixedEvents.moved` — array of `{ name, reason }`, matching the existing `skipped`/`partial` shape (`reason` a natural-language string, e.g. `moved from Monday/09:00 to Tuesday/10:00`). No structured `from`/`to` fields (no downstream consumer needs them; matches D5a's report-copy convention).
- **Named `moved`, not `changed`** — avoids colliding with C1's top-level CHANGED bucket that both this and D5a's group-scope drift will later feed into.
- Threaded to **both** return sites: `outcome.fixedEvents` and the held-branch literal (which hard-codes the category list and must stay shape-consistent — same obligation `rejected` had).
- **Mock parity in this slice:** mirrored at both `fixedEvents` return sites in `src/localClient.mock.js`.
- UI: render block for `result.fixedEvents?.moved` in `src/screens/ImportScreen.jsx`, copying the existing `skipped`/`partial` `${name} (${reason})` pattern.

## Test-first seam

`electron/ops/ingest.slot-drift.test.js` (modeled on `electron/ops/ingest.t72.test.js`). Core failing test: import MIFKAD, mutate one row's `day_id`/`time_block_id` via a direct human `appendOp` (simulating `saveAnchor`), re-import the original `fixedEvents`, assert **no duplicate anchor** at the old slot AND `fixedEvents.moved` populated. Red Hat's required matrix (all present):

1. Simple 1:1 move (time_block only) → MOVED, no create.
2. Simple 1:1 move (day changed) → MOVED, no create.
3. Two same-named events, both unchanged → 0 moved, 0 created (T72 two-a-day regression guard).
4. Two same-named, one moved one unchanged → exactly 1 MOVED, other unchanged, 0 created.
5. Genuine second occurrence added, cardinality 0:1 → CREATE, never MOVED.
6. Ambiguous N:M fan-out → NO guessed MOVED; unmatched file slots proceed to normal create.
7. Tombstone never reinterpreted as move source → REJECTED via `rejectedSlots`, not MOVED.
8. Replace-mode inert → clean create at original slot, 0 moved.
9. Idempotency: run case 2 twice → identical MOVED report, 0 created both runs.
10. Cohort-scoping guard: predicate partitions by cohort; must not pair across cohorts.
11. Group-scope changed alongside a valid 1:1 move → MOVED reason carries only day/time_block delta.

## Evidence (isolated worktree, rebased onto c594d27)

- Targeted gate green: `ingest.slot-drift.test.js` (11) + `ingest.t72.test.js` (7) = 18/18.
- Full suite: the only C1b-caused change was the additive `moved: []` field in `ingest.test.js:317`'s exact-shape assertion (fixed). Remaining full-suite failures (`ImportScreen.test.jsx` ×3, `test/governance.test.js` ×2) were proven pre-existing on `c594d27` (fail with C1b changes stashed / absent) — NOT introduced by this slice.

## Review loop

Maker (test-first) → Red Hat (predicate + regression) → Verifier (targeted + full suite) → Grader. Isolated on `work/c1b-anchor-slot-drift`; PR into `work/ingestion-reconciliation`.

## Resolution (2026-08-20, verified already-fixed — status was stale in-progress)

The set-cardinality MOVED pre-pass is fully implemented in `electron/ops/ingest.js` (liveUnmatched/
fileUnmatched, the `!== 1` cardinality guard, movedBySlot, rejectedSlots exclusion); mock parity in
`src/localClient.mock.js` (`moved: []`); pinned by `electron/ops/ingest.slot-drift.test.js`. The UI
render moved to `src/components/reconciliation/postImportBanner.jsx` (renders `fixedEvents.moved`) in
the one-workspace reconciliation rework. Both archive_when conditions met. Closed as already-fixed.
