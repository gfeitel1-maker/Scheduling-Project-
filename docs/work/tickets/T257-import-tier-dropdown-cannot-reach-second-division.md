---
title: "A director cannot route an imported group to the second of two same-named divisions"
document_type: ticket
status: open
created: 2026-09-24
archive_when: the import tier picker can express "the OTHER same-named division" and the value it carries survives every hop to the commit without an id reaching director-facing copy, or the owner records that the capability is not wanted
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T255-name-keyed-lookups-assume-uniqueness.md]
---

# T257 — The import tier dropdown cannot reach the second same-named division

Spun out of [T255](T255-name-keyed-lookups-assume-uniqueness.md) **finding 7**, which slices A–C
deliberately did not touch. It was carried in T255 as a one-line "carry the id instead of the name";
reconnaissance against the tree showed that description understates it by a lot, which is why it is
its own ticket rather than a fourth slice.

## This is a capability gap, NOT a wrong bind — do not "fix" it with a tie-break

The commit side is **already deterministic**. `seedNameMaps` (`electron/ops/ingest.js`) does
`ORDER BY id ASC` with first-write-wins (T252), and rows created in-run get the same treatment. So the
name a director picks resolves to the lowest-id division **consistently, on every device**.

The defect is that the higher-id division is **unreachable**, and that the director is not told two
exist. `src/screens/ImportScreen.jsx`:

```js
const tierNames = [...new Set([
  ...(proposal.entities.tiers ?? []),
  ...(existingRecordsAll.tiers ?? [])
    .filter((t) => !activeCohort || t.cohort_id === activeCohort.id)
    .map((t) => t.name),
])]
```

`.map((t) => t.name)` discards the id **before** the `Set` dedups, so two same-named divisions render
as one `<option key={t} value={t}>`. A tie-break would change nothing here: the bind is already
deterministic, it is just not the one the director may want.

## Why this is not a one-line change — the three findings that resized it

### 1. Proposed tiers have no id, and the code cannot tell them apart from existing ones

`tierNames` is a flat merge of `proposal.entities.tiers` — an array of **plain strings**, appended to
by the inferred-division path — and `existingRecordsAll.tiers.map(t => t.name)`. Once merged,
**provenance is gone**: nothing downstream can distinguish a proposed division (which does not exist
yet, so has no id) from an existing one.

So the option value cannot simply become an id. It needs a **discriminated token** (`{kind:'id'|'proposed', value}`,
serialized) and every hop must accept both forms. **This is the recommended shape** — an id-only
contract cannot represent half the list.

Worse, the `Set` dedupe is currently **load-bearing**: it silently folds a proposed tier onto a
same-named existing one, and the inferred-division path already relies on that fold. Removing the
`Set` changes what the director *sees*, not only what they can pick.

### 2. An id would leak into director-facing copy

For a group that already exists, the `unit` delta becomes a reconciliation decision whose
`proposedValue` is the raw carried value (`src/ingest/reconciliationReport.js`) and is rendered
verbatim by `src/components/reconciliation/reconciliationCards.jsx`:

```js
`Use the file's value — ${quoteValue(decision.proposedValue)}`
```

A uuid there reads as gibberish to a camp director. The same applies to the `unit_unresolved`
fallback card (`src/screens/reconciliationTriage.js`). **Any fix must keep a display NAME alongside
whatever identity token it carries.**

### 3. Division evidence gates on a NAME comparison

`writeDivisionEvidence` (`electron/ops/ingest.js`) compares
`sameDivision(support.division, writtenDivision)` — **names**, not ids — and the division-support
side-channel (`item._division_support`, `src/ingest/buildPlan.js`) is name-keyed. An id-valued `unit`
would **silently stop writing division evidence** unless that comparison is updated too. Silently is
the problem: nothing would report it.

## The full chain, traced — every hop that must accept the new form

1. `src/screens/ImportScreen.jsx` — the dropdown, and `buildCommitInputs` (the
   `typeof override === 'string'` arm sets `groupUnits[name] = override`; the `__new__` arm pushes the
   typed name into `approved.tiers`), then `links: { groups: groupUnits }`.
2. `src/ingest/fieldUpdate.js` — `foldApprovedToRecords` (`fields.unit = groupUnits[name]`) **and**
   `resolveFieldWrite`'s `unit` arm, which returns `{ ok: false, reason: 'unit_unresolved' }` when the
   name does not resolve.
3. `src/ingest/buildPlan.js` — `item._link_unit`, **and** the update-diff path, which maps
   `unit: 'unit_name'` and compares `normalizeName(live) === normalizeName(proposed)` against the
   snapshot's `unit_name`. That snapshot column is a **name**, resolved via `tierNameById`.
4. `electron/ops/ingest.js` — the create commit's `tierIdByName.get(...)`, plus
   `writeDivisionEvidence` per finding 3 above.
5. `src/localClient.mock.js` — the dev-mock mirror. It must move in step or `npm run dev` diverges
   from Electron.

Note hops 2 (`resolveFieldWrite`) and 3 (the update diff) were **not** in T255's original trace.

## Recommendation

Carry a **discriminated token** (`{kind, value}`) rather than a bare id, keep a display name beside it
for the reconciliation copy, and update `writeDivisionEvidence`'s comparison in the same change.
Confidence: **medium-high** on the shape, lower on cost — the update-diff path compares names against
a stored snapshot column, so either the token resolves to a name early for diffing, or the snapshot
shape changes too. That choice deserves a look before implementation, and is the reason this is
`architecture` rather than a wiring ticket.

An id-only contract is **not** viable: proposed tiers have no id, and `tierIdByName` is seeded from
live rows *plus* rows created earlier in the same run, so a proposed tier resolving by name at commit
is an ordering guarantee the current design depends on.

## Non-goals

A lowest-id tie-break anywhere on this path — the commit side already has one and it is not the
problem. Reference-aware merge. Re-opening the v73 relaxation.
