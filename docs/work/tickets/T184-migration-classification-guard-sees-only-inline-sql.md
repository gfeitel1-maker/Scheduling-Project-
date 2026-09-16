---
title: "The migration-classification guard saw only inline SQL"
document_type: ticket
status: completed
created: 2026-09-16
resolved_by: [electron/db/migrationWriteTrace.js, electron/db/migrationWriteTrace.test.js, electron/db/migrationDomainState.js]
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
archive_when: the next migration that needs a real domain backfill has landed and the trace guard has been exercised on it
---

# T184 — the migration-classification guard saw only inline SQL

## Finding

`electron/db/migrationDomainState.js` classifies every migration as
domain-state or schema-only, and the startup guard in `electron/main.js`
refuses to sync a document-bearing camp across a domain-state one. That
matters because the Automerge document is authoritative and SQLite is a
projection: a migration that edits domain rows in SQLite alone changes
something the document does not know about, and the next merge's
`projectAll` delete-reconcile undoes it.

The classification was checked against the source by a scan in
`migrationDomainState.test.js` that reads `localDb.js` as TEXT, split at each
migration's own stamp. It therefore saw only SQL written INLINE in a
migration's block. A backfill routed through a HELPER — `backfillLocations(db)`,
which is what v32 is — is a call, and its `UPDATE`/`INSERT` statements live 900
lines away. A future migration that genuinely changed what a camp MEANS,
written as `backfillSomething(db)` rather than as inline SQL, would have read
as schema-only and the guard would have said nothing.

The blind spot was stated in the test rather than hidden, which is why it was
closeable. Found by `gracious-thompson-fa0b1c` while classifying v65.

## What was done

Direction 3 of the three the ticket proposed — measure the effect, not the
spelling — in the form that is both honest and cheap: run the real migration
chain with the `better-sqlite3` handle instrumented, and record every statement
SQLite was actually asked to execute. Indirection cannot hide a statement from
this, because a helper's `db.prepare(...).run()` goes through the same handle
the migration block used.

- `electron/db/migrationWriteTrace.js` — `instrumentDb` (a forwarding Proxy that
  traces executed statements and rows changed), `attributeByMigration`, and
  `domainWritesIn`.
- `electron/db/migrationWriteTrace.test.js` — runs the chain across a fresh
  database, all four era fixtures, and one seeded variant, and fails when a
  version classified schema-only writes a modeled domain table.

Attribution deliberately does NOT use "the version stamped next". That rule
reads plausibly and fails in the direction that matters: a block which stamps
its version and THEN writes would credit those writes to the following
migration, and if that one is domain-state the real offender is excused
silently. The trace is cut instead at each block's opening guard read
(`getSchemaVersion(db) < N`), a boundary no statement can straddle.

The era fixtures are load-bearing and were not sufficient as found. No fixture
sets `activities.location`, so `backfillLocations` short-circuits before
preparing anything and the corpus executed none of v32 — the exact shape the
guard targets would have gone untested. One seeded run
(`activities.location = 'Lower Field'` on the v23 fixture, before migrating)
puts rows in front of it. It is labelled a seeded variant, not passed off as an
era artifact.

## A second blind spot, found during review, and closed too

`camp-schedule-ingestion-3a679b` and `gracious-thompson-fa0b1c` found it while
checking v65 against the new guard, and it is a real hole in the model the first
layer was built on.

A table RECREATE — create a shadow table, `INSERT INTO shadow SELECT ... FROM
real`, drop, rename — destroys and rebuilds every row without SQLite ever being
asked to `UPDATE` or `DELETE` the modeled table, and the statement that carries
the data targets the shadow table both guards deliberately ignore. For a
verbatim copy that reading is correct. But if the SELECT ever TRANSFORMS an
existing column (`SELECT upper(name)`, a recomputed field), that is a domain
change wearing shape-work clothing, and NO statement-level guard can see it —
not the text scan, and not the execution trace either.

