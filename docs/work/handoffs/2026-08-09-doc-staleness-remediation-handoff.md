---
task: Documentation staleness remediation
document_type: handoff
status: active
created: 2026-08-09
archive_when: remediation branch merged
date: 2026-08-09
audience: Governor + dynamic agent workflow loop
repo_tip_at_audit: 89e708a
schema_version_at_audit: 29
---

# Handoff: Reference-doc staleness remediation

## Product goal (owner's words)

The reference documents agents consult — ADRs, ticket closures, INDEX, PLATFORM_STATE
— have drifted out of sync with the project's real data model and current state.
Agents are treating shipped work as unbuilt. Fix the stale artifacts, and change the
process so this stops recurring.

## Observable success predicate

An agent reading ONLY the reference docs would reach the same conclusions as an agent
reading the code + git. Concretely, all of the following hold:

1. No ADR or ticket for work merged to `main` still says `proposed` / `not_started` / `open`.
2. `docs/current/PLATFORM_STATE.md` states schema **v29**, lists the reconciliation/onboarding
   screens and tables, and names the real landing screen.
3. `docs/work/INDEX.md` regenerates clean (`npm run index:work`) and lists every ticket + ADR
   on disk with a status matching its source frontmatter.
4. No two tracking docs contradict each other on the same ticket's open/closed status.
5. All existing verification gates still pass (this is docs-only; nothing should break tests).

## Non-goals

- Do **not** change any code, schema, or migration. This is a documentation-fidelity task.
- Do **not** rewrite ADR *decisions* or their technical bodies — only their status/state metadata
  and the handful of factual claims listed below.
- Do **not** delete historical run records or handoffs; mark stale ones, don't erase history.

## Ground truth (verified 2026-08-09, tip 89e708a)

- Authoritative data model = `electron/db/localDb.js` migrations. `CURRENT_SCHEMA_VERSION = 29`
  (localDb.js:16). `schema.sql` is base-only and is well-maintained — trust it.
- **Important, reassuring finding:** the actual data-model *shapes* in the docs are correct.
  The ADR audit found **zero** cases of an ADR describing a wrong table/column shape.
  Every defect below is **status/state metadata**, not substance. This is a bookkeeping
  fix, not an architecture fix — keep it surgical.
- Merged reconciliation/onboarding program: S1a, S2a, S2b, S2c, S4a, S4b, S5a, S5b, and
  tickets T72, T73, T74, T75. Live screens: `ReadinessHub.jsx` (default landing),
  `ImportScreen.jsx`, `ReconciliationLedger.jsx`. `CampSetup.jsx` does not exist.

## Deterministic fix inventory

Group these into ticket-sized batches. Each item is verifiable against a commit or a file.

### Batch A — ADR status metadata (13 files, docs/adr/)
Set `status: accepted` + `implementation_state: implemented`, and reconcile any divergent
in-body `**Status:**` line, on the merged ADRs:
1. `2026-08-08-s2a-field-provenance-and-hand-edit-protection.md` — shipped as schema v29 (`operations.source`).
2. `2026-08-08-s4-enrichment-workbook-round-trip.md` — merged 048630e (S4a) + 2c26efc (S4b).
3. `2026-08-08-s2c-activity-and-group-field-update.md` — merged 7f0c478.
4. `2026-08-08-s5-readiness-six-state-model.md` — ReadinessHub shipped (83176dc, 89e708a).
5. `2026-08-08-t73-held-import-resolution-recommit.md` — merged (T73).
6. `2026-08-08-s2b-field-level-update-and-stale-conflict.md` — merged.
7. `2026-08-08-t72-fixed-event-reimport-idempotency.md` — merged e5af7d2.
8. `2026-08-08-reconciliation-plan-as-commit-input.md` — S0 seam, live (all consumers merged).
9. `2026-08-08-export-formula-injection-sanitizer.md` — shipped with S4a (`src/utils/exportSanitize.js`).
10. `2026-07-25-append-only-audit-event-log.md` — frontmatter `accepted` vs body `proposed`; implemented.
11. `2026-07-25-device-trust-revocation.md` — frontmatter/body Status mismatch; implemented. **Also:**
    fix dead path on line ~21 → `docs/superpowers/specs/...` no longer exists.
12. `2026-07-28-schedule-flag-findings-reshape.md` — frontmatter/body mismatch; implemented (v10).
13. `2026-08-06-schedule-canvas-visual-layer.md` — set `implementation_state: implemented`; the CSS-grid
    canvas shipped (T50 + T53–T60; `src/screens/schedule/gridTracks.js`, `dragFSM.js`, `GridDragSurface.jsx`).

Correct-as-is (do NOT touch): `s1a-...` (accepted/merged) and `s1b-source-aliases.md`
(genuinely NOT built — `source_aliases` table does not exist; leave `proposed`).

