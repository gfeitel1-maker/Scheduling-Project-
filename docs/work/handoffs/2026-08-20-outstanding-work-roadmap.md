---
task: "Roadmap/handoff of all outstanding Shoresh work (pre-existing, parked, deferred, shelved, in-flight) for a new Governor to triage"
document_type: handoff
status: active
created: 2026-08-20
archive_when: a new Governor has picked up this backlog and re-triaged it into their own working set
---

# Outstanding work roadmap — handoff to a new Governor

Written 2026-08-20, immediately after the **Roots-as-dashboard/spine** feature merged (PR #113).
This is a map of everything outstanding — pre-existing, this-session, deferred, parked, shelved, and
in-flight — so a fresh Governor can triage without re-deriving it. **Verify each item's premise
against the current code before starting** — spun-off briefs go stale (see
`feedback_verify_ticket_premise_against_code`).

## 0. Where things stand (orientation)

The multi-week **ingestion-reconciliation → Roots** arc is largely shipped:
- Reconciliation is ONE screen, ONE model (`buildReconciliationReport → reportToLanes →
  buildRootMapModel → RootMap + RootMapPanel`), projected as the **Roots** surface.
- **Roots is now the app HOME/dashboard** (PR #113): nodes navigate to setup ("Manage {Area} →"),
  a readiness-verdict banner (single-source `getReadiness`), Import/Worksheet/Facility entry points,
  post-import routes back to Roots with one focused banner, ReadinessHub retired, "← Roots" return on
  setup screens. Design: `docs/work/specs/2026-08-19-roots-dashboard-spine-design.md`; plan:
  `docs/work/plans/2026-08-19-roots-dashboard-spine.md`.
- Governing memory: `project_roots_reconciliation_audit`, `project_roots_tree_metaphor`,
  `project_ingestion_reconciliation_initiative`.

---

## 1. In flight NOW (coordinate before touching)

- **Blender root-map backdrop exploration** — a separate session (`blender-scene-info-e402bc-a6`) is
  developing a better root-system BACKDROP to replace `src/assets/reconciliation/root-map.png`.
  **Coupling:** node coords are hand-placed in `src/components/reconciliation/rootMapLayout.js`
  (`NODE_LAYOUT`, normalized [0,1] snapped to specific root pixels). A new backdrop is an ATOMIC
  change: new PNG (same path/filename) + re-derived NODE_LAYOUT + matched aspect (coords map to a
  1240×769 / 0.62 SVG box; `RootMap.jsx:185` hardcodes the 0.62 multiplier). Direction agreed: ~5
  differentiated major roots (one per domain), Context peripheral/optional. They hand back a matched
  (art+coords+aspect) candidate for review before production. **Do not edit rootMapLayout.js or the
  asset until they deliver.**

---

## 2. Deferred but NOT yet ticketed (recorded in audit/memory only)

**Decision pending from owner:** file these as real tickets, or leave in the audit doc?

From `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 ("deferred, revisit on evidence"):
- **M2** — multi-select domain filtering (lost when the port went single-select tile/node).
- **M3** — field-level `was → will-be` ledger diff (compressed into per-card lines).
- **M4** — per-field **UNKNOWN detection** (never built; "not in source" = optional-readiness gaps
  only, not genuine per-field unknowns). *Higher value than the others — it's a real capability gap.*
- **M5** — blast-radius **actually reorders** salience (currently computed as a hint, order stays
  report order).

From the Roots-dashboard work:
- **Header / heading copy** on Roots + PostImportBanner + ReconstructionMoment — parked for the
  owner's `/didwemenshion` language skill (NOT installed in the current environment; wire the words
  when it is). Structure is final; only wording is pending.
- **Facility "Open facility map →" distinct node-panel affordance** (owner's option-3 "persistent
  home") — functionally covered today by "Manage Resources →" reaching the Locations map; a distinct
  label was not built. File or fold-accept.

---

## 3. Filed this session (tickets, parked for later)

- **T91** — after merging, replacing a merged activity from the palette can't refill the span
  ("blob"). Schedule DnD/span. *Sibling of T92.*
- **T92** — manual generation (Manual Build route) can't merge yet (no hand-made multi-block spans).
  *Sibling of T91 — the two schedule merge-model gaps; likely one work-stream.*
- **T93** — no early host-gate on the import UI (client directors traverse the whole flow, fail only
  at commit). UX dead-end, not a security hole.
- **T94** — Roots first-timer orientation caption (design audit #7). Interacts with the Blender
  backdrop work (§1) and the parked copy (§2) — revisit after the new art lands.

## 4. Pre-existing OPEN backlog (predates this session — verify premise first)

- **T36** — ingest unlabeled-path residuals (3 silent-omission vectors, proven unreachable on the
  4-camp corpus; harden before a 5th).
- **T49** — finish ingestion.
- **T51** — MCP/CLI ingestion.
- **T52** — activity-colors tokenization.
- **T81** — activities-template importer deterministic location ids.
- **T83** — unify engine eligibility copies.
- **T86** — device-management handlers not host-gated on client.
- **T88** — single-source full-sync manifest. *Note: integration scenario 25 references T88 as
  landed — the ticket may be stale-open; verify against code before picking up.*

## 5. `parked`-status tickets (older, deliberately shelved) + in-progress

- **T38** — displaced-activities concept revisit (schedule).
- **T40** — one-day special-event schedule. **★ Converges with the Context domain** we just wired
  (field trips / special events / day overrides). A new Governor should consider whether the
  authored special-schedule layer (Context in Roots inspect mode) and T40 are one initiative.
- **T41** — elective scheduling.
- **C1b** — anchor slot-drift "moved" signal (schedule) — status *in-progress*; confirm whether any
  session still owns it.

---

## 6. Strategic / north-star (not yet planned)

- **Absorb Camp Setup into Roots node panels** — the explicit north star of the dashboard design
  (`...roots-dashboard-spine-design.md` §"Architecture toward the north star"). Today "Manage
  {Area} →" navigates to a separate setup screen; the north-star step is to host the setup editing
  *in the node panel* (the `node → panel → Manage` seam was built to make this a natural next step,
  not a rework). Large; own spec/ADR when the owner wants it.
- **Roots census depth** — the canvas stays category-level; per-entity detail is a panel roster
  (`RosterList`). If a future need wants richer on-canvas density, that's an ADR (the 5-slot arc
  fallback in `layoutForChild` is the current ceiling — see §1).

---

## 7. Process notes for the next Governor (learned this session)

- **Docs/plan PRs need the full `npm run verify`, not just `check:governance`.** `governance.test.js`
  (a Vitest test) requires `document_type`+`status` frontmatter on every `docs/work/**` doc; the
  writing-plans skill emits a markdown-header plan with none, which silently turned `main` RED after
  PR #112 (fixed in efe192b). Run the whole gate on doc PRs.
- **The Vercel PR check is spurious** for this Electron app ("Deployment was blocked") and can
  silently block a merge — merge over it (owner's standing instruction), but confirm the *real* gate
  (`npm run verify`) is green first.
- **Environmental test flakes:** `electron/sync/discovery.test.js` (fails when a real Shoresh host
  advertises on the dev LAN) and integration scenario timeouts under parallel load (e.g. "07
  mid-pairing reconnect") — re-run in isolation to confirm flake vs regression before treating as a
  blocker.
- **Read the real exit code**, not `| tail` or a trailing echo (`feedback_gate_exit_code_not_tail`).
- **Subagent-driven execution** worked well here: `maker` (test-first) → `code-reviewer` per task,
  `red-hat` on the risky task (state-lift/invariant), an opus whole-branch review, one consolidated
  fix pass. Use the project's own agents, not generic ones.

---

## Suggested first triage for the incoming Governor

1. Answer the owner's open question: file **M2–M5** (§2) as tickets or leave recorded?
2. Decide the **T91/T92 schedule-merge** work-stream (they're one problem) and **T40 ↔ Context**
   convergence (§5) — both are coherent next initiatives.
3. Let the Blender backdrop (§1) land as a reviewed candidate; it partly closes **T94**.
4. Everything else in §4 is standing backlog — re-verify each premise before committing.
