---
title: "T292 — Database-document view: the camp's data as a read-only workbook lens"
document_type: spec
authority: proposed
status: draft
task_class: ui-ux-design
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_adrs: [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, docs/adr/2026-07-24-centralized-authorization-layer.md]
related_tickets: [docs/work/tickets/T292-database-document-view.md]
archive_when: "The owner accepts or rejects this spec. On acceptance, this leaves docs/work/ when the recommended read-only slices (below) ship and Governor confirms the shipped view against this spec; on rejection, when T292 records the disposition."
---

# T292 — Database-document view: the camp's data as a read-only workbook lens

This is a design/scoping spec, not code. It owns one product idea from ticket
[T292](../tickets/T292-database-document-view.md): let a non-technical camp director **see the data
underneath the app** as an Excel-like workbook — one sheet/tab per entity, rows and columns legible
at a glance. It restates the goal as a success predicate + non-goals, does reference research before
converging, **recommends one approach with confidence and evidence** (not a menu), slices it into
small reversible increments, and carries the residual owner decisions forward by name.

It deliberately does **not** design the editable variant. Editing is an open question that, if ever
answered yes, is a larger and higher-risk change deserving its own ADR (§9, Decision D1).

---

## 1. Observable success predicate (the feature's, not the ticket's)

The ticket's own predicate is "a spec exists." This section defines what **done** means for the
*shipped read-only view*, so a future Verifier can check it:

The database-document view is done (for its first read-only slice) when **a director, from the app
shell, can open a "Data" surface and:**

1. **See every director-facing entity as its own tab** — the curated allow-list of §5, seeded from
   the 8-entity MCP `ENTITY_MAP` and extended to the modeled camp entities, with schedule-internal
   and participant tables behind an explicit "Advanced" affordance, not shown by default.
2. **Read each tab as a grid** with a frozen header row and frozen first column, values (not
   formulas), numbers right-aligned, dates human-formatted.
