# Handoff — Automerge + libp2p productionization, Stage 1

**Date:** 2026-09-06
**Branch:** `claude/productionize-automerge-stage1` (worktree `.claude/worktrees/automerge-stage1`, off `origin/main@8bf3a33`)
**Authority:** [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md](../../adr/2026-09-06-productionize-automerge-libp2p-sync.md) (accepted)
**Owner status:** stepped away; delegated decisions to the Governor session for this build. Standing line: finish Stage 1 to a reviewed PR, but **do NOT merge to main** (trunk stays human).

## Decision recap (owner, 2026-09-06)
- Route: **Automerge (data/merge/conflict) + libp2p (transport/discovery/NAT)**, SQLite = rebuildable projection.
- Host stays a **privileged signing role**. Migration = **hard cutover** (no dual-write; simultaneous editing is guaranteed by Automerge either way). Transport = **LAN-first, then WAN** (pair on same network, then travel).
- **T120 history rewrite is DEFERRED** until after productionization (owner's call). `shoresh-54` is holding it and will warn before running; filter-repo across all refs means this branch gets rewritten too and stays mergeable (commit hashes will change — expected, not data loss).

## Stage 0 (done) — de-risk before code
`experiments/future-arch/cr-sqlite-libp2p/test-atomicity.mjs` (on the future-arch branch): 12/12. Automerge `change()`+throw gives ingest's atomic all-or-nothing rollback for free (byte-identical doc on abort); stage-then-commit fallback also proven. So `ingest.js`'s atomicity guarantee (`ingest.js:1038-1042`) has a proven path.

## Stage 1 (this branch) — Automerge doc + SQLite projector for ONE entity
Entity chosen: **`days_of_operation`** (cleanest leaf: 5 scalar cols, no cohort FK; note the name column is `label`, not `name`).

Delivered (commit `58cf71a`), pure + additive, **nothing in the live app imports it**:
- `electron/automerge/campDocument.js` — Automerge doc for one entity; op-shaped `applyWrite` (DELETE_FIELD sentinel, `coerceOpValue`), mirrors `applyProjection` semantics. `STAGE1_FIELDS` is drift-guarded against `PROJECTIONS.days_of_operation.fields`.
- `electron/automerge/projector.js` — `projectEntity` (ensureExists placeholder + per-field UPDATE + delete-reconcile) and `rebuildFromDoc` (SQLite is disposable).
- 16 tests, incl. the **load-bearing parity test**: the same write stream yields byte-identical `days_of_operation` rows via the op-log (`appendOp`→`applyProjection`) and via Automerge+projector.

Gate so far: Stage 1 tests 16/16; `electron/ipcSurfaceParity.test.js` 17/17 (seam untouched); lint clean on new files. Full-suite Verifier + Red Hat + Code Reviewer dispatched (results pending at time of writing).

## Independent review (2026-09-06) — Code Reviewer + Red Hat + Verifier
Round 1 (commit 58cf71a) found, and round 2 (this commit) resolved:
- **[CLOSED] camp_id parity gap + crash (HIGH, both reviewers).** The first projector re-implemented projection and did NOT replicate `applyProjection`'s camp_id tenant guard — a foreign `camp_id` both diverged from the op-log AND crashed on the FK. **Fix:** the projector now REUSES `applyProjection` (replays each doc field as a synthetic op), so the guard, ensureExists, and DELETE semantics are all inherited. Parity is now structural, not per-input. Tests added: foreign-camp_id no-crash + op-log parity.
- **[CLOSED] ensureExists SQL hand-copy drift (MEDIUM).** Gone — no longer hand-copied; the real `applyProjection`/`ensureExists` is reused.
- **[CLOSED] projectEntity not transactional (MEDIUM).** Now wrapped in `db.transaction()` — all-or-nothing, matching the op-log write paths.
- **[CLOSED] ADR citation 404 on this branch (MEDIUM).** The ADR + supporting design docs (ENGINE_SELECTION, PRODUCTIONIZATION_AUDIT, RULES_LAYER_SOURCES, HOLEPUNCH_RESEARCH, the Stage-0 spike) were brought onto this branch so every header citation resolves.
- **[CLOSED] coverage gaps (LOW).** Added: multi-entity save/load round-trip, and projecting a merged (conflict-resolved) document.

## Known limits / deliberate scope boundaries (feed the PR description)
- **rebuild-from-doc orphaning (HIGH, structural — Stage-2 requirement, NOT a Stage-1 bug).** `projectEntity`/`rebuildFromDoc` delete any SQLite row not in the document. That is safe only when the document is the authoritative superset. **Before this ever runs against a live camp's existing SQLite, a "seed the document from current SQLite" step must run first** — otherwise an empty/partial doc deletes real `days_of_operation` rows and silently orphans convention-only referrers (`anchor_activities.day_id`, `day_overrides`; no DB FK; `buildSchedule.js:326-339` treats a dangling ref as unconstrained). Documented in `projector.js`'s `rebuildFromDoc` docstring; must be a named deliverable of the Stage-2/cutover design. Nothing in Stage 1 wires this to live data.
- Stage 1 proves parity via tests rather than wiring a live flag-gated shadow path. Live-path wiring (touching `electron/main.js`'s write handler) is intentionally NOT done autonomously — it is the next slice and wants owner presence / a dedicated review.
- `@automerge/automerge` is added to `dependencies` (not devDependencies) ahead of the wiring stage — deliberate, to avoid a second dependency-bump PR; nothing in the shipped app imports it yet.

## Next stages (from the ADR, skeleton)
- **Stage 1b (optional):** flag-gated shadow projection in the live write path (default OFF) to prove parity in the running app.
- **Stage 2:** the rules/validation layer above Automerge (referrer completeness, capacity/contention, approval gate, host-only exclusion, ingest atomicity) — the load-bearing new work.
- **Stage 3:** host-only-table structural exclusion (never modeled as doc fields).
- **Stage 4:** libp2p transport, LAN-only first.
- **Stage 5:** widen projector to all camp-scoped entities + membership/identity over libp2p peer keys.
- **Stage 6:** cutover (retire operations/conflicts + WS sync). **Stage 7:** WAN (DHT/dcutr).

## Coordination
Peers informed: `shoresh-54` (holding T120; off electron/sync|ops|db on shared main), `priceless-rubin` (IPC appmap; confirmed seam: single `window.shoresh` chokepoint in `src/localClient.js`, 36 importers). This branch is isolated; the shared main checkout is untouched.
