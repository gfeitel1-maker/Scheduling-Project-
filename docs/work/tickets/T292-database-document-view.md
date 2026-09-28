---
title: "Camp data record — a single openable file that shows the camp's data"
document_type: ticket
status: open
task_class: ui-ux-design
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_tickets: []
related_adrs: []
related_specs: [docs/work/specs/2026-09-28-t292-database-document-view.md]
archive_when: "The 'download the camp's data' record ships (a single openable .xlsx workbook of the camp's director-facing data) and the owner confirms it against the spec; or the owner rejects the idea and this ticket records the disposition."
---

# T292 — A record people can open, to see the camp's data

## The idea, in the owner's terms

> "I want a record that people can open to see into the work. It is a feature most
> pieces of software do not have. This is not magic. Should be conceivably easy."

A director should be able to open **one file** that shows the camp's actual data —
the records the app is built on — laid out like a workbook: one sheet per thing
(groups, activities, days, campers, …), plain rows and columns, readable at a
glance. You can open it, keep it, or send it. Most software never lets you see the
data underneath it; this does, and it should be close to free because the app
already holds the data and already knows how to write a spreadsheet.

**Form (owner-confirmed 2026-09-28): a single openable file**, not an in-app
screen. **Scope: the camp's data** (not the software's build/dev record).

## Observable success predicate

Done when a director can, from the app, produce **one `.xlsx` file** that:

1. Opens in Excel/Numbers/Sheets with **one sheet per director-facing entity**
   (groups, tiers/age divisions, cohorts/programs, activities, locations, days,
   time blocks, weeks, campers, fixed events, special days, events, elective sets).
2. Shows **human-readable columns** — headers in the app's words (not raw db column
   names), foreign keys rendered as the linked record's **name** (never a UUID),
   dates and times formatted.
3. **Hides plumbing** — no id/`*_id`, `client_write_id`, `created_at`/`updated_at`/
   `deleted_at`; no op-log/tombstone/conflict/device/auth/migration tables; camp
   credentials are structurally unreachable (they are never read).
4. Carries a small **cover/meta line** — camp name and "as of `<date>`" — so a
   reader knows it is a point-in-time copy, not a live document.
5. Runs every cell through the existing formula-injection sanitizer
   (`src/utils/exportSanitize.js`).

## Non-goals

- **Not an in-app grid / screen** — it is a file you open. (Owner-confirmed.)
- **Not the enrichment round-trip.** The existing `exportWorkbook.js` writes a
  re-importable file with hidden `shoresh_id`/baseline machinery for a subset of
  entities; this is a *plain human snapshot* of all director-facing data, no
  round-trip, no hidden columns.
- **Not editable / not a source of truth.** It is a copy. Per WHERE_DATA_LIVES the
  Automerge document wins; this reads the SQLite projection only to render, and
  never claims to be canonical.
- **Not a SQL/DBA browser** — director-legible, curated, no raw schema.

## Open questions (small — for the spec to settle)

1. Which entities make the default sheet set, and are schedule-internal/participant
   tables (`template_slots`, elective participant tables, week exclusions) left out
   or included behind a plain label. (Bias: leave out; they don't read like "my data.")
2. Where the "Download the camp's data" action lives (e.g. a button on a
   settings/roots surface) — trivial, but a placement choice.
3. Whether a second, even-simpler format (a single standalone `.html` file) is worth
   offering alongside `.xlsx`. (Bias: `.xlsx` only; it is the "workbook" they asked for.)

## Status

Spec: [docs/work/specs/2026-09-28-t292-database-document-view.md](../specs/2026-09-28-t292-database-document-view.md).
Not yet built. Awaiting owner acceptance of the spec before implementation.