3. **Never see plumbing:** no `id`/`*_id` foreign-key columns as raw ids (foreign keys render as the
   linked record's human name), no `client_write_id`, no `created_at`/`updated_at`/`deleted_at`,
   no op-log, tombstone, conflict, device, auth, or migration tables. `users` and credential fields
   are **structurally unreachable**, not merely hidden (§4).
4. **Trust that what it shows is real data**, not a projection artifact: the view reads SQLite
   (projection A) but carries a visible authoritative-only signal derived from projection health
   (§4) so that A-not-in-B divergence is surfaced, never silently presented as truth.
5. **Update as the camp changes** (live), and can **download a clearly-labeled point-in-time
   snapshot** (`.xlsx`) as an explicit escape hatch — the file says "as of `<date>`, this copy does
   not update."

Measurable in `electron:dev` (real stack), not the `:5200` mock, because it depends on the real
projection and IPC read seam.

## 2. Non-goals

Inherited from the ticket and sharpened:

- **Not a second source of truth.** Per [WHERE_DATA_LIVES](../../current/WHERE_DATA_LIVES.md),
  B (the Automerge document) wins; A (SQLite) is a rebuildable projection. This view reads A for
  convenience and must **never present A-not-in-B as real data** — it surfaces divergence instead.
- **Not a SQL console or raw table browser.** "Excel-like" means director-legible (Airtable/Numbers
  ergonomics), not a DBA tool (TablePlus/DB Browser). No arbitrary queries, no raw schema, no
  destructive controls.
- **Not an editing surface (this spec).** Read-only first. Any future write path is Decision D1 and
  its own ADR, and MUST go document-first (`window.shoresh.*` → `authorize()` → Automerge), never
  straight to SQLite; same-field edits surface `conflicts` rows.
- **Not a replacement** for the setup screens, schedule screens, or existing export. It is a
  cross-entity *lens*, complementary to the per-entity CRUD screens.
- **No coming-soon controls.** Read-only looks intentionally read-only; no disabled edit affordances
  (standing owner rule).

## 3. Reference research (before divergence)

Full findings in the run record; the load-bearing conclusions:

**Friendly relational grids (the right reference class): Airtable, Notion, Baserow, NocoDB.**
The legibility discipline that separates a director tool from a DBA tool is: **resolve foreign keys
to human names** (never show a UUID), **column types visible but friendly**, **frozen header + first
column**, **hide internal fields by view config rather than delete**, and **read-only looks
identical to editable, minus affordances**. NocoDB is the cautionary case — a thin grid over a real
schema *leaks* ids/junction tables/`created_at` unless columns are deliberately curated. Lesson:
curation is the product, not the grid widget.

**Raw table browsers (what T292 is NOT): TablePlus, DB Browser for SQLite, Metabase/Retool tables.**
They reveal the schema as-is (every id, FK-as-integer, junction table, SQL type) because they assume
the reader wants it. Wrong audience and wrong power surface.

**Spreadsheet ergonomics (Excel/Numbers/Sheets)** define what feels safe to *read*: sheet tabs,
frozen headers, implied per-column types, no formula literacy required, an unmistakable "you are
viewing, not changing" mode. For this audience, familiarity *is* the safety signal — mimic these
conventions.

**Export vs. in-app grid** is a genuine product fork. Export (.xlsx/CSV) wins on portability but its
worst failure is a stale saved file that becomes a **rival source of truth** people edit and email —
which directly violates this app's doctrine that no copy is canonical. In-app grid wins on
transparency and is obviously "a lens." T292's stated goal (SEE the data beneath the running app)
leans in-app grid, with export as a clearly-labeled snapshot escape hatch.

**What Electron + React 19 can render cheaply.** For a camp's volumes — dozens to low-hundreds of
rows per entity, tens of entities — a plain semantic `<table>` with CSS `position: sticky` headers is
sufficient and cheapest-correct; virtualization exists to avoid mounting 10k+ DOM nodes and there is
nothing to optimize here. If sorting/filtering/pinning or a future editable grid is wanted, the
pre-approved upgrade is **TanStack Table v8 (+ TanStack Virtual)** — headless, MIT, React-19-ready,
and it drags in **no competing stylesheet** (it composes with the repo's inline-styles + tokens
standard, respecting the single scoped-CSS exception). **Avoid ag-grid** (Enterprise licensing cliff
+ bundle), **glide-data-grid** (canvas overkill; hurts a11y/selection/copy at this volume). For
export, **prefer ExcelJS** (MIT-on-npm, trivial multi-sheet) over SheetJS/`xlsx` — though note the
repo **already ships `xlsx`** and already routes every export through a formula-injection sanitizer
(`src/utils/exportSanitize.js`), so the cheapest export path reuses that machinery (§8, Decision D3).

## 4. Current-state audit — what this builds on (never duplicates)

Confirmed against the tree; load-bearing seams the spec reuses:

**The read seam already exists and is already safe.** The renderer reads through
`window.shoresh.list(token, entity)` (`electron/preload.js`), backed by `listEntities(db, entity)`
(`electron/ops/read.js`) — the **single shared query path** for both IPC and MCP. Every query is
`SELECT * FROM <entity> WHERE camp_id = ?` (or a parent join), never caller-built SQL, and the entity
argument is **hard-whitelisted** to `DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES`
(`electron/db/campScopedEntities.js`). Consequence that matters for security: **bookkeeping tables,
`operations`, `tombstones`, `conflicts`, `devices`, `login_attempts`, and `users`/`camps` are
unreachable through this path** — a grid built on `list()` *cannot* accidentally expose credentials
or plumbing. `listByScope(token, entity, scopeId)` covers the parent-scoped schedule-internal
entities (`template_slots`, `week_*_exclusions`, `schedule_snapshots`). There is **no** existing
"dump every entity" call; a grid iterates `list()` per entity (cheap, all local SQLite).

**The director-vocabulary allow-list already exists** as the MCP `ENTITY_MAP`
(`scripts/mcp/tools.js`): `tiers` (age divisions), `cohorts` (programs), `groups`, `locations`,
`activities`, `days_of_operation`, `time_blocks`, `schedule_weeks`. `setup_summary` gives per-entity
row **counts** over the same 8 — a natural table-of-contents / row-count sidebar. Seed the default
allow-list from these 8.

**The A-vs-B divergence signal already exists but has no renderer IPC.** `checkProjectionHealth(db)`
plus `listDocumentWriteFailures(db)` (`store='document'`) and `listDeviceHealthEvents(db)` report the
exact "A shows a row that isn't really in B" case. Today only the MCP tool `check_projection_health`
reads it. Delivering §1.4's authoritative-only signal requires **one new read-only IPC** wrapping
these — the single genuinely new read-path piece.

**Export machinery already exists and is mature.** `src/utils/exportSchedule.js` (`exportToExcel`,
one sheet per day), `src/utils/exportWorkbook.js` (`exportWorkbook`/`downloadWorkbook`, per-entity
sheets + Meta sheet), all routed through `src/utils/exportSanitize.js` (`aoaToSanitizedSheet`) — the
**mandatory** formula-injection boundary any new export must use. `xlsx` is already a prod dependency.

**Setup screens already render each entity singly.** 12 screens share `useCrudScreen.js` +
`SetupScreenShell.jsx` + `setupCrudRepository`. So the grid **duplicates** the single-entity list but
**adds**: (a) a unified cross-entity workbook lens, (b) entities that have *no* setup screen
(`campers`, elective participant tables, week exclusions, schedule internals), (c) a raw-value read
that the curated CRUD screens abstract away.

**Entity inventory.** Modeled camp entities (`campScopedEntities.js`): direct — `groups`, `tiers`,
`activities`, `cohorts`, `days_of_operation`, `time_blocks`, `fixed_events`, `schedule_templates`,
`schedule_weeks`, `locations`, `camp_maps`, `special_days`, `elective_sets`, `events`, `campers`,
`elective_assignment_runs`; parent-scoped — `template_slots`, `schedule_snapshots`, `week_*_exclusions`,
`special_day_*`, `event_*`, `elective_*` (offerings/choices/preferences/assignments/occurrences),
`elective_run_outer_snapshots`. **Hidden by default:** everything SQLite-only (`operations`,
`tombstones`, `conflicts`, `devices`, `device_identity*`, `host_signing_key`, `login_attempts`,
`audit_events`, `locks`, `pending_*`, `projection_failures`, `device_health_events`,
`schema_migrations`, import/reconciliation decision tables, `source_aliases`) plus `users`/`camps`.

**Virtualization dependency:** none present today (`package.json`). React `^19.2.5`. The repo's
precedent for a dense grid (`src/components/schedule/scheduleGrid.css`) is CSS + inline geometry, not
a virtual-scroll library.

## 5. Which entities are shown (default allow-list + ordering)

**Default tabs (shown), ordered as a director thinks about setup then results:**
Camp (`camps` identity fields only — name, dates; *not* credentials) · Age divisions (`tiers`) ·
Programs (`cohorts`) · Groups · Campers · Locations · Activities · Days · Time blocks · Weeks ·
Fixed events · Special days · Events · Elective sets. Foreign keys in these render as names.

**Advanced (behind an explicit toggle, off by default):** schedule internals and participant tables —
`template_slots`, `schedule_snapshots`, `week_*_exclusions`, `event_*`, `special_day_*`,
`elective_*` participant tables, `elective_run_outer_snapshots`, `camp_maps`. These are synced but
derived/plumbing; a director rarely wants them and they read least like "my data."

**Never shown (structurally unreachable via `list()`):** all SQLite-only bookkeeping and `users`.

Column policy per tab: hide `id`, all `*_id` (resolve to names), `client_write_id`, `camp_id`,
`created_at`/`updated_at`/`deleted_at`; relabel remaining columns with the app's display vocabulary
(e.g. `min_per_week` → "Min sessions/week"); respect `deleted_at` (soft-deleted rows hidden unless a
"show trashed" toggle). Column relabeling + FK-resolution config is per-entity metadata — the
genuine design/curation work, and the reason this is `ui-ux-design`, not a generic table dump.

## 6. Recommended approach (ONE) + confidence + evidence

**Recommendation: Approach A — a live, in-app, read-only workbook view: tabbed, plain semantic
`<table>` with CSS sticky header + first column, foreign keys resolved to names, plumbing hidden,
headers relabeled to the app's vocabulary. Live by construction (reads the projection through the
existing `list()` IPC). Ship ExcelJS-or-existing-`xlsx` multi-sheet download as a clearly-labeled
snapshot escape hatch. Treat TanStack Table as the pre-approved upgrade path if/when sort/filter or
editing enters scope.**

