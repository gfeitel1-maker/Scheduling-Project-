---
title: "T292 — Camp data record: a self-maintaining openable workbook"
document_type: spec
authority: proposed
status: approved
task_class: architecture
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_adrs: [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md]
related_tickets: [docs/work/tickets/T292-database-document-view.md]
archive_when: "The owner accepts or rejects this spec. On acceptance, it leaves docs/work/ when the self-maintaining record ships and the owner confirms it; on rejection, when T292 records the disposition."
---

# T292 — Camp data record: a self-maintaining openable workbook

This spec owns one idea from ticket [T292](../tickets/T292-database-document-view.md),
in the owner's words: **"a record that people can open to see into the work… not
magic… conceivably easy,"** and **"I don't want a separate download-this-now button.
I want it to be created when someone installs Shoresh."**

Shoresh keeps **one file** on the director's computer — a workbook of the camp's data,
one sheet per thing — always current, with no button and no action. Open it whenever;
it reflects the camp.

Owner-confirmed shape (2026-09-28):
- A single **openable file**, not an in-app screen; the **camp's data**, not the build record.
- **No trigger** — the app owns and maintains the file.
- **Auto-refresh on every data change**, and created at first camp setup.
- **`~/Documents/Shoresh/<camp> data.xlsx`**.

## 1. Success predicate

On a normally-running install:

1. From the moment a camp exists on the device, `~/Documents/Shoresh/<camp> data.xlsx`
   exists, with **no director action**.
2. After any camp-data change (edit, import, incoming sync), the file reflects it on
   next open — writes **coalesced**, not one-per-op (§3).
3. One sheet per director-facing entity (§4); human columns (app words, FKs as names,
   formatted dates/times); **no plumbing** (ids, `*_id`, timestamps, bookkeeping/auth
   tables); credentials structurally unreachable; a **"Camp `<name>` — as of `<date>`"**
   meta line.
4. Every cell through `aoaToSanitizedSheet` (`src/utils/exportSanitize.js`).
5. A refresh failure (Documents unwritable, file open-locked) **never blocks the real
   edit** — best-effort, retried on the next change, surfaced non-fatally.

Verified by (a) a unit test on the pure builder (sheet set, relabeling, FK-as-name,
no-leak, sanitizer routing) and (b) an integration test that a simulated op-apply
triggers a coalesced write to a temp location.

## 2. Non-goals

- **No button, no in-app grid, no export menu.** The file is the surface. (This is the
  correction chain that produced this spec: v1 built a live in-app grid — rejected;
  v2 added a download button — rejected. The app maintains the file itself.)
- **Not the enrichment round-trip.** `src/utils/exportWorkbook.js` writes a
  *re-importable* file (6 entities, hidden `shoresh_id`/`Status`/`_shoresh_meta`
  baseline, staleness gate — ADR 2026-08-08). This is a plain **read-only human
  snapshot of all director-facing data**: no hidden columns, no baseline, no re-import
  contract. Sibling builder; shares the sanitizer and FK-name pattern only.
- **Not editable / not canonical.** Written out from the projection; editing the file
  does nothing to the camp. Per [WHERE_DATA_LIVES](../../current/WHERE_DATA_LIVES.md)
  the Automerge document wins.
- **Not a SQL/DBA browser.** Curated, director-legible.

## 3. Design — a main-process auto-writer (the load-bearing part)

The file is maintained in the **Electron main process**, which already has the db, the
projection, filesystem access, and the change signals. Two pieces:

**A. A pure builder** `buildCampDataWorkbook({ entities, campName, asOf }) → xlsx
workbook`. Mirrors `exportWorkbook.js`'s structure **minus** the round-trip machinery
(no `shoresh_id`/`Status`/`_shoresh_meta` baseline). Reuses `aoaToSanitizedSheet` and
the FK-name maps. Pure and unit-tested — this is the security-relevant seam.

**B. A refresh hook** in the main process:
- **Trigger:** the signals `main.js` already handles — `syncClient.onOpApplied(...)`
  (fires for both local writes and incoming sync ops; the projection is already updated
  by then) and `shoresh:full-sync-applied`. Also once when a camp first exists
  (bootstrap/join completion) so the file is born with the first data.
- **Coalescing:** debounce (e.g. a short trailing window, ~1–2 s) so a bulk import that
  emits hundreds of ops produces **one** rewrite after it settles, not hundreds.
- **Read:** entity arrays via the main-side read seam `listEntities(db, entity)`
  (`electron/ops/read.js`) — the same hard-whitelisted path the renderer's `list()`
  uses, so bookkeeping/`users`/credentials are **unreachable by construction**.
- **Write:** to `~/Documents/Shoresh/`, creating the folder if absent, writing to a
  temp file then atomic-rename so a reader never sees a half-written file.
