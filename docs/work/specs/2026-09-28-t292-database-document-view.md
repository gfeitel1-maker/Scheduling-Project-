---
title: "T292 — Camp data record: a single openable workbook of the camp's data"
document_type: spec
authority: proposed
status: draft
task_class: ui-ux-design
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_adrs: [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md]
related_tickets: [docs/work/tickets/T292-database-document-view.md]
archive_when: "The owner accepts or rejects this spec. On acceptance, it leaves docs/work/ when the record ships and the owner confirms it; on rejection, when T292 records the disposition."
---

# T292 — Camp data record: a single openable workbook

This spec owns one idea from ticket [T292](../tickets/T292-database-document-view.md),
in the owner's words: **"a record that people can open to see into the work… not
magic… conceivably easy."** A director produces **one file** that shows the camp's
data as a workbook — one sheet per entity, human-readable — and can open, keep, or
send it.

Owner-confirmed shape (2026-09-28): **a single openable file, not an in-app screen;
the camp's data, not the build record.** This spec is deliberately small, because
the feature is small.

## 1. Success predicate

Done when a director, from the app, produces one `.xlsx` file that:

1. Opens with **one sheet per director-facing entity** (§4 list).
2. Columns are **human words** (app vocabulary), foreign keys shown as **names**,
   dates/times formatted; plumbing columns hidden (§4).
3. Carries a small **"Camp `<name>` — as of `<date>`"** meta line so it reads as a
   point-in-time copy.
4. Every cell routed through `aoaToSanitizedSheet` (`src/utils/exportSanitize.js`).

Verifiable in `electron:dev` (real projection) and by a unit test on the pure
builder (below), which is where the value is.

## 2. Non-goals

- **Not an in-app grid.** A file. (This is the correction that produced this spec:
  the first draft over-built a live in-app workbook with a grid-library decision;
  the owner rejected that altitude.)
- **Not the enrichment round-trip.** `src/utils/exportWorkbook.js` already writes a
  *re-importable* file — 6 ingestible entities, hidden `shoresh_id`/`Status`/baseline
  sheet, staleness gate (ADR 2026-08-08). This is a **plain human snapshot of all
  director-facing data**: no hidden columns, no baseline, no re-import contract. It
  is a sibling builder that shares the sanitizer and the FK-name pattern, not an
  extension of the round-trip.
- **Not editable, not canonical.** It reads the SQLite projection to render and is a
  copy; per [WHERE_DATA_LIVES](../../current/WHERE_DATA_LIVES.md) the Automerge
  document wins.
- **Not a SQL/DBA browser.** Curated and director-legible; no raw schema, no ids.

## 3. Why this is easy (reuse — confirmed against the tree)

Everything load-bearing already exists:

- **Read seam** — `window.shoresh.list(token, entity)` → `listEntities` (`electron/ops/read.js`),
  hard-whitelisted to camp-scoped entities (`electron/db/campScopedEntities.js`).
  Bookkeeping tables, `operations`, `tombstones`, `conflicts`, `devices`,
  `login_attempts`, and `users`/credentials are **unreachable through it** — so a
  builder over `list()` *cannot* leak plumbing or secrets by construction.
- **Sanitizer** — `aoaToSanitizedSheet` (`src/utils/exportSanitize.js`) is the
  mandatory formula-injection boundary; the existing exporters all route through it.
- **FK-as-name pattern** — `exportWorkbook.js` already shows how (name maps,
  `location_id`→name, `eligible_group_ids`→names); copy the pattern, not the file.
- **Entity + vocabulary list** — the MCP `ENTITY_MAP` (`scripts/mcp/tools.js`) seeds
  the director-facing set and their friendly names; `xlsx` is already a dependency.

The genuinely new code is one **pure builder** (`entities → workbook`) plus per-entity
column/label metadata and a small trigger + button. No new dependency, no new
stylesheet, no in-app grid.

## 4. Sheets and columns

**Default sheets (shown), setup-then-results order:**
Camp (name + dates only) · Age divisions (`tiers`) · Programs (`cohorts`) · Groups ·
Campers · Locations · Activities · Days · Time blocks · Weeks · Fixed events ·
Special days · Events · Elective sets.

**Left out by default** (Open question 1): schedule internals and participant tables
(`template_slots`, `schedule_snapshots`, `week_*_exclusions`, `event_*`,
`special_day_*`, `elective_*` participant tables). They are derived/plumbing and do
not read like "my data."

**Per sheet:** hide `id`, all `*_id` (resolve to names), `client_write_id`,
`camp_id`, `created_at`/`updated_at`/`deleted_at`; relabel columns to the app's
display words (e.g. `min_per_week` → "Min sessions/week"); soft-deleted rows
(`deleted_at`) omitted. This per-entity metadata is the actual design work and the
reason the task class is `ui-ux-design` rather than a blind table dump.

## 5. Recommended approach (one)

**A single pure function `buildCampDataWorkbook({ entities, campName, asOf }) → xlsx
workbook`, mirroring `exportWorkbook.js`'s structure minus the round-trip machinery
(no `shoresh_id`/`Status`/`_shoresh_meta` baseline), plus a thin `download…` trigger
and one "Download the camp's data" button.** Reuses `aoaToSanitizedSheet` and the
FK-name maps. `.xlsx` only.

**Confidence: High.** The reuse is confirmed, the volumes are trivial, and there is a
working sibling to pattern-match. The only judgment calls are the three small Open
questions in the ticket.

**Why not the alternatives:** an in-app grid is what the owner rejected; a standalone
`.html` file is a possible *addition* (Open question 3) but `.xlsx` is the "workbook"
the owner asked for and needs no new code path.

## 6. Slices

- **S1 — Pure builder + test.** `buildCampDataWorkbook` over the default sheet set
  with column policy + FK-name resolution; unit test asserts sheet set, header
  relabeling, FK-as-name, plumbing/credential absence, and sanitizer routing.
  (Test-first: this is the security-relevant seam — prove no id/credential leaks.)
- **S2 — Trigger + button.** Wire a "Download the camp's data" action (placement =
  Open question 2) that sources the entity arrays via `list()` and writes the file.
- **S3 (optional) — Advanced sheets / `.html` variant** only if the owner wants them
  (Open questions 1 and 3).

## 7. Where independent review looks

- **Security + Red Hat on S1:** confirm the builder cannot emit any `*_id`,
  `client_write_id`, credential, or bookkeeping field to a sheet, and that every
  worksheet routes through `aoaToSanitizedSheet` (no hand-built cell bypass — the
  failure mode ADR 2026-08-08 §Security F3 already names).
- **Designer on S1 column metadata:** relabeling vocabulary and FK-as-name
  presentation against `DESIGN_STANDARD.md`.

## 8. Open decisions for the owner

Small; all three live in the ticket:
1. Leave schedule-internal/participant tables out (recommended) or include them.
2. Where the download button lives (recommend a Roots/settings surface).
3. `.xlsx` only (recommended) or also a standalone `.html` file.

---

_Rewritten small after the owner's 2026-09-28 correction ("not magic… conceivably
easy"): the feature is a single openable file, and the spec is sized to match._