The honest answer is to stop reasoning about statements. `traceWithSnapshots` +
`diffByMigration` snapshot every modeled table at each block boundary and
compare the ROWS: a changed value is a changed value however it was spelled, and
a row that vanished is gone whether it was `DELETE`d or dropped along with its
table. Two details keep it quiet enough to be usable:

- Only columns present in BOTH snapshots are compared, so `ALTER TABLE ADD
  COLUMN` — and a recreate that adds one, which is exactly what v65 is — reads
  as no change. A new column cannot have altered a value that did not exist.
- Rows are keyed by `id`, not by rowid, which a recreate reassigns.

Proven both ways, permanently in the suite: a synthesized recreate that rewrites
`name` with `upper(name)` is invisible to both statement guards (asserted) and
caught by the row diff; the same recreate that only adds a computed column
produces no finding. The second test matters as much as the first — a guard that
flagged the v65 shape would be noise, and an author who learns to suppress a
guard has no guard.

There are now three measurements: source text (fast, no fixture needed),
executed statements (sees through indirection), and row content (sees through
spelling entirely). **Their blind spots are nested, not independent, and three
checkmarks are not coverage.** Row content is the strongest and still cannot see
a change that never reaches a row — a column dropped, a table renamed, a
statement that never ran because the fixture lacked data. Raised in review by
`app-icon-audit-a9a598`, and worth keeping in that form: stacking guards is much
better than one guard, and it is not the same thing as completeness.

## What the row diff cannot compare, and why that is now a finding

