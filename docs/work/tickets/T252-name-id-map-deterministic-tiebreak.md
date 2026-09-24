---
title: "Name-to-id maps get a deterministic lowest-id tie-break"
document_type: ticket
status: open
created: 2026-09-23
archive_when: all five ingest.js seedNameMaps sites and materializeImportedVersion.js's nameMap resolve a duplicated name to the lowest id regardless of row return order, proven by a test that reverses insertion order
task_class: data
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T252 — Deterministic tie-break on the name→id maps

## Why

Once duplicates are permitted, a name-keyed id map built by `Map.set(name, row.id)` over an unordered
`SELECT` is last-row-wins, and SQLite does not guarantee that order — nor that two devices whose rows
arrived via merge in different physical insert order return it the same way. The same document would
then produce different import results on different devices.

## Scope — five sites, not the three the spec cited

`electron/ops/ingest.js`'s `seedNameMaps` (~897–916):

| Site | Keys against | At risk |
|---|---|---|
| `tierIdByName` | `tiers` (relaxed) | yes |
| `blockIdByName` | `time_blocks` (relaxed) | yes |
| `dayIdByName` | `days_of_operation` (hard) | transiently, during an open conflict |
| `groupIdByName` | `groups` (relaxed) | yes |
| `locationIdByName` | `locations` (relaxed) | yes |

Plus `electron/ops/materializeImportedVersion.js:26`'s generic `nameMap()`.

## Success predicate (observable)

1. All six sites apply the same tie-break: **lowest `id` ascending wins the map slot**, by an explicit
   sort or `ORDER BY id ASC`, uniformly — one mechanical fix, not six designs.
2. A test builds the same set of rows in two opposite insertion orders and asserts a byte-identical map
   from both. Fixtures go through the **real write path**, never hand-inserted rows.
3. `dayIdByName` gets the same treatment even though `days_of_operation` stays hard — it is transiently
   ambiguous while a `unique:` conflict is open.

## Non-goals

Changing what the importer does with the ambiguity beyond making it deterministic. The duplicate flag
is what tells the director to fix the underlying cause.
