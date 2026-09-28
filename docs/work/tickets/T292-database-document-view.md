---
title: "Camp data record — a self-maintaining openable file of the camp's data"
document_type: ticket
status: open
task_class: architecture
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_tickets: []
related_adrs: []
related_specs: [docs/work/specs/2026-09-28-t292-database-document-view.md]
archive_when: "Shoresh maintains a self-updating .xlsx record of the camp's data in ~/Documents/Shoresh/ from setup onward, refreshed on data change, and the owner confirms it against the spec; or the owner rejects the idea and this ticket records the disposition."
---

# T292 — A record people can open, that Shoresh keeps current on its own

## The idea, in the owner's terms

> "I want a record that people can open to see into the work. It is a feature most
> pieces of software do not have. This is not magic. Should be conceivably easy."
>
> "I don't want a separate 'download this now' button. I want it to be created when
> someone installs Shoresh."

A director should always have **one file** on their computer that shows the camp's
data as a workbook — one sheet per thing, plain rows and columns. They never ask for
it and never click anything: **Shoresh creates and maintains it automatically.** Open
it whenever, and it's current. Most software never lets you see the data underneath;
this does, as an always-present file.

Owner-confirmed shape (2026-09-28):
- **A single openable file**, not an in-app screen; **the camp's data**, not the build record.
- **No trigger button.** The app owns the file.
- **Auto-refresh on every data change** (and at first camp setup). Not a one-time write.
- **Location: `~/Documents/Shoresh/<camp> data.xlsx`** — where a director can find it.

## Observable success predicate

Done when, on a normally-running install:

1. From the moment a camp exists on the device (bootstrap or join), a file appears at
   `~/Documents/Shoresh/<camp> data.xlsx` **without the director doing anything**.
2. After any change to the camp's data — an edit, an import, an incoming sync — the
   file **reflects the change** the next time it is opened (writes are coalesced, not
   one-per-op; see spec §3).
3. The file opens with **one sheet per director-facing entity**, human-readable
   columns (app words, foreign keys as names, dates/times formatted), **no plumbing**
   (ids, `*_id`, timestamps, op-log/tombstone/device/auth/migration tables; camp
   credentials structurally unreachable), and a **"Camp `<name>` — as of `<date>`"**
   meta line.
4. Every cell routed through the existing sanitizer (`src/utils/exportSanitize.js`).
5. A failed refresh (Documents unwritable, file open-locked) **never blocks the actual
   edit** — it is best-effort and retried on the next change, surfaced non-fatally.

## Non-goals

- **No download/export button, no in-app grid.** (Owner-confirmed.) The file is the surface.
- **Not the enrichment round-trip.** `src/utils/exportWorkbook.js` writes a *re-importable*
  file with hidden `shoresh_id`/baseline machinery for 6 entities; this is a plain,
  read-only human snapshot of all director-facing data, no round-trip.
- **Not editable / not canonical.** It is a copy the app writes out; per WHERE_DATA_LIVES
  the Automerge document wins. Editing the file does nothing to the camp.
- **Not a SQL/DBA browser.** Curated, director-legible; no raw schema, no ids.

## Open questions (for the spec to settle)

1. Which entities make the default sheet set; leave schedule-internal/participant tables
   out (bias: yes).
2. Dev vs. packaged: the dev build uses a separate DB — should its file be suffixed
   (e.g. `<camp> data (dev).xlsx`) so it can't be mistaken for a real camp's? (bias: yes.)
3. Refresh coalescing window and trigger seam (which projection/op-apply event the
   writer hooks) — a spec/architecture detail, not an owner decision.
4. Camp rename / multiple camps over a device's life: filename follows the current camp;
   stale files from a prior camp name are left as-is (bias) or cleaned up.

## Status

Spec: [docs/work/specs/2026-09-28-t292-database-document-view.md](../specs/2026-09-28-t292-database-document-view.md).
Not yet built. Awaiting owner acceptance of the spec before implementation.