- **Failure:** best-effort. Documents-unwritable or file-open-locked (a director has it
  open in Excel) is caught, logged, surfaced non-fatally, and retried on the next
  change. It **must never** throw into or block the write path that produced the op.
- **Camp identity & filename:** single-camp-per-device-db (`SELECT ... FROM camps
  LIMIT 1`); filename follows the current camp name (sanitized for the filesystem).
- **Dev vs. packaged:** dev uses a separate DB (`shoresh-dev`); its file is suffixed
  `(dev)` so it can't be mistaken for a real camp's export (Open decision D2).

This hook is why the task class is `architecture`, not `ui-ux-design`: it attaches to
the op-apply/projection seam and does filesystem IO on every change. It needs an
Architect pass (and this spec doubles as the mini-ADR for *where* the hook lives);
the sheet curation (§4) is the Designer's part.

## 4. Sheets and columns

**Default sheets, setup-then-results order:** Camp (name + dates only) · Age divisions
(`tiers`) · Programs (`cohorts`) · Groups · Campers · Locations · Activities · Days ·
Time blocks · Weeks · Fixed events · Special days · Events · Elective sets.

**Left out by default (D1):** schedule internals / participant tables (`template_slots`,
`schedule_snapshots`, `week_*_exclusions`, `event_*`, `special_day_*`, `elective_*`
participant tables). Derived/plumbing; don't read like "my data."

**Per sheet:** hide `id`, all `*_id` (resolve to names), `client_write_id`, `camp_id`,
`created_at`/`updated_at`/`deleted_at`; relabel columns to app words (e.g.
`min_per_week` → "Min sessions/week"); omit soft-deleted (`deleted_at`) rows. This
per-entity metadata is the real design work.

## 5. Recommended approach (one)

**The pure builder (A) + the main-process debounced refresh hook (B) above, writing a
single `.xlsx` to `~/Documents/Shoresh/`, best-effort and atomic.** `.xlsx` only.

**Confidence: High** on the builder, the read/no-leak seam, and the trigger points
(they already exist and are already wired for other consumers). **Medium** on the
coalescing window value and on cross-platform Documents-path/locked-file behavior,
which the integration test and the failure path (§3B) exist to pin.

**Why not the alternatives:** an in-app grid and a download button are both explicitly
rejected. Writing on app-close-only would let the open file lag a live edit session
(the owner chose on-every-change). A standalone `.html` file is a possible addition
(D3), but `.xlsx` is the "workbook" asked for and needs no second code path.

## 6. Slices

- **S1 — Pure builder + test.** `buildCampDataWorkbook` over the default sheet set with
  column policy + FK-name resolution; unit test asserts sheet set, relabeling,
  FK-as-name, **absence of any id/credential/bookkeeping field**, and sanitizer
  routing. Test-first — this is the no-leak seam.
- **S2 — Refresh hook.** Wire the debounced main-process writer to `onOpApplied` /
  `full-sync-applied` / first-camp-exists; atomic write to `~/Documents/Shoresh/`;
  best-effort failure handling. Integration test: a simulated op-apply produces exactly
  one coalesced write to a temp dir.
- **S3 (optional) — Advanced sheets and/or `.html` variant** only if the owner wants
  them (D1, D3).

## 7. Where independent review looks

- **Security + Red Hat on S1:** the builder cannot emit any `*_id`, `client_write_id`,
  credential, or bookkeeping field; every worksheet routes through `aoaToSanitizedSheet`
  (no hand-built cell bypass — ADR 2026-08-08 §Security F3).
- **Red Hat on S2:** the refresh hook is truly non-blocking and never throws into the
  op path; coalescing cannot drop the *last* change; atomic write leaves no partial file.
- **Architect on S2:** the hook's placement on the op-apply seam and its interaction
  with projection ordering (write reads A *after* `projectAll`, never mid-projection).
- **Designer on S1 metadata:** relabeling vocabulary, FK-as-name, empty states, against
  `DESIGN_STANDARD.md`.

## 8. Owner decisions — SETTLED (2026-09-28: "build it with the recommendations")

1. **D1 — RESOLVED: leave schedule-internal/participant tables out** of the default file.
2. **D2 — RESOLVED: suffix the dev build's file `(dev)`** so it can't be mistaken for a
   real camp's.
3. **D3 — RESOLVED: `.xlsx` only.** No `.html` variant.
4. **D4 — RESOLVED: filename follows the current camp; old files are left in place** on
   rename or camp change (no cleanup).

S3 (advanced sheets / `.html`) is therefore **dropped** from scope — build S1 + S2 only.

---

_Sized small to match the owner's "conceivably easy," then grown only where the
"created on install, maintained automatically" requirement genuinely adds a
main-process refresh mechanism (§3)._
