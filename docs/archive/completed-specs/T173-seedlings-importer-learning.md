> **ARCHIVED — historical record, not current authority.**
> Ticket preserved from two deleted branches; it never existed on `main`. Not current work.
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

<!-- doc-refs:historical -->
> **Archived 2026-09-18 by the post-ship cleanup audit.**
>
> This document and the T173 ticket below it existed ONLY on two unmerged branches
> (`claude/T173-seedlings-importer-learning`, `claude/T173-seedlings-importer-learning-slice2`),
> which were deleted. Neither is current instruction. They are preserved here so the work is
> re-cuttable, because deleting the branches would otherwise have erased the ticket entirely.
>
> **Slice 1 SHIPPED** and is on `main` (PR #418) — `src/ingest/decisionJournal.js`,
> `electron/ops/decisionJournal.js`, and the `journalEntriesFor` wiring in
> `src/screens/ReconciliationScreen.jsx`. The branch copies were byte-identical to what merged.
>
> **Slices 2–4 were never built, and their premise is now known to be wrong.** The owner asked for
> a real import so they could be designed on journal evidence. Eight real camp workbooks were driven
> through the real ingest path and produced **zero journal rows** — see
> `docs/work/evidence/2026-09-15-real-import-journal-probe.md` (PR #434). The reconciler classified
> the entire corpus as already-understood, so the importer never asked anything. A learning layer on
> top of decisions that are never surfaced has nothing to learn from.
>
> **The redirected next slice** — what a future T173 should actually be cut as — is the gap that
> probe surfaced instead: a typo'd re-import (`Music` → `Musik`) silently creates a duplicate and
> asks nothing. The app already decides silently, and a wrong silent decision is indistinguishable
> from a right one. Design input is #434, not the spec below.
>
> Do not rebase the deleted branches if they are ever recovered: both independently minted schema
> migrations v62–v64 for device-side journal/failure tables, and `main` converged on a *different*
> consolidated shape (one `projection_failures` table, not three). Re-authoring against the shipped
> schema is the correct path, not conflict resolution.
<!-- /doc-refs:historical -->


# T173 — Seedlings

Design: `docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md`.

Owner ask, 2026-09-15: the importer should stop needing a human for obvious
cases, by learning from confirmed decisions. Posture chosen: **pre-answer, never
unasked** — it still shows everything it concluded, pre-filled and grouped, so
the director scans and corrects instead of being interrogated.

## Slices

1. **Journal** — record every decision presented and what happened to it. Ships
   dark; changes nothing visible. Makes slice 3 designable on evidence.
2. **DEFERRED pending journal data** — *"you could've worked it out"*. Premise
   checked while building and found mostly wrong: `reconciliationReport.js`'s
   `HIGH_IDENTITY_TIERS` (`new`, `exact_name`, `uuid`, `confirmed_alias`) already
   returns `outcome: 'understood', decision: null` — an exact name match does not
   ask. What remains must be uncertain-tier cases the camp's data settles anyway,
   and there is no evidence yet about what those are.
3. **DEFERRED pending journal data** — the seedling MODEL is settled (store, sow,
   recall, retirement, the three invariants); which kind to teach first is an
   evidence question.
4. **DEFERRED pending journal data.**
5. **Vocabulary thickening** — independent of the journal; may be done any time.

## The three invariants

1. Learning may only promote a decision held for **uncertainty**, never one held
   for **authority** (`all_camp_override`, `elective_candidate`).
2. Two consecutive overrides retire a seedling and the question comes back — two
   corrections in a row means the key is too coarse.
3. Recall can only fail toward **asking**, never toward a wrong answer.

## Closes T157

Not because a sixth mechanism appeared, but because T157's second trigger fired:
a capability was wanted that requires the shared abstraction. The five existing
mechanisms are deliberately left alone.
