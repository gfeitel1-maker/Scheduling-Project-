---
title: "Historical database fixtures, migrated across the whole chain"
document_type: ticket
status: completed
created: 2026-09-13
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: databases written by the localDb.js that actually shipped at several past eras are committed as fixtures and a test drags each across the full chain to the current version, asserting the camp's meaning rather than its schema shape
---

# T154 — Historical database fixtures, migrated across the whole chain

From the external architecture review of 2026-09-13 (item 5). Correct as stated:
the schema is at v59, every migration test synthesizes its own pre-state ad hoc,
and pairwise coverage cannot show what happens when a database is dragged across
thirty migrations at once. For an app whose durable artifacts sit untouched
between summers, that is the ordinary case.

## The fixtures are real

`scripts/fixtures/make-era-fixtures.mjs` checks the **localDb.js that actually
shipped** out of git history for four commits and runs it to create each
database:

| Fixture | Era |
|---|---|
| `v10-renderer-local-first` | renderer local-first tables |
| `v23-two-route-schedules` | manual/generated route split |
| `v34-special-days` | special-days data shape |
| `v48-tile-world` | tile-world placement columns |

A fixture produced by running *today's* chain up to version N would prove only
that today's code agrees with itself. It could never catch a migration
mis-reading a shape today's code would not have written. These were written by
the code of the era, all the way down — the generator copies that commit's whole
`electron/db` and `electron/ops`, so no migration runs against a modern helper.

The generator is committed and deterministic (fixed ids, no randomness), so
re-running it produces the same bytes and a diff means a real change.

## The assertion is semantic

A migration that leaves the columns perfect and the meaning altered is the
failure worth catching. `eraMigration.test.js` asserts the camp, its groups and
their divisions, its days, its activities, and **the schedule placements
themselves** — deliberately not by template id, since v21/v22 re-mint those by
design, but by "the two placements still point at one existing template, the
right groups, the right day and block, the right activities". Plus an empty
`PRAGMA foreign_key_check` and no duplication.

**Result: all four eras migrate to v59 with meaning intact.** The chain is in
better shape than the review feared. The value is now that it stays that way.

Not covered, and worth knowing: there is no `.automerge` fixture, because the
document format postdates every era here and no camp has one from a past release
yet. That becomes worth adding at the first document-format change.