**Confidence: High** for the read-only in-app-grid concept and the sticky-`<table>` baseline;
**Medium** on export-library choice (D3) and on whether virtualization is ever needed (it is not at
current volumes, but that's a data-volume bet).

**Evidence:**
- *Audience fit* — Airtable/Numbers ergonomics (tabs, frozen headers, FK-as-name) are exactly what a
  non-technical director already reads; raw browsers (TablePlus) are the explicit anti-goal.
- *Volume fit* — hundreds of rows per entity means virtualization optimizes nothing; a sticky
  `<table>` is cheapest-correct, most accessible, copy/selectable, and adds no dependency, no
  license, and **no competing stylesheet** (respects the single scoped-CSS exception in CLAUDE.md).
- *Reuse* — the read seam (`list()`), the allow-list (`ENTITY_MAP`), row counts (`setup_summary`),
  export + sanitizer, and the divergence signal (`checkProjectionHealth`) all already exist; the
  only genuinely new code is one read-only projection-health IPC + per-entity column/label metadata +
  the grid component. Small, reversible, low-risk — matching the owner's stated bias.
- *Doctrine fit* — live-and-labeled avoids the stale-rival-file failure that a snapshot-primary
  design would create, honoring "no copy is canonical."

**Why not the alternatives:** B (TanStack now) buys sort/filter/editing we don't yet need and is the
*upgrade*, not the start — A's markup swaps to it later without changing the concept. C
(export-primary) makes the snapshot the product and manufactures a rival source of truth.

## 7. Slices (small, reversible increments)

- **S1 — Read-only inventory + one tab (walking skeleton).** New "Data" screen in the app shell;
  entity-tab chrome; render the default allow-list's *counts* (`setup_summary`-style) and one entity
  (e.g. Activities) as a sticky-header `<table>` reading `list()`. No FK resolution yet (raw values,
  ids still hidden). Reversible: one screen, one route entry.
- **S2 — Column policy + FK resolution + relabeling.** Per-entity metadata: hide id/plumbing columns,
  resolve `*_id` to names, relabel headers, format dates/numbers, respect `deleted_at`. Apply across
  the full default allow-list. This is the curation slice — the bulk of the design work.
- **S3 — Authoritative-only signal.** Add the read-only IPC wrapping `checkProjectionHealth` +
  `listDocumentWriteFailures`; show a per-tab / global badge when A-vs-B divergence exists so the
  view never silently presents A-not-in-B as truth.
- **S4 — Live refresh.** Subscribe to `onOpApplied`/`onSyncStatusChanged`/`onOpConflict` push events
  to re-fetch the visible tab; a director watching sync sees the grid update.
- **S5 — Snapshot export.** "Download a copy (as of `<date>`)" producing a multi-sheet workbook via
  the existing export + `aoaToSanitizedSheet` sanitizer, one sheet per shown tab, explicitly labeled
  non-live. (Resolves D3.)
- **S6 (optional) — Advanced entities toggle.** Reveal schedule-internal/participant tables behind an
  explicit off-by-default control.

Editing is **not** a slice here — it is Decision D1 and, if approved, its own ticket + ADR.

## 8. Where independent review should look

- **Red Hat + Code Reviewer** on any read-path claim: confirm `list()`/`listByScope` truly cannot
  reach bookkeeping/`users` tables (the security-by-whitelist claim in §4), and that the
  authoritative-only signal (S3) correctly distinguishes `store='document'` failures (re-seed) from
  `store='projection'` failures (replay) — misreading these would make the badge lie.
- **Security** on S5 export: every worksheet MUST route through `aoaToSanitizedSheet`
  (formula-injection boundary); confirm no credential/plumbing field can reach a sheet.
- **Red Hat** on the "live view can never show A-not-in-B" claim (§1.4, §2) and on the snapshot's
  non-canonical labeling (doctrine risk).
- **Designer** owns the S2 curation (relabeling vocabulary, FK-as-name presentation, empty/trashed
  states) against `DESIGN_STANDARD.md`.
- **Architect + its own ADR** are required *before* any editable slice (D1) — not for the read-only
  slices above.

## 9. Open decisions carried to the owner (named)

- **D1 — Read-only vs. ever-editable.** This spec commits to read-only. If editing is wanted, it is a
  separate ticket + ADR; every write goes document-first (`window.shoresh.*` → `authorize()` →
  Automerge), never to SQLite, and same-field edits surface `conflicts`. *Recommendation: ship
  read-only; defer editing decision until directors have used the read view.*
- **D2 — Grid widget: sticky `<table>` vs. TanStack now.** *Recommendation: start with the sticky
  `<table>` (no dependency); adopt TanStack only when sort/filter or editing is approved.*
- **D3 — Export library: reuse existing `xlsx` vs. add ExcelJS.** *Recommendation: reuse the existing
  `xlsx` + `aoaToSanitizedSheet` machinery for S5 to avoid a second spreadsheet dependency; revisit
  ExcelJS only if multi-sheet styling needs outgrow it.*
- **D4 — Advanced entities: ship S6 or leave schedule-internals permanently hidden?** *Recommendation:
  build S6 last, off by default; a director asking to see schedule internals is rare.*
- **D5 — Surface placement.** Full app-shell screen (recommended) vs. a modal/inspector. *A screen
  matches the "workbook" mental model and the sidebar navigation; a modal reads as transient.*
- **D6 — Live vs. snapshot as the primary.** This spec recommends **live primary, snapshot as escape
  hatch** (§3, §6). Confirm the owner agrees the primary surface is the on-screen live lens.

---

_Prepared by Governor for owner review. On acceptance, S1–S5 route through the normal quality loop
(Maker → Verifier → Tester/Security/Red Hat/Code Reviewer → Grader); the editable question (D1) does
not enter that loop without its own ADR._
