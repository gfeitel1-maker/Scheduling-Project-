---
title: "Shared entity table — design"
document_type: spec
status: active
created: 2026-07-29
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: []
archive_when: this work is merged and Verifier PASS recorded
---

# Shared entity table — design

One `EntityTable` component with a standard toolbar — **Search · Filter · Sort ·
Group by · Columns** — plus a footer summary row, replacing seven bespoke
setup-screen tables.

## 1. The problem

Seven screens render structurally identical tables with independently written,
divergent implementations:

| Screen | Lines | Sort | Filter | Search |
|---|---|---|---|---|
| `CohortsScreen` | 333 | hardcoded | none | none |
| `TiersScreen` | 508 | hardcoded | none | none |
| `GroupsScreen` | 474 | hardcoded alpha (`:99-103`) | none | none |
| `DaysScreen` | 347 | hardcoded | none | none |
| `TimeBlocksScreen` | 486 | hardcoded | none | none |
| `ActivitiesScreen` | 701 | hardcoded | none | none |
| `AnchorsScreen` | 693 | hardcoded | none | none |

No search input exists anywhere in `src/screens/`. Every table is a flat
alphabetical list of everything. A 60-bunk camp makes `GroupsScreen` a
scroll-and-squint exercise, and there is no way to answer "which groups have no
unit?" other than reading all 60 rows.

Seven implementations is also seven places to fix each bug, and the divergence
is unmotivated — the screens differ in their columns and their edit forms, not
in how a table should behave.

## 2. Component contract

`src/components/data/EntityTable.jsx`. One deep module: callers describe *what*
their data is, never *how* the table behaves.

```js
<EntityTable
  rows={groups}                    // array of plain objects
  columns={[
    { key: 'name',         label: 'Name',   type: 'text' },
    { key: 'tier_id',      label: 'Unit',   type: 'ref',
      options: tiers, emptyLabel: '—' },
    { key: 'availability', label: 'Availability', type: 'enum',
      options: AVAIL_OPTIONS },
  ]}
  rowKey="id"
  defaultSort={{ key: 'name', dir: 'asc' }}
  summary={[
    { label: 'groups', value: rows => rows.length },
    { label: 'without a unit', value: rows => rows.filter(r => !r.tier_id).length,
      tone: 'warning' },
  ]}
  decorate={row => !row.tier_id ? 'warning' : null}
  renderRow={...}                  // caller owns the row's cells + edit affordances
  toolbar={{ search: true, filter: true, sort: true, groupBy: true, columns: true }}
  emptyState={<>No groups yet. Add one to get started.</>}
/>
```

Callers keep ownership of row rendering and mutation — this is a table, not a
CRUD framework. It owns exactly: toolbar state, the derived row set (search →
filter → sort → group), the summary footer, decoration, and the empty state.

### Toolbar semantics

- **Search** — substring, case-insensitive, across all `type: 'text'` columns
  and the resolved display label of `ref`/`enum` columns. Debounced 150ms.
- **Filter** — stacked `field · operator · value` clauses, AND-ed. Operators by
  column type: text (`is`, `contains`, `is empty`), enum/ref (`is`, `is not`,
  `is empty`), number (`=`, `>`, `<`, `is empty`).
- **Sort** — column + direction; multi-key, applied in the order added.
- **Group by** — one column; renders collapsible sections with per-section
  counts. `ref` columns group by resolved name, with a trailing "No unit"
  section for nulls.
- **Columns** — show/hide and reorder.

### Persistence

Toolbar state persists **per screen, per device**, in `localStorage` under
`shoresh-table-<screenKey>`. Not in the op log and not synced: this is a view
preference, not camp data, and one director's filter has no business changing
what a counsellor on another device sees. It survives navigation and relaunch,
which is the actual complaint — state dying on every screen change.

Reset control in the toolbar clears it.

### Decoration

`decorate(row) -> 'warning' | 'danger' | null` drives a left border and subtle
background tint, reusing the existing flag vocabulary and `--warning` /
`--danger` tokens. This is the hook for surfacing setup errors at entry time —
a group with no unit, an activity nothing is eligible for — rather than
downstream as a bad generated schedule.

Colour is never the only signal; a decorated row also carries a text reason in
its summary cell, per the existing decolorization work
(`docs/work/specs/2026-07-28-schedule-grid-decolorization-design.md`).

## 3. Styling

Inline style objects only, per house convention. `EntityTable`'s own styles
extend `S.th` / `S.td` from `src/styles/shared.js`; new shared toolbar styles
(`S.toolbar`, `S.toolbarButton`, `S.filterChip`, `S.summaryRow`) are added
there rather than defined locally, since every screen will use them. No CSS
files.

## 4. Migration order

One screen per commit, each independently revertable. Ordered by ascending risk
so the contract is proven on simple cases before it meets the complex ones:

1. `CohortsScreen` — simplest; validates the contract.
2. `DaysScreen`
3. `GroupsScreen` — first real beneficiary (volume, and the orphan decoration).
4. `TimeBlocksScreen`
5. `TiersScreen`
6. `ActivitiesScreen` — most columns; exercises filter and column-hiding hardest.
7. `AnchorsScreen`

`ConflictsScreen`, `DeviceManagerScreen`, and the Trash screen from the
trash/history spec are **also** consumers, adopted after the seven.

Stop-and-reassess condition: if any screen needs a `renderRow` escape hatch
beyond cell rendering — a prop that changes toolbar *behaviour* — that is a
signal the contract is wrong. Fix the contract; do not add a flag.

## 5. Testing

`EntityTable` gets its own unit test file, testing the derived-row pipeline
directly since it is pure:

- search matches text columns and resolved ref labels, not raw ids
- filter clauses AND correctly; `is empty` matches null and `''`
- multi-key sort applies keys in insertion order
- group-by puts nulls in a trailing section with the empty label
- summary values compute over the *filtered* rows, not all rows
- toolbar state round-trips through localStorage
- unknown persisted state (a column since renamed) is discarded, not thrown on

Each migrated screen keeps its existing test file passing; where a test asserts
hardcoded row order it is updated to assert the new default sort, not deleted.

## 6. Non-goals

- No inline cell editing in `EntityTable` — screens keep their own edit
  affordances. Editing moves to a detail panel in a later, separate piece of
  work.
- No saved views. The persistence here is one implicit state per screen;
  named/starred views are a separate spec and depend on this one.
- No virtualization. Camp-scale row counts (hundreds at most) do not need it.
- No column resizing.
