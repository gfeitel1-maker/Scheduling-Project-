---
title: "A migration that changes camp meaning cannot silently diverge from the document"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: every migration version is classified as domain-state or schema-only, a new one fails the suite until it is classified, and sync refuses to start when a domain-state migration has run against a camp that already has a document
---

# T152 — A migration that changes camp meaning cannot silently diverge from the document

From the external architecture review of 2026-09-13 (item 2). The rule is right;
the specific case is not currently reachable; nothing guarded the next one.

**The rule.** The document is authoritative and SQLite is a projection. A
migration that edits domain rows in SQLite alone changes something the document
does not know about, and `projectAll`'s delete-reconcile undoes it at the next
merge. `projector.js`'s empty-document guard does not help — by its own comment
it refuses only a *totally* empty document, and a partially-divergent one passes.

**Why it cannot happen today.** A `.automerge` file only exists for a database
that has run a document-era build, and such a database is already at v57+. Every
migration that touches domain state is at v32 or below. The startup order is also
correct for the other case: `openLocalDb` migrates, then `ensureSeeded` builds the
document from the migrated rows.

**What was missing** was any way for the next author to find out they were about
to break it. `localDb.js` has no awareness that a document exists at all.

## What changed

`electron/db/migrationDomainState.js` classifies **every** version 1..59 as
domain-state (with a sentence saying what it does) or schema-only. Ten are
domain-state: the v11/v12/v14/v15 de-duplication re-points, the v21
`schedule_templates` identity repair, the v23 `kind` backfill, v24's orphan
re-point, v26's orphan retirement, v27's `week_id` backfill, and v32's
`backfillLocations`. Two that write a modeled *table* but a host-only *field*
(v9 `camps.signing_secret`, v22 `device_identity`) are deliberately excluded,
with the reason recorded.

- A test fails if any version is unclassified, double-classified, or above the
  current schema — so a new migration is an error until someone decides.
- A second test reads `localDb.js` and fails if a block classified schema-only
  contains an inline write to a modeled table. Verified non-vacuous by planting
  one. Its blind spot is stated in the test: it cannot see writes inside a helper
  function called from the block (v32's own case), which is why classification is
  by reading, not by scanning.
- At startup, if a domain-state migration ran on a launch where a document
  already exists, **the sync node does not start** and the refusal is recorded in
  the audit log. The device keeps working alone — that is what local-first is for
  — but it will not replicate state the document is about to overwrite.

**Auto-repair is deliberately not attempted.** Re-seeding the document from the
migrated SQLite would resurrect every tombstone the document holds and SQLite does
not. The correct repair is to apply the change *through* the document, which a
generic mechanism cannot author. So this detects and refuses; it does not guess.
