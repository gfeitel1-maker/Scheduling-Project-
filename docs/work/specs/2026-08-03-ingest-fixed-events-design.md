---
title: "Inferring recurring fixed events during ingest"
document_type: spec
status: draft
created: 2026-08-03
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-08-03-ingesting-recurring-fixed-events.md]
related_tickets: [docs/work/tickets/T34-ingest-infer-fixed-event-blocks.md]
archive_when: the Maker's change lands, the ingest suite is green with the fixed-events fixture, and a real import proposes a correct fixed event with no template_slots written
---

# Inferring recurring fixed events during ingest

## Summary

A schedule grid encodes more than a list of activity names. Some activities sit at the **same
period every day for a given group or unit** — Mifkad, Lunch, Swim, a staggered `Lunch 1/2/3`.
Today ingest reads "Lunch" only as an activity *name* (an `activities` row); it throws away the
fact that Lunch is *pinned to period X for these groups on every day*. T34 asks ingest to surface
those recurring placements so a director does not rebuild them by hand.

A fixed-event block **is a placement**, and ADR 2026-08-01 §2 deliberately forbade ingest from
writing placements — `INGESTIBLE_ENTITIES` excludes `anchor_activities`. The product owner has
approved **reopening §2** for this one entity: ingest may now **propose** recurring fixed events,
which land as `anchor_activities` (the app's existing "Fixed Event" concept), behind the same
non-skippable read → propose → director-edits → commit preview. The boundary that still holds:
**never** `template_slots`, `template_overlays`, or any other placement. That reopening is recorded
in the companion ADR [`docs/adr/2026-08-03-ingesting-recurring-fixed-events.md`](../../adr/2026-08-03-ingesting-recurring-fixed-events.md),
which is the human-approval gate; this spec is the technical design under it.

**Nothing here changes the schedule engine, adds a table, adds a migration, or touches the
entities-only path for the six existing types.** The one new write surface is a dedicated
`fixedEvents` payload on `commitIngest`, resolved by name and fanned out per day through the
existing op-log. `anchor_activities` is writable by ingest **only** through that one validated path;
the generic `INGESTIBLE_ENTITIES` whitelist is untouched and still rejects `anchor_activities`.

---

## 1. Success predicate and non-goals

**Observable success predicate.** Importing a schedule in which an activity occupies the same period
across a group's operating days produces, in the preview, a **Fixed Events** section listing that
activity as a proposed fixed event — ticked by default when it holds on *every* operating day,
unticked when it holds on a majority but not all. On confirm, each ticked fixed event is written as
`anchor_activities` rows (one per day, cohort-scoped, referencing the real `time_block_id`,
`day_id`, and `group_ids` of rows created-or-existing in the active Program), and **no
`template_slots` row is ever written**.

**Non-goals (explicitly out of scope):**

- No `template_slots`, `template_overlays`, span/overlay inference, or any placement other than
  `anchor_activities`. The whitelist for the generic path is unchanged.
- No engine change. `buildSchedule.js` already pins anchors first and fills around them
  (`src/engine/buildSchedule.js:102-157`); an imported anchor is an ordinary anchor and needs
  nothing new.
- No schema change, no new column, no migration. `anchor_activities` and its projection already
  exist (`electron/db/schema.sql:329-341`, `electron/ops/projections.js:155-167`).
- No editing of a fixed event's block/name/groups *inside the preview* — only tick/untick.
  Refinement happens afterward in the Fixed Events screen, because an imported fixed event is an
  ordinary `anchor_activities` row (see §6).
- No dedup of a proposed fixed event against anchors the camp already holds (see §9 Risks).

---

## 2. Grounded model (verified against the code, not re-derived)

- **`anchor_activities` IS "Fixed Event."** The UI literally labels them "Fixed Event"
  (`AnchorsScreen.jsx`), with Mifkad / Lunch / Swim as examples. Schema
  `electron/db/schema.sql:329-341`. Fields actually used: `name`, `day_id`, `time_block_id`,
  `is_all_groups`, `group_ids`, `notes`. `unit_id` and `span_blocks` are UNUSED legacy columns.
- **Create shape** (`AnchorsScreen.jsx:294-340`): per-day **fan-out** — one row per selected day,
  each its own `uuid`, field-by-field through the op-log. `is_all_groups` serializes to `1/0`,
  `group_ids` to a JSON string, `cohort_id = activeCohort.id`, `camp_id` set. Tiers are resolved to
  concrete `group_ids` before write; a fixed event never stores a tier reference.
- **Serialization** (`AnchorsScreen.jsx:13-20`): `is_all_groups` → `1|0`; `group_ids` →
  `JSON.stringify(value ?? [])`. `operations.value` only accepts strings/null, so the commit path
  must pre-serialize identically.
- **Projection** (`projections.js:155-167`): registered with fields
  `camp_id, cohort_id, day_id, time_block_id, name, is_all_groups, group_ids, notes`. Direct
  camp-scoped (`campScopedEntities.js:23`), cohort-scoped in every view
  (`AnchorsScreen.jsx:238-239` filters on `camp_id` **and** `cohort_id`).
- **Engine** already pins anchors then fills around them (`buildSchedule.js:102-157`). `day_id`
  null = every day, but the UI create path always writes per-day rows and never null — the commit
  path MUST match that (per-day fan-out) for consistency. **No engine change.**
- **Ingest commit today** (`electron/ops/ingest.js`): `commitIngest(db, { approved, links, camp_id,
  cohort_id, author_user_id, device_id })`, one SQLite transaction, `INGESTIBLE_ENTITIES` whitelist
  throws for anything outside the six setup entities.
- **Parser output** (`textGrid.js:275-431`, mirrored by `sheetGrid.js`):
  `{ pages: [{ title, columns, rows, timeColumnLabeled }] }`, each row `{ label, cells }` where
  `label` is the (already `normalizeTimeLabel`'d) period text and `cells[i]` is the text under
  `columns[i]`. **The grid is fully addressable** — every cell carries `(page, column, row)` =
  `(group-or-day, day-or-group, block)`. `extractEntities` simply discards the coordinates and keeps
  the values; this design re-walks the same pages keeping the coordinates.
- **IPC thread**: `localClient.ingestCommit(approved, links, cohort_id)` →
  `preload.js:57` (`ingestCommit: (args) => ipcRenderer.invoke('shoresh:ingest-commit', args)`) →
  `main.js:199` `ingestCommit({ token, approved, links, cohort_id })` (admin gate,
  `action: 'groups.import'`) → `commitIngest(db, {...})`.

---

## 3. Detection algorithm — `src/ingest/fixedEvents.js`

A new **deep, testable unit** kept separate from `extractEntities`. It takes the parsed pages and
the entity proposal and returns a list of proposed fixed events. It touches no database and does no
I/O.

### 3.1 Interface

```js
// src/ingest/fixedEvents.js
/**
 * @param {{ pages: Array }} parsed          the same object passed to extractEntities
 * @param {ReturnType<extractEntities>} proposal   for orientation + group-name identity
 * @returns {{ fixedEvents: ProposedFixedEvent[] }}
 */
export function inferFixedEvents(parsed, proposal) { ... }

// ProposedFixedEvent — every string is BY NAME, exactly as the entity proposal spells it,
// so the commit path can resolve it to a created-or-existing row.
// {
//   name:       string,        // activity text, identical to an entities.activities value
//   time_block: string,        // block label, identical to an entities.time_blocks value
//   days:       string[],      // day names, identical to entities.days_of_operation values
//   scope:      { is_all_groups: true,  groups: null }
//             | { is_all_groups: false, groups: string[] },  // group NAMES, not ids
//   confidence: 'high' | 'low',
// }
```

### 3.2 Name identity is the load-bearing invariant

The commit path resolves a fixed event's `time_block`, `days`, and `groups` **by name** against rows
created-or-existing in the active Program. That only works if `inferFixedEvents` spells those names
**identically** to how `extractEntities` spells the entity rows. The only safe way to guarantee that
is to **share the naming code**, not re-implement it. So this task extracts three tiny naming
helpers from `extractEntities.js` and exports them, with `extractEntities` refactored to call the
same helpers (behaviour-preserving — same output, one source of truth):

- `activityNamesFromCell(cell) → string[]` — the existing `cleanCellValue(cell).split(/\s+[-–—]\s+/)`
  + strip + `isActivityLike` loop (`extractEntities.js:262-274`), lifted verbatim into one function.
- `canonicalDay(text)` — already exists in `extractEntities.js:95-98`; export it.
- `dayNameFromTitle(title) → string|null` — the orientation-B day-from-title logic
  (`extractEntities.js:246-249`), lifted into one function.

Group names carry a short-vs-full ambiguity that only `extractEntities` currently resolves
(`extractEntities.js:284-290`: a group used once keeps its short name, else its full title). Rather
than duplicate that, `extractEntities` returns one new field:

```js
// added to extractEntities' return, derived from data it already computes — NOT new logic:
groupNameByTitle: Object.fromEntries(groups.map((g, i) => [g.title, groupNames[i]])),
```

`inferFixedEvents` maps a page title → final group name through `proposal.groupNameByTitle` for the
days-as-columns orientation. For groups-as-columns, the group name **is** the column text, exactly
as `extractEntities.js:245` uses it — no ambiguity there.

### 3.3 Deriving `(group, day, block, activity)` tuples from both orientations

Reuse `proposal.orientation` (already detected and shown for confirmation — ADR 2026-08-01 §7).

**Orientation A — one page per group, days as columns** (`orientation.columns === 'days'`):
- The page is one **group**: `groupName = proposal.groupNameByTitle[cleanTitle(page.title)]`.
- Each `page.columns[i]` that `isDayName` is a **day**: `day = canonicalDay(columns[i])`.
- Each `row` with a time-shaped `label` is a **block**: `block = row.label.trim()` (the parser has
  already `normalizeTimeLabel`'d it; `extractEntities` treats it as a `time_blocks` value under the
  same `/^\d{1,2}[:.]\d{2}/` test — `extractEntities.js:259`).
- Cell `row.cells[i]` under day-column `i` gives, for each `a ∈ activityNamesFromCell(cell)`, the
  tuple `(groupName, day, block, a)`.

**Orientation B — one page per day, groups as columns** (`orientation.columns === 'groups'`):
- The page is one **day**: `day = dayNameFromTitle(cleanTitle(page.title))` (skip page if null).
- Each `page.columns[i]` is a **group**: `groupName = columns[i]`.
- Blocks and cells exactly as above; cell under group-column `i` gives `(groupName, day, block, a)`.

A group's **operating-day set** is the set of distinct days on which that group appears with any
column/page (orientation A: the day-columns on its page; orientation B: the day-pages carrying its
column). This is the denominator for "majority."

### 3.4 Majority + confidence (mirrors the rare-activity `lowConfidence` split)

For each `(group, block, activity)`, let `occupied` = the number of the group's operating days on
which that activity occupies that block, and `operating` = the size of the group's operating-day set.

```
if (occupied * 2 <= operating)      → drop        // not a strict majority
else if (occupied === operating)    → candidate, confidence = 'high'   // every operating day
else                                → candidate, confidence = 'low'    // majority, not all
```

High-confidence candidates start **ticked**; low-confidence start **unticked** — the same treatment
`preview.js` gives rare entities (`preview.js:107-111`, `ImportScreen.jsx:114-121`). Over-inclusion
is the deliberate bias (ADR 2026-08-01 §1): a wrong fixed event the director unticks costs a moment;
a missing one costs the rebuild this feature exists to remove.

**Denominator is the group's full operating days**, deliberately. A block that structurally runs only
3 of 5 days, solidly filled on all 3, scores `3/5 = 60%` → **low** confidence (surfaced, unticked),
not high. This matches the product owner's wording ("majority of that group's operating days") and
keeps high confidence meaning "literally every day." It never *hides* the candidate; it only decides
the default tick.

### 3.5 Group-scoping — collapse across groups by `(activity, block, day-set)`

Per-group candidates are collapsed on the key `(activity, block, sorted-day-set)`:

- Every collapsed shape whose sharing groups == **all** groups in the proposal →
  `scope = { is_all_groups: true, groups: null }`.
- Otherwise → `scope = { is_all_groups: false, groups: [the sharing groups] }`.
- Combined confidence is `'high'` iff **every** constituent per-group candidate was high, else
  `'low'`.

This over-includes by design, and the director refines later. **A whole unit falls out naturally as
its groups**: if a unit's groups all share a candidate but the whole camp does not, the collapsed
event is scoped to exactly those groups — no unit special-casing, no `tier` reference stored (anchors
hold concrete `group_ids`, matching `AnchorsScreen`).

### 3.6 Staggered variants (Lunch 1/2/3) fall out naturally

`Lunch 1`, `Lunch 2`, `Lunch 3` are distinct activity names, so they produce distinct
`(activity, block, day-set)` shapes and therefore distinct fixed events — one per group-set. Even a
single name "Lunch" pinned to different blocks for different groups yields distinct
`(block, day-set)` shapes and therefore separate events. **No special-casing** — the collapse key
does the work, exactly as the ticket's option "three, not one" intends.

### 3.7 Worked shape (illustrative)

Given a camp with groups {A, B, C}, operating Mon–Fri:

| Signal in the grid | Detected fixed event |
|---|---|
| Mifkad in block 8:30 for A, B, C every day | `{name:'Mifkad', block:'8:30-8:45', days:[Mon..Fri], scope:{is_all_groups:true}, confidence:'high'}` |
| Lunch in 12:00 for A,B every day; Lunch in 12:30 for C every day | two events: `Lunch@12:00 {A,B} high`, `Lunch@12:30 {C} high` (staggered) |
| Swim in 2:00 for A on 3 of 5 days | `{name:'Swim', block:'2:00-2:45', days:[Mon,Wed,Fri], scope:{groups:['A']}, confidence:'low'}` (unticked) |
| Free Play in 3:00 for A on 2 of 5 days | dropped (not a majority) |

---

## 4. Preview surface

### 4.1 What changes in `ImportScreen.jsx`

- `readFiles` computes `const { fixedEvents } = inferFixedEvents({ pages }, proposal)` right after
  `extractEntities`, and stores it in state (`fixedEvents`).
- Initial tick state mirrors the entity path: `chosenFixedEvents = new Set(fixedEvents.filter(fe =>
  fe.confidence === 'high'))` (default-tick high, leave low unticked). A per-event key
  `fixedEventKey(fe) = \`${fe.name} ${fe.time_block} ${fe.days.join(',')}\`` identifies a
  row for tick toggling.
- A new **"Fixed Events"** section renders below the six entity sections and above keep-vs-replace.
  Each event is a tick chip showing `name` + a scope/day hint, e.g.
  *"Mifkad · 8:30–8:45 · every group · every day"* or *"Swim · 2:00–2:45 · Group A · Mon, Wed, Fri"*.
  Low-confidence events carry the same "appeared on some days, not all — tick if this is really
  fixed" helper line the rare-entity section uses.
- On `commit`, the ticked fixed events are mapped to the payload and passed as the new 4th argument
  (§5). Unticked events are simply not sent.

### 4.2 Editing depth is tick/untick only — and why that is correct

A director may **tick or untick** a proposed fixed event in the preview; they may **not** edit its
block, groups, name, or days there. This is deliberate and consistent with how the entity preview
already works: the six entity sections are also tick-only, and correction happens on the destination
setup screen after import. A fixed event is an **ordinary `anchor_activities` row** — the moment it
lands, the full-fidelity editor for it already exists in the Fixed Events screen (`AnchorsScreen`),
where block/groups/name/days are all editable with validation the preview cannot replicate. Building
a second, weaker anchor editor inside the preview would duplicate that surface and violate the
"smallest responsible change" rule. The preview's job is *approval*, not *authoring*.

### 4.3 What `preview.js` adds

`preview.js` owns entity duplicate-detection, which does not apply to fixed events in this iteration
(§9). The only shared concern — *what starts ticked* — is carried on the `confidence` field of each
`ProposedFixedEvent`, so `ImportScreen` derives the initial fixed-event ticks with the exact idiom it
already uses for entities (`ImportScreen.jsx:114-121`). **`preview.js` needs no structural change**;
the default-tick rule lives in the same place, expressed the same way, for both entities and fixed
events. (If a future iteration adds anchor dedup, `preview.js` is where it belongs — see §9.)

---

## 5. Commit — the one new write surface

### 5.1 Threading the payload (minimal IPC change)

```
localClient.ingestCommit(approved, links, cohort_id, fixedEvents)          // + 4th arg
  → shoresh.ingestCommit({ token, approved, links, cohort_id, fixedEvents })
  → preload.js:57  (unchanged — it already forwards the whole args object)
  → main.js ingestCommit({ token, approved, links, cohort_id, fixedEvents })  // destructure + pass
  → commitIngest(db, { approved, links, camp_id, cohort_id, author_user_id, device_id, fixedEvents })
```

The admin gate (`requireAuthorized`, `action: 'groups.import'`, `main.js:205`) is unchanged and
still guards the whole import. `fixedEvents` defaults to `[]` so every existing caller/test is
unaffected.

### 5.2 `commitIngest` — dedicated fixed-events branch, inside the same transaction

`fixedEvents` is a **dedicated parameter**, NOT a key in `approved`. The whitelist loop
(`ingest.js:98-102`) is untouched and still throws for any non-whitelisted `approved` key —
`anchor_activities` remains un-ingestible through the generic path. The fixed-events branch runs
**after** the six-entity loop, **inside the same `db.transaction`**, so the whole import is still one
atomic unit (ADR 2026-08-01 §4).

Name→id maps are built exactly as `tierIdByName` already is (`ingest.js:117-122`): seeded from rows
that already exist in scope, then extended with rows created this run. Seeding from existing rows is
essential — a block that was a *skipped duplicate* (not created) still resolves to the row already in
the camp.

```js
// after the entity loop, still inside run():

// time_blocks are cohort-scoped; seed only this Program's blocks, plus ones created this run.
const blockIdByName = new Map()   // normalizeName(name) -> id
//   seed: SELECT id, name FROM time_blocks WHERE camp_id=? AND (cohort_id ?? null)===(cohort_id ?? null)
//   extend: when the entity loop creates a time_blocks row, blockIdByName.set(normalizeName(name), id)
// days_of_operation and groups are camp-scoped; seed all in camp, extend on creation.
const dayIdByName   = new Map()   // normalizeName(label) -> id
const groupIdByName = new Map()   // normalizeName(name)  -> id

const fixedCreated = []
const fixedSkipped = []           // { name, reason } — surfaced, never silent (ADR §1)

for (const fe of Array.isArray(fixedEvents) ? fixedEvents : []) {
  const tbId   = blockIdByName.get(normalizeName(fe.time_block))
  const dayIds = (fe.days ?? []).map(d => dayIdByName.get(normalizeName(d))).filter(Boolean)
  if (!tbId || dayIds.length === 0) {
    fixedSkipped.push({ name: fe.name, reason: 'time block or day not created' })
    continue
  }
  const isAll = fe.scope?.is_all_groups ? 1 : 0
  let groupIds = []
  if (!isAll) {
    groupIds = (fe.scope?.groups ?? []).map(g => groupIdByName.get(normalizeName(g))).filter(Boolean)
    if (groupIds.length === 0) {
      fixedSkipped.push({ name: fe.name, reason: 'groups not created' })
      continue
    }
  }
  // Per-day fan-out — one anchor_activities row per resolved day, own uuid (matches AnchorsScreen).
  for (const dayId of dayIds) {
    const anchorId = randomUUID()
    const fields = {
      camp_id, cohort_id, day_id: dayId, time_block_id: tbId,
      name: String(fe.name ?? '').trim(),
      is_all_groups: isAll,                                   // 1|0
      group_ids: JSON.stringify(isAll ? [] : groupIds),        // JSON string, matches serializeFieldValue
    }
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue
      appendOp(db, {
        entity: 'anchor_activities', entity_id: anchorId, field, value,
        author_user_id: author_user_id ?? null, device_id,
        parent_op_id: null, client_write_id: randomUUID(),
      })
    }
    fixedCreated.push(anchorId)
  }
}
```

Return shape is extended additively:

```js
return { created, total, fixedEvents: { created: fixedCreated.length, skipped: fixedSkipped } }
```

`normalizeName` is the existing `preview.js` helper (`trim().toLowerCase().replace(/\s+/g,' ')`) —
reuse it so map keys match the same equality the dup-check uses. It handles time-labels like
`9:50-10:25` (lowercase is a no-op on digits; space-collapse is safe).

### 5.3 Validation: skip-and-report an unresolvable event, do NOT abort the import

**Decision: an individual fixed event that cannot resolve its block/day/groups is SKIPPED and
reported in the result; it does not roll back the transaction.**

This is reachable and legitimate: the director may untick the underlying time block (or choose
*Replace*, or the block was never proposed) while leaving the fixed event ticked. That is a director
edit, not an error. ADR 2026-08-01 §4's atomicity guarantee — "no camp is ever left half-populated" —
is about the *transaction* committing or rolling back as one unit; it still does. Skipping one
derived convenience placement **before** writing it is a filtering decision within that single
transaction, not a partial write. Aborting the entire import (entities included) over one unticked
block would be a wildly disproportionate blast radius and would itself violate the "surface, don't
silently absorb" spirit — so instead the skip is **surfaced** in `result.fixedEvents.skipped` and
shown to the director (ADR 2026-08-01 §1: nothing hidden). A genuine failure (constraint violation,
disk error) still throws from `appendOp` and rolls the whole import back exactly as today.

Rejected alternative — *hard error on any unresolvable event*: cleaner-looking, but couples the
survival of the entire import to a single derived row the director may have deliberately excluded.
Rejected.

### 5.4 `ImportScreen` result copy

The success banner reports fixed events alongside records:
*"Imported N records, including M fixed events."* If `result.fixedEvents.skipped` is non-empty:
*"K fixed events couldn't be created because their time block or groups weren't imported — you can
add them on the Fixed Events screen."* — never a silent drop.

---

## 6. Why the destination editor already exists (no new authoring surface)

An imported fixed event is byte-for-byte an ordinary `anchor_activities` row: same fields, same
projection, same cohort scoping, same `camp_id`/`cohort_id` filter on read. It appears in the Fixed
Events screen immediately (`AnchorsScreen.jsx:238-239`), fully editable (block, groups, name, days),
deletable, and Trash-restorable through the existing paths. This is what lets the preview stay
tick-only (§4.2) and what makes rollback trivial (§8): there is nothing bespoke to maintain.

---

## 7. Regression and safety (invariants this change must preserve)

1. **Entities-only path unchanged.** `INGESTIBLE_ENTITIES` is untouched; the whitelist loop still
   throws for `anchor_activities` (and everything else) in `approved`. A test asserts
   `commitIngest` rejects `approved.anchor_activities`.
2. **One transaction.** The fixed-events branch runs inside the existing `db.transaction` — the
   whole import is atomic (ADR §4). A test injects a mid-commit failure and asserts zero rows of
   both entities and anchors.
3. **Preview non-skippable.** No new path writes anchors without a preview tick (ADR §1). Fixed
   events default-tick high / untick low, but every one is shown and the director confirms.
4. **No `template_slots`, ever.** The standing ADR guarantee (2026-08-01 completion evidence #2) is
   extended: a test asserts that after a commit that *creates a fixed event*, `template_slots` is
   still empty.
5. **No engine change.** `buildSchedule.js` is not modified; imported anchors are ordinary anchors.
6. **No schema change / no migration.** `anchor_activities` and its projection pre-exist; a test
   confirms fresh-vs-migrated equivalence is untouched.
7. **Cohort scoping.** Written anchors carry `cohort_id = active Program` and camp `camp_id`, so
   they are visible in the Fixed Events screen (the T33 failure mode does not recur).

---

## 8. Migration / rollback

**No schema change and therefore no migration** — identical to ADR 2026-08-01 §3. The
`anchor_activities` table, its columns, and its projection all exist today.

**Rollback plan:** remove the code. Every anchor the feature created is an ordinary record; the
existing delete path removes it and Trash restores it (ADR 2026-08-01 §4). There is nothing to roll
back at the schema level. Withdrawing the feature leaves any already-imported anchors valid and
editable.

**Op-log cost.** A fixed event writes ~6 fields × (days in its day-set) ops. A camp with a handful
of all-day, all-group anchors adds on the order of tens of ops to an import already writing a few
hundred (ADR 2026-08-01 §4) — bounded and countable, same order as today.

---

## 9. Risks and open items (flagged, not silently resolved)

- **No anchor dedup on re-import.** Unlike entities, a proposed fixed event is not checked against
  anchors the camp already holds, so importing the same file twice would create duplicate anchors.
  The director removes duplicates from the Fixed Events screen (Trash-recoverable). Recommended
  follow-up: a name+block+day+scope dup-check in `preview.js` if this bites; deliberately out of
  scope here because the product owner's approved design is tick-only and did not request dedup.
- **Replace mode leaves old anchors.** `REPLACEABLE = INGESTIBLE_ENTITIES \ cohorts`
  (`ImportScreen.jsx:51`) does not include `anchor_activities`, so *Replace* clears entities but not
  existing anchors — a director who replaces setup could keep anchors that now reference Trashed
  blocks. Recommendation: leave anchors untouched in this iteration (smallest change; anchor
  deletion is director-controlled and recoverable) and note it. Flag for Governor if the product
  owner wants Replace to also clear anchors.
- **Group-name identity across orientations.** The correctness of by-name resolution rests on
  `inferFixedEvents` and `extractEntities` sharing the naming helpers (§3.2). The extraction of
  those helpers is behaviour-preserving and must be covered by the existing `extractEntities` tests
  plus a new equality assertion (§10).

---

## 10. Test strategy

**Unit — `test/fixedEvents.test.js` (new), against a fabricated fixture** exhibiting all four cases:

- *All-days, all-groups*: an activity in one block for every group every day → one event,
  `is_all_groups:true`, `confidence:'high'`.
- *All-days, one group*: activity every operating day for a single group → `confidence:'high'`,
  `scope.groups:[that group]`.
- *Partial (majority-not-all)*: activity on 3 of 5 operating days → `confidence:'low'`.
- *Staggered*: `Lunch 1`@block-P for {A,B}, `Lunch 2`@block-Q for {C} → two distinct events.
- *Below majority*: activity on 2 of 5 days → **not** proposed (dropped).
- Run the fixture in **both** orientations (days-as-columns and groups-as-columns transpose) and
  assert identical `fixedEvents` output — the transpose invariant.
- Assert every emitted `name`/`time_block`/`day`/group name is present verbatim in the paired
  `extractEntities` proposal (the name-identity invariant, §3.2).

**Unit — `test/ingest.test.js` (extend):**

- `commitIngest` with a `fixedEvents` payload writes `anchor_activities` rows that are cohort-scoped
  (`cohort_id` = the passed Program) and reference **real** `time_block_id` / `day_id` / `group_ids`
  of rows created in the same commit; per-day fan-out produces exactly `days.length` rows per event.
- A fixed event whose block was **not** in `approved.time_blocks` is skipped and appears in
  `result.fixedEvents.skipped`, while the rest of the import still commits.
- The whitelist still rejects `approved.anchor_activities` (unchanged guarantee).
- **No `template_slots`**: after a commit that creates a fixed event, `SELECT COUNT(*) FROM
  template_slots` is 0.
- Atomicity: a forced failure inside the fixed-events branch rolls back both entities and anchors.

**Integration — extend the existing no-`template_slots` scenario (ADR 2026-08-01 completion evidence
#2, "scenario 21") or add "scenario 22":** an end-to-end import of a grid with a recurring block
produces a fixed event (an `anchor_activities` row visible under the active Program) and **zero**
`template_slots` rows.

---

## 11. Implementation plan (ordered, for the Maker)

1. **Refactor `src/ingest/extractEntities.js` (behaviour-preserving).** Extract and `export`:
   `activityNamesFromCell(cell)` (from the cell loop, lines ~262-274), `canonicalDay` (already
   defined — add `export`), `dayNameFromTitle(title)` (from lines ~246-249). Rewrite the inline
   sites to call them. Add `groupNameByTitle` to the returned object. Run the existing
   `extractEntities` tests — output must be identical.
2. **Add `src/ingest/fixedEvents.js`.** Implement `inferFixedEvents(parsed, proposal)` per §3
   (flatten to tuples using the shared helpers + `proposal.groupNameByTitle`, majority+confidence
   split, collapse by `(activity, block, day-set)`). No DB, no I/O.
3. **Write `test/fixedEvents.test.js`** (§10) and get it green before touching the commit path.
4. **Extend `commitIngest` (`electron/ops/ingest.js`).** Add `fixedEvents = []` to the signature;
   after the entity loop and inside the transaction, build `blockIdByName` / `dayIdByName` /
   `groupIdByName` (seed from scope + extend on creation), then the resolve/fan-out/skip loop (§5.2).
   Extend the return with `fixedEvents: { created, skipped }`. Import `normalizeName` from
   `preview.js` (or lift it to a shared module if a cycle appears).
5. **Thread the IPC arg.** `main.js` `ingestCommit`: destructure `fixedEvents`, pass to
   `commitIngest`. `localClient.js`: add the 4th arg. `preload.js` needs no change.
6. **Extend `test/ingest.test.js`** (§10): cohort-scoping, real-id resolution, per-day fan-out,
   skip-and-report, whitelist-still-rejects, no-`template_slots`, atomicity.
7. **`src/screens/ImportScreen.jsx`.** Compute + store `fixedEvents`; add `chosenFixedEvents` state
   default-ticking high confidence; render the Fixed Events section (tick chips + low-confidence
   helper); pass ticked events as the 4th `ingestCommit` arg; extend the result banner (§5.4).
8. **Integration scenario** (§10): assert a fixed event is created and no `template_slots` row
   appears.
9. Run `npm run verify` (lint + test + `check:governance`) and the ingest suite.

---

## 12. Do NOT change

- `INGESTIBLE_ENTITIES` (either copy — `ingest.js:23`, `extractEntities.js:22`) or the whitelist
  loop. `anchor_activities` stays out of the generic path.
- `src/engine/buildSchedule.js` — no engine change.
- `electron/db/schema.sql` / `electron/ops/projections.js` — no schema/projection change;
  `anchor_activities` is already registered.
- The `template_slots` / `template_overlays` boundary — never written by ingest.
- The preview's non-skippable read → propose → edit → commit shape (ADR 2026-08-01 §1).
- The six-entity duplicate rule and skip-reporting in `preview.js` (ADR 2026-08-01 §5).
