---
title: "Database-document view — see the camp's data as an Excel-like workbook"
document_type: ticket
status: open
task_class: ui-ux-design
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/WHERE_DATA_LIVES.md]
related_tickets: []
related_adrs: []
related_specs: []
archive_when: "A Governor-owned spec/ADR for this idea has been produced and either accepted (feature scoped into implementation tickets) or rejected by the owner, and this ticket's disposition records which."
---

# T292 — Database-document view ("see the data underneath the app")

## The idea, in the owner's terms

While hardening WAN sync the owner raised a product idea: **present the underlying
camp data — the Automerge document and its SQLite projection — as a viewable,
Excel-like "database document."** A director should be able to *see* the data that
lives beneath the app the way they'd see a workbook: a spreadsheet-grid view, one
sheet/tab per entity (table), rows and columns they can read at a glance.

The intent is **read-through / viewable first** — a window onto the real data, not
a new authoring surface. Whether it should ever become editable is deliberately
left open (see Open questions).

**This is an early product idea, not a settled design.** This ticket exists to put
the idea on the board and hand it to a Governor to spec. It does not commit the
app to building it, nor to any particular shape.

## Observable success predicate (for THIS ticket)

This ticket is a spec-track ticket, not an implementation ticket. It is complete when:

- A Governor-owned spec and/or ADR for the database-document view exists under
  `docs/work/specs/` or `docs/adr/`, and it: (a) restates the goal as a success
  predicate + explicit non-goals, (b) does reference research before divergence,
  (c) recommends ONE approach with a stated confidence and the evidence behind it
  (not a menu of options), and (d) is sliced into small reversible increments.
- The open questions below are each either answered in that spec or explicitly
  carried forward as a named owner decision.
- The owner has a spec ready to review; implementation is out of scope here.

(The *feature's* own success predicate — what "done" means for the shipped view —
is the spec's job to define, not this ticket's.)

## Non-goals (of the idea, as currently understood)

- **Not** a replacement for the schedule screens, the setup screens, or export.
  It is a *lens on the data*, not a new place to run the product's workflows.
- **Not** a general SQL console or a raw table browser exposing internal columns,
  tombstones, op-log rows, or sync bookkeeping. "Excel-like" means legible to a
  non-technical director, not a DBA tool. (What internal columns are hidden vs.
  shown is an open question, but the default bias is legibility.)
- **Not** a second source of truth. Per `docs/current/WHERE_DATA_LIVES.md`, the
  Automerge document (B) is authoritative and SQLite (A) is a rebuildable
  projection. Any view here reads a projection; it must not become a copy that can
  drift or a write path that bypasses the document.
- **Not** (initially) an editing surface. Editing is an open question, not a
  committed goal.

## Open questions (for the Governor/spec to resolve)

1. **Read-only vs. editable.** Ship viewable-first? If editing is ever in scope,
   every write must still go through the document-first path (`window.shoresh.*`
   → `authorize()` → Automerge), never straight to SQLite — and same-field edits
   surface `conflicts` rows. Editing likely deserves its own later slice/ADR.
2. **Which entities/tables are shown**, and in what order — and which internal
   columns/tables are hidden (op log, tombstones, sync watermarks, id/foreign-key
   plumbing) vs. surfaced. `mcp__shoresh__list_entities` and `setup_summary`
   enumerate what exists today.
3. **Relationship to existing export.** How does this differ from / build on the
   current schedule export (`mcp__shoresh__export_schedule`) and any JSON export?
   Is the workbook view "export, but live and on-screen," or a distinct surface?
   Reuse vs. new code is a Governor call.
4. **Read source.** Read from the SQLite projection (convenient to query) with the
   document as the acknowledged authority, per WHERE_DATA_LIVES — confirm this is
   the right seam and that the view can never present A-not-in-B as real data.
5. **In-app screen vs. exported artifact.** A new screen in the app shell, a
   modal/inspector, or a generated `.xlsx`/CSV the director opens in Excel — or
   more than one of these. Reference research should inform the recommendation.
6. **Live vs. snapshot.** Does the grid update as sync arrives, or is it a
   point-in-time snapshot? Affects both UX and implementation cost.

## Why this is only a ticket right now

Per the owner's engineering-workflow defaults, a consequential idea gets translated
into a success predicate + non-goals and specced with a recommended approach before
any code. This ticket captures the idea and its open questions so the Governor has a
durable brief; the Governor produces the spec/ADR for owner review.