Reviewing the diff, `app-icon-audit-a9a598` found that a table or column present
before a migration and absent after was silently skipped — it read as
no-change. Two instances were predicted (v64's `ALTER TABLE ... RENAME TO`) and
the column case was described as prospective, with no instance in the history.

**It was not prospective. Three live instances turned up on the first run**, all
previously invisible to every guard:

- **v49 `locations.tile_type`** — the recreate renames `tile_type` to `kind`.
- **v53 `schedule_snapshots.overlays`** — the overlay-stamp retirement ADR.
- **v59 `schedule_snapshots.day_overrides_json`** — T145 retiring day_overrides.

All three are benign on reading. None was being checked.

A vanished table or column now emits `kind: 'unknown'` with a reason. **Unknown
is a finding, not a pass** — the rows could not be compared, which is a
different fact from the rows being unchanged, and treating the two alike is this
repository's recurring defect in its purest form.

Columns are read from the SCHEMA (`table_info`), not inferred from a row, so a
vanished column is reported on an empty table too. The first cut emitted it per
row and therefore only when a fixture happened to hold data — the identical trap
that hid v32, reintroduced one layer up and caught in review.

### The acknowledgement list, and why it is not a suppression list

Automation cannot tell a pure rename from a rename that also transformed values;
only reading the SELECT can. So each unknown is acknowledged ONCE, by version,
**with its reason recorded**, and anything not on the list fails until a human
reads it. This is direction 2 of the three the ticket proposed, applied narrowly
to the one place where the measurement genuinely cannot decide — not as a box
every migration author ticks.

A suppression list is only as honest as its upkeep, so the list is itself
guarded: an entry that nothing produces any more FAILS (a stale acknowledgement
outliving what it acknowledged is how a list grows past the reading behind it),
and every entry must carry a reason long enough to be a reading rather than a
shrug. Both were proven by planting — an acknowledgement removed, and one added
for a version that does not exist — and both go red.

### Why a dropped column is schema-only — the mechanism, not the paperwork

This was drafted as "acknowledged retirements, each backed by its ADR" and that
reasoning was wrong, or at least beside the point. Corrected by
`app-icon-audit-a9a598`, who also measured the input the question needed: both
`schedule_snapshots` and `locations` ARE modeled by the document (27 modeled
entities), which is the opposite of what a quick read might assume.

The classifier asks exactly one question, and it is easy to drift from it into
"is this a big deal":

> Would `projectAll`'s delete-reconcile UNDO this at the next merge?

A merge cannot undo a dropped column, because there is no column left to write
into. The document may carry an orphaned field; the projector cannot resurrect a
column `schema.sql` no longer declares. A domain WRITE is reverted by the next
merge; a shape change is not. So all three are schema-only on the mechanism —
and the next author who retires a feature WITHOUT an ADR must still get the same
answer. "Backed by an ADR" is a fact about process; the classifier is about
mechanism.

**v59 is not in the same class as v49 and v53, and the list no longer pretends
it is.** The document era begins at v57. v49 and v53 sit below it, so no database
reaching them can hold a document at all. v59 is above it — the only one of the
three where document and SQLite coexist across the change. It is still
schema-only by the question above, but it carries a hazard in the OPPOSITE
direction that this guard does not measure and does not claim to: a document
field whose SQLite column is gone is a projection-time failure, not a silent
revert. That was handled deliberately at the time — `GENESIS_B64` was NOT
regenerated and keeps an orphan empty `day_overrides` collection on purpose,
because the module-load guard is a subset check and regenerating would change
the shared document's identity for every existing `.automerge` file. Its
acknowledgement line says so, so the next reader does not tidy the orphan away.

### Acknowledgements expire

The mechanical guards catch a STALE acknowledgement and an EMPTY one. Neither
can catch a WRONG one, and the standing risk is that "acknowledged" quietly
becomes the default action for anything inconvenient.

That is not fully fixable, but it is boundable in time, so each entry records
the hash of its migration's own text in `localDb.js` as it stood when someone
read it. Editing the migration invalidates the reading rather than letting it be
inherited: "someone read this" becomes "someone read THIS". Raised by
`app-icon-audit-a9a598` as a known limit to note; built instead. Proven by
planting a comment-only edit in v53's block and watching the entry expire
(`recorded 46a7891a01b2, now bb982859347f`), then restoring.

Then `app-icon-audit-a9a598` found that the expiry hash had **the same blind
spot this ticket exists to close**, now sitting in the guard-on-the-guard:
`blockHashFor` defines a migration's text POSITIONALLY, from the previous
stamp to this one, and does not follow calls. A migration whose logic lives in a
helper can have that helper rewritten with no change to the hash — the
acknowledgement inherited across a real behavioural change. It does not bite
today (all three entries are inline recreates) and bites the first time someone
acknowledges a version routed through a helper, which is the shape people
demonstrably reach for.

The fix is not a better locator. Following calls to hash them transitively would
re-implement the parsing problem that measuring already solved — the same
mistake in a new place. What it needed instead was an accurate account of which
layer carries the weight, because the weakest of the three was the one written
down:

1. **The key IS the observation.** An entry is keyed by `version table.column` —
   the finding itself, not a label for it. A migration that changes so it drops
   a different column produces a different key, which is unacknowledged, which
   fails. Structural; no hash involved.
2. **The row diff.** A migration that changes so it also transforms or removes a
   value produces a `changed`/`removed` finding, which cannot be acknowledged at
   all. An acknowledgement only ever covers `unknown` — the case where the rows
   could not be compared.
3. **`blockHash`** — a secondary tripwire for an edit that changes the text while
   producing the same observations.

Layers 1 and 2 cover the helper case that layer 3 misses, which is why the
tripwire stays narrow and is now described narrowly. A narrow guard accurately
described is fine; a narrow guard described broadly is the thing this entire
ticket is about.

**What escapes all three is empty by construction, not merely small.** For a
helper edit to slip every layer it would have to keep the same
`version table.column` key (layer 1 silent), produce no `changed`/`removed` in
the row diff (layer 2 silent, and note those cannot be acknowledged at all), and
leave the block's own lines untouched (layer 3 silent). A change satisfying all
three has altered no modeled row's content, added or removed no column, and
renamed nothing — which is the definition of not being a domain change. Worked
through independently by `app-icon-audit-a9a598` on the layering above.

**Name the failure accurately: this was not a missing limit note.** Nothing was
broken and no mechanism was absent — layers 1 and 2 were already load-bearing
and already proven. What was wrong was the ACCOUNT: the weakest of the three was
written down as though it were the guarantee. That is a subtler failure than a
gap and harder to catch, because everything works and only the documentation is
wrong — and documentation is what the next person reasons from. A guard's
description is part of the guard.

The residual limit that remains, stated plainly: nothing here can detect an
acknowledgement that was read carelessly. Only that it was never read, read of a
different version, produced a different observation, or was written without a
reason.

## Proof the guard is non-vacuous

Required by the ticket, and done twice.

1. **Permanent, in the suite.** A test asserts the trace attributes
   `backfillLocations`' writes to `locations` and `activities` to v32, with
   `changes > 0`, AND that the same statements are absent from v32's block in
   the `localDb.js` text. The gap this work closes is a measured fact, not a
   comment that could quietly stop being true.
2. **Planted defect.** `plantedBackfill(db)` — `UPDATE groups SET name = name` —
   called from v60's block, which is classified schema-only. Result: the text
   scanner stayed GREEN at 11/11, and the execution trace went RED on all six
   runs in the corpus, attributed to v60, reporting 0 rows on the fresh database
   and 2 rows on each fixture. The plant was then reverted; `localDb.js` is
   byte-identical to its committed state.

## A real misclassification it found on its first run

**v13 was classified schema-only and is a domain write.** It de-duplicates
`time_blocks` — `DELETE FROM time_blocks WHERE rowid NOT IN (SELECT MIN(rowid)
... GROUP BY camp_id, cohort_id, name)` — before adding
`UNIQUE(camp_id, cohort_id, name)`. That is the same shape as v11, v12, v14 and
v15, all four of which are classified domain-state.

It survived because the text scan looked for `UPDATE` and `INSERT` only. Its
four siblings each pair their delete with a re-point `UPDATE`, so each was
caught by the `UPDATE`; v13 has no foreign key to re-point
(`template_slots.time_block_id` is plain TEXT, not a `REFERENCES` column), so it
deletes and nothing else — and nothing else was what the scan looked for.

Fixed both ways: v13 moved to `DOMAIN_STATE_MIGRATIONS`, and `DELETE FROM` added
to the text scan's write pattern. Removing a row changes what the camp means at
least as much as editing one.

No behavioral risk from the reclassification: v13 is far below v52, so no
document-bearing database (v57+) can cross it. The correction is for the record
and for the rule, not for a live camp.

## Residual limits, stated

- **Coverage is only as good as the fixtures' data.** The trace does not see
  everything; it sees everything that RUNS. v32 is the worked example and it
  bit this work directly: `backfillLocations` returns before preparing a single
  statement when no activity carries a location, no era fixture sets one, and
  the first version of this guard therefore executed none of v32 while reporting
  green — the same defect class one level up, a check that reads clean because
  it never reached the code. A seeded run was added for that reason. The next
  backfill will need the same care.
- Attribution assumes every migration block performs a guard read
  (`getSchemaVersion(db)`) before its first statement. The boundary is keyed on
  the READ, not on the `< N` comparison, which is what makes both of localDb.js's
  guard forms — bare `< N` (23 blocks) and paired `>= N-1 && < N` (38 blocks) —
  work identically. A future block performing no read at all would merge into
  its predecessor's window and be attributed to the wrong version; that property
  is now pinned by a test rather than trusted. Raised in review by
  `app-icon-audit-a9a598`.
- A write reaching SQLite through a handle other than the one passed to
  `initSchema` is outside the trace. Nothing does that today.
- Which TABLE a statement writes is still read from the statement's text. That
  is not the blind spot being closed — a statement's text is the statement.
  What indirection moved was where the text LIVES, and the trace no longer cares.
- The three guards are kept side by side on purpose. Two measurements with
  different blind spots beat either alone, and three beat two.

## The class, for the testing standard

Both of the scanner's gaps surfaced the same way: by planting a defect and
watching a guard that already HAD a non-vacuity check stay green. That check
planted an inline `UPDATE` — the defect the scanner was designed for. It could
only ever prove the tool works on the cases its author already thought of.

**A non-vacuity test that plants only the defect you designed for is not a
non-vacuity test.** Plant the shape the guard cannot see, and if you cannot name
one, that is the finding. This repository's recurring failure is guards that
have never reported a problem; this is the specific habit that produces them.