### Batch B — ticket frontmatter (docs/work/tickets/)
1. `T72-...md` — `status: open` → merged (e5af7d2).
2. `T73-...md` — `status: open` → merged (acddd3b).
3. `T74-...md` — `status: open` → merged (a5af872).
4. `T70-dev-only-shape-assertion-...md` — collided on number with
   `T70-sync-test-sleep-marker-laundering`. **Resolved by renumbering to
   `T78-dev-only-shape-assertion-...md`**, per the status-drift ADR precedent, so the two no longer
   share ID T70. Still open: whether T78 is a duplicate of shipped **T71** (7613216) and should be
   retired (mark superseded-by-T71) rather than kept as a distinct ticket — a product decision left
   for the owner.
5. Normalize `T75` `status: done` → the standard enum (`completed`/`closed`) used elsewhere.

### Batch C — regenerate + reconcile INDEX
- `docs/work/INDEX.md` is a full program behind HEAD (regenerated at 7613216). It omits T72–T75
  and all eleven `2026-08-08-*` ADRs, and contradicts T44 (`open` in INDEX vs `completed` frontmatter,
  059141c) and T70-sync-test (`open` vs `completed`, 05f3548).
- **Order matters:** fix Batch A + B frontmatter FIRST (INDEX is generated from it), then run
  `npm run index:work`, then diff to confirm the contradictions are gone.

### Batch D — PLATFORM_STATE.md (docs/current/)
1. Schema version: says v20/v23 in three places (lines ~125, ~138, ~142) → **v29**.
2. Add the reconciliation/onboarding program (ImportScreen, ReadinessHub, ReconciliationLedger; S1a–S5b).
3. Landing screen: lines ~100/~199 claim `setup` → `CampSetup.jsx` (does not exist). Real default is
   `readiness` → `ReadinessHub.jsx` (App.jsx:68); setup entity screen is `camp` → `CampScreen.jsx`.
4. Screens table missing `readiness`, `import`, `trash`, and `schedule:manual`/`schedule:generated` keys.
5. Tables section missing v26–v29 additions: `schedule_weeks`, `schedule_templates.week_id`,
   `week_activity_exclusions`, `week_group_exclusions`, `operations.source`.

### Batch E — stale handoff
- `docs/work/handoffs/T50-schedule-canvas-handoff.md` frames the (now shipped) canvas rebuild as open
  exploration. Add a header marking it CLOSED/superseded so it isn't read as the live next step.
- `README.md` / `CLAUDE.md`: minor lag only (test-count figure; device-phase list omits
  `pairing_pending`/`pairing_denied`). Low priority; fix opportunistically.

## Root cause + recommendations going forward

The defect is **structural, not clerical**: ticket/ADR status lives in per-file frontmatter that a
merge does not touch, and `INDEX.md` is a downstream generated view. When a slice merges, nothing
flips its source status, so every reader sees `proposed`. Recommend the loop propose (as a separate
follow-up, not part of this fix):

1. **Merge-time status flip is part of "done."** A ticket/ADR is not closed until its frontmatter
   `status`/`implementation_state` is updated in the SAME PR that merges the code. Add this to the
   WORK_RECORD_STANDARD and the Verifier/Code-Reviewer checklist.
2. **A CI/gate check for status drift** — a script that fails if a ticket referenced by a merged
   commit (`closes T##` / `Merge S##`) still reads `open`/`proposed`/`not_started`, and if
   `INDEX.md` is out of date vs `npm run index:work`. Deterministic, cheap, catches exactly this class.
3. **One source of truth for state.** PLATFORM_STATE should cite `CURRENT_SCHEMA_VERSION` and the
   SCREENS map by reference/generation rather than restating numbers that go stale. Consider adding
   PLATFORM_STATE regeneration (the `/update-state` skill) to the definition of done for structural PRs.

## Suggested routing

- **Maker** executes Batches A–E (mechanical, test-first not applicable — these are docs; verify by
  re-reading source/git per item).
- **Verifier** runs the full gate suite to confirm docs-only changes broke nothing, and runs
  `npm run index:work` + `git diff --exit-code docs/work/INDEX.md` as the deterministic INDEX gate.
- **Architect** owns the three "going forward" recommendations as a follow-up ADR
  (merge-time status contract + drift gate).
- **Governor** sequences A→B→C (C depends on A+B), D and E in parallel, then the follow-up ADR.

## Evidence
Audit performed 2026-08-09 against tip 89e708a by three independent read-only passes
(state docs, ADRs, ticket/work tracking). Every claim above was verified against the live
schema, migration code, and git log before inclusion. No Category-A data-model-shape drift
was found in any doc.
