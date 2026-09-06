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

## Known limits / deliberate scope boundaries (feed the PR description)
- The projector **hardcodes** `days_of_operation`'s `ensureExists` SQL (copied from `projections.js`). `STAGE1_FIELDS` is drift-guarded; the ensureExists SQL is **not** — a Stage-5 generalization (drive columns from `PROJECTIONS`) removes this.
- The projector does **not** replicate `applyProjection`'s `camp_id` guard (rejects `camp_id != device camp`). Under Automerge the doc is authoritative; this is a **Stage-2 rules-layer** item, not a Stage-1 bug — see the ADR's rules-layer section.
- `projectEntity`'s delete-reconcile can drop a `days_of_operation` row that `anchor_activities`/`day_overrides` reference by convention (no DB FK). Silent-orphaning is exactly the class the ADR's rules layer (Stage 2) must own (`buildSchedule.js:326-339`: null/dangling location = unconstrained). **Not wired to any live delete path in Stage 1.**
- Stage 1 proves parity via tests rather than wiring a live flag-gated shadow path. Live-path wiring (touching `electron/main.js`'s write handler) is intentionally NOT done autonomously — it is the next slice and wants owner presence / a dedicated review.

## Next stages (from the ADR, skeleton)
- **Stage 1b (optional):** flag-gated shadow projection in the live write path (default OFF) to prove parity in the running app.
- **Stage 2:** the rules/validation layer above Automerge (referrer completeness, capacity/contention, approval gate, host-only exclusion, ingest atomicity) — the load-bearing new work.
- **Stage 3:** host-only-table structural exclusion (never modeled as doc fields).
- **Stage 4:** libp2p transport, LAN-only first.
- **Stage 5:** widen projector to all camp-scoped entities + membership/identity over libp2p peer keys.
- **Stage 6:** cutover (retire operations/conflicts + WS sync). **Stage 7:** WAN (DHT/dcutr).

## Coordination
Peers informed: `shoresh-54` (holding T120; off electron/sync|ops|db on shared main), `priceless-rubin` (IPC appmap; confirmed seam: single `window.shoresh` chokepoint in `src/localClient.js`, 36 importers). This branch is isolated; the shared main checkout is untouched.
