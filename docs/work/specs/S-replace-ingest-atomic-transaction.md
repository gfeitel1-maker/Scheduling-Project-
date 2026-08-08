---
title: "Replace-mode ingest runs in one main-process transaction"
document_type: spec
status: approved
created: 2026-08-07
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md, docs/adr/2026-08-03-ingesting-recurring-fixed-events.md]
related_tickets: [docs/work/tickets/T61-replace-ingest-atomic-transaction.md]
archive_when: T61 lands, the ingest suite covers replace-mode rollback, and a real Replace import against a camp with schedule data completes or fails with the camp unchanged
---

# Replace-mode ingest runs in one main-process transaction

## Summary

Today the Import screen's **Replace** mode orchestrates the teardown in the renderer:
`src/screens/ImportScreen.jsx`'s `commit()` issues one IPC call per row across four
schedule-dependent tables, then `anchor_activities`, then every row of the five
REPLACEABLE setup entities, and only then calls `ingestCommit`. There are hundreds of
independent transactions with no atomicity across them. A crash, an FK violation, or a
sync interruption anywhere in that sequence leaves the camp half-erased with no way back
except Trash, row by row. Commit 32ff9d6 had to fix the deletion order by hand, and a
malformed-DB state was still reached during testing.

The fix is to move the whole sequence behind one IPC call that runs inside a single
`db.transaction()` in the main process, exactly as `commitIngest` already does for the
create half.

## Goal

Replace-mode ingest is one atomic operation: either the camp's setup is fully replaced
(old dependents and entities gone, new entities, rules, and fixed events written), or the
camp is byte-for-byte as it was.

## Non-goals

- **No change to Add mode data written.** `ingestCommit` keeps its current entity-creation contract and output. The Add-mode client guard added in this spec (§"Risks considered — HIGH, amendment") is a refusal, not a behaviour change — nothing is written either way on a Client.
- **No change to what Replace deletes.** The entity set is the existing
  `REPLACEABLE = INGESTIBLE_ENTITIES − cohorts` plus the same dependents the renderer
  clears today. Widening the blast radius is a separate decision.
- **No FK schema change.** `ON DELETE NO ACTION` is retained everywhere, per
  `docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md`: a cascade writes no ops, and
  the op log is the replication mechanism. Dependents are cleared in application code.
- **No new delete semantics.** Deletes are ordinary `__deleted__` field ops, so Trash and
  per-record history keep working unchanged.
- **Not a rewrite of `deleteRecord.js`.** Its `expected_slot_count` confirmation contract
  is for single-record deletes the director is shown a count for; Replace has its own
  confirmation in the Import screen and does not reuse that path.
- **Not multi-device coordination.** See "Risks considered — client devices".

## Success predicate

Done when **all** of the following hold:

1. A Replace import on a camp that has schedule data (template slots, overlays, week
   exclusions, fixed events) completes with: zero rows remaining in the REPLACEABLE
   entities from before the import, zero orphaned dependent rows, and the new entities,
   activity rules, and fixed events present.
2. An induced failure at any point after the first delete (test: a throw injected before
   the entity-creation loop, and a throw injected inside it) leaves **every** table
   exactly as it was before the call — verified by row counts and by `operations` table
   length, not by eyeballing the UI.
3. `src/screens/ImportScreen.jsx`'s `commit()` contains **no** delete loop and no
   `localClient.deleteEntity` call; the Replace branch is one awaited IPC call.
4. `PRAGMA foreign_key_check` returns empty after a Replace import against the fixture
   camp.
5. A non-admin token is rejected before any row is touched.
6. `npm run test` and `npm run lint` pass; the ingest suite gains replace-mode cases.
7. A Replace attempted on a device in Client mode is refused with nothing written, and the
   director is told to run it on the main computer. See
   §"Risks considered — HIGH".

### What does NOT count as done

- Wrapping the renderer loop in a try/catch and "cleaning up" on error. Compensating
  deletes are not a rollback.
- A new handler that opens its own nested transaction per step.
- Passing the deletion order as a caller-supplied array. The order is a property of the
  schema and belongs in main-process code, not in a renderer payload.
- Leaving `deleteEntity` reachable from the Replace branch "as a fallback".

## Design

### IPC contract

Extend the existing handler rather than adding a second one, so the create half cannot
drift between two call sites:

```
shoresh:ingest-commit  →  handlers.ingestCommit({
  token,          // string, required
  mode,           // 'add' (default, current behaviour) | 'replace'
  approved,       // { [entity]: string[] }  — unchanged
  links,          // { groups: { [groupName]: unitName } } — unchanged
  cohort_id,      // string | null — unchanged
  fixedEvents,    // [] — unchanged
  activityRules,  // {} — unchanged
})
```

`mode` is the only addition. Anything other than the literal `'replace'` means `'add'`,
so every existing caller (including `src/localClient.mock.js`) keeps working untouched.

**Response, replace mode:**

```
{
  created: { [entity]: number },
  total: number,
  fixedEvents: { created, skipped: [{name, reason}], partial: [{name, reason}] },
  replaced: {
    entities:   { tiers, groups, days_of_operation, time_blocks, activities },  // counts deleted
    dependents: { template_slots, template_overlays,
                  week_activity_exclusions, week_group_exclusions,
                  anchor_activities, day_override_template_slots },             // counts deleted
  }
}
```

`replaced` is absent in add mode. Reporting the counts is not decoration: per ADR §1 an
import never silently omits, and the director needs to see what was destroyed.

**Errors** are thrown, not returned as codes, matching `commitIngest` today. The renderer
already funnels them through `describeWriteFailure`.

### Where the code lives

`electron/ops/ingest.js` gains an exported `replaceScope(db, { camp_id, author_user_id,
device_id })` that appends the delete ops, and `commitIngest` gains a `mode` option that
calls it as the **first statement inside the existing `db.transaction(...)` body** — not
in a second transaction, not before `run()`. better-sqlite3 nests transactions as
savepoints, so the one outer transaction remains the rollback boundary.

Do **not** create a parallel `commitReplace` function. One transaction, one function, one
whitelist — the whitelist guarantee at the top of `ingest.js` is only worth anything if
there is exactly one write path.

### Deletion order (normative — do not rediscover this)

Every step is an ordinary op append (`field: '__deleted__', value: 1`) via `appendOp`, so
each deleted row is restorable from Trash and replicates to peers. `PRAGMA foreign_keys`
is ON, so order is enforced by the database and a wrong order throws.

1. **`template_slots`** — scoped through `schedule_templates` via `template_id`, per
   `PARENT_SCOPED_ENTITIES`. FK note: references `groups(id)`, `activities(id)`; `day_id`/
   `time_block_id` are plain TEXT.
2. **`template_overlays`** — scoped through `schedule_templates` via `template_id`, per
   `PARENT_SCOPED_ENTITIES`. FK note: references `days_of_operation(id)`.
3. **`week_activity_exclusions`** — scoped through `schedule_weeks` via `week_id`, per
   `PARENT_SCOPED_ENTITIES`. FK note: references `activities(id)`.
4. **`week_group_exclusions`** — scoped through `schedule_weeks` via `week_id`, per
   `PARENT_SCOPED_ENTITIES`. FK note: references `groups(id)`.
5. **`day_override_template_slots`** — scoped through `day_override_templates` via
   `day_override_template_id`, per `PARENT_SCOPED_ENTITIES`. `activity_id`/`time_block_id`
   are plain TEXT in `schema.sql` and therefore do not block, but rows left behind point at
   destroyed activities. Delete them. *(New relative to today's renderer code, which misses
   this.)*
6. **`anchor_activities`** — camp-scoped directly (`WHERE camp_id = ?`), not through a
   parent table. FK note: references `days_of_operation(id)`, which is why this step must
   run before step 8.
7. **Null out `activities.weather_alternative_id`** for every activity in the camp, as a
   `weather_alternative_id → null` op, **before** step 8. `schema.sql` declares this
   column as plain TEXT, but `deleteRecord.js` treats it as a blocking self-reference and
   migrated databases (localDb.js v15 `ALTER TABLE`) may carry the real FK. Nulling first
   makes the delete order independent of which schema variant the db is on. *(New; a real
   latent failure in today's path.)*
8. **The REPLACEABLE entities**, in this order: `activities`, `groups`, `time_blocks`,
   `days_of_operation`, `tiers`. `groups.tier_id` is plain TEXT so `tiers` last is a
   tidiness choice, not an FK requirement; `cohorts` is **never** deleted (tiers and time
   blocks reference it and Programs are not part of the import's scope).

Steps 1–6 are enumerated by querying the camp's rows (template ids resolved through
`schedule_templates`, week ids through `schedule_weeks` — the same scoping
`electron/ops/campScopedEntities.js` already encodes). Reuse `PARENT_SCOPED_ENTITIES`
rather than hand-writing the joins.

Immediately after step 8 and still inside the transaction, run
`PRAGMA foreign_key_check` and throw if it returns any row. A violation here means the
clearing step missed a table — the same signal `deleteRecord.js` relies on — and it must
abort the whole import rather than commit a torn camp.

Then the existing entity-creation loop runs, unchanged. Because deletes precede creates
inside one transaction, the `UNIQUE(camp_id, name)` indexes on groups/activities/tiers/
time_blocks are satisfied even when the new names are identical to the old ones.

### Auth

Identical to today: `requireAuthorized(db, { token, action: 'groups.import' })`, which
`electron/auth/permissions.js` grants only via `admin: ['*']` — `groups.import` is
deliberately absent from the staff array. Replace is strictly more destructive than Add,
so it needs no weaker check and must not get one. The check runs **before** the
transaction opens; `token` must be a non-empty string first (`isNonEmptyString`).

No new permission name is introduced. If a future decision wants Replace gated separately
from Add, that is a `groups.import_replace` action added to the matrix — a deliberate
change, not something to invent here.

### Renderer changes

`src/screens/ImportScreen.jsx`'s `commit()`:

- Delete the entire `if (importMode === 'replace' && existingCount > 0) { ... }` block
  (the four dependent loops, the anchors loop, and the REPLACEABLE loop) — roughly
  lines 220–255.
- Pass `mode: importMode === 'replace' ? 'replace' : 'add'` through
  `localClient.ingestCommit`.
- On success, the result banner additionally reports `replaced` counts when present.
- On failure, the existing catch is already correct and its message —
  *"Nothing was imported. Your camp is exactly as it was."* — becomes **true** for the
  first time. That sentence is currently a lie in Replace mode; making it true is the
  point of this ticket.
- The admin-role special case (`/admin role required/i`) stays.

`src/localClient.js`'s `ingestCommit` wrapper gains `mode` (positional args are already
awkward at five parameters — convert to a single options object and update both call
sites and `src/localClient.mock.js`, or append `mode` last; either is acceptable,
the options object is preferred).

`src/localClient.mock.js` must simulate replace mode well enough that the browser dev
server does not diverge from Electron in an obvious way, but persistence and rollback are
verified under Electron only, per CLAUDE.md.

### Testing

Per `TESTING_STANDARD.md` this is a data/migration seam and is test-first. Add to
`electron/ops/ingest.test.js`:

- Replace against a camp with rows in all six dependent tables: all cleared, new entities
  present, `foreign_key_check` empty.
- Replace where an activity has `weather_alternative_id` pointing at another activity.
- **Rollback:** inject a throw after the deletes (e.g. an `activityRules` value that trips
  a constraint, or a stubbed `appendOp` that throws on the Nth call) and assert every
  table's row count and the `operations` row count are identical to before.
- Replace on an empty camp is a no-op teardown followed by a normal create.
- Non-admin token rejected with nothing written.
- `mode` omitted ⇒ byte-identical behaviour to today (regression guard for Add mode).

## Risks considered

Reviewed 2026-08-07 by the Security and Red Hat agents against the real code. One HIGH
finding changed the design (§"Host only" below is now normative and part of the success
predicate); the rest are recorded with their disposition.

### HIGH — Replace on a sync Client silently forks the camp. **Design changed.**

`ingestCommit` (`electron/main.js:234-259`) has **no `mode === 'client'` branch**. It calls
`commitIngest(db, ...)`, which appends every op straight to *this device's* SQLite via
`appendOp` (`electron/ops/ingest.js:231-243`) — it never routes through
`syncClient.write()`. Both other multi-op write paths in this codebase gate on device mode
and say why: `deleteRecordHandler` (`electron/main.js:855-858`) and `restoreEntityHandler`
(`electron/main.js:813-816`), with the reasoning at `electron/ops/deleteRecord.js:28-32` —
*"A Client cannot express a multi-op atomic transaction over `submit_op`."* The Import
screen has no host/client check and is fully reachable on a Client.

Under Add mode this is a pre-existing defect with a small blast radius. Under Replace it is
a data-loss class bug: the whole setup is destroyed and recreated locally with fresh UUIDs,
the Host and peers never see it, and the director gets a success banner.

**Normative addition to the design:** `ingestCommit` refuses `mode: 'replace'` when
`mode === 'client'`, throwing an error the renderer renders as
*"Replace can only be run on the main computer."* Host and standalone proceed as specified.
This is the cheap correct fix consistent with this spec's "no rewrite" scope; a proper
Client→Host `requestReplace` path mirroring `requestDelete` is a separate ticket if it is
ever wanted. Add mode's existing (unguarded) behaviour is **not** changed here — that is
its own pre-existing question, raised separately, and widening this ticket to fix it would
change Add-mode behaviour nobody asked to change.

Added to the success predicate: **(7)** a Replace attempted while `mode === 'client'` is
refused with nothing written, covered by a test.

**Amendment — Add mode also lacks this guard.** The same missing check exists for Add mode
(the Host never sees an Add run on a Client either), and the fix is one more branch in the
same location. T61 adds the guard to **both** `mode === 'replace'` and the unchecked Add
path, with separate test cases for each. The error message for Add mode: *"Import can only
be run on the main computer."*

### MEDIUM-HIGH — pre-Replace schedule snapshots become permanently unrestorable. Accepted, with a warning.

`schedule_snapshots` survives Replace by design, but `.slots`/`.overlays` are JSON blobs of
now-destroyed `group_id`/`activity_id` values (`electron/db/schema.sql:455-466`). Restoring
such a snapshot goes through `bulkReplace` → `INSERT` into `template_slots`, whose
`group_id`/`activity_id` are real FKs (`schema.sql:243-244`), so it throws a bare SQLite
constraint error the director cannot connect to a Replace they ran weeks earlier.

Disposition: deleting the snapshots would be worse (destroying the only record of the old
schedule), and repointing them is impossible — the ids are gone. **Required in this
ticket:** the Replace confirmation in `ImportScreen.jsx` states how many saved versions
exist and that Replace makes them unrestorable, using the existing pre-confirm read. A
friendlier restore-time error message is a follow-up, not this ticket.

### MEDIUM — `PRAGMA foreign_key_check` proves less than the design implied. Wording corrected.

A clean check covers only real FKs. It says nothing about plain-TEXT soft references
(`day_override_template_slots.activity_id`, `template_overlays.unit_id`) or the snapshot
blobs above. The check stays — it is the right backstop for the FK class, and Red Hat
verified the deletion order in §"Deletion order" is **complete against every real FK** in
`schema.sql` and the `localDb.js` migrations. But "a clean check means the camp is
coherent" is false and must not be written into a code comment.

### MEDIUM — transaction size blocks the main process. Perf gate added.

better-sqlite3 transactions are synchronous on the single main-process thread, which also
serves every IPC handler and, in Host mode, the whole `syncServer.js` message loop. A real
Replace target (a camp with a full schedule) is 500–1500+ dependent rows plus the create
half — several times the ~150-op precedent the ingest ADR reasoned from. While it runs, the
UI shows an unprogressed `working` state and connected staff devices see the Host stall.

Disposition: atomicity is worth this, and the alternative (chunking) forfeits the entire
point of the ticket. **Required:** one test on a synthetic large fixture (≈400 groups'
worth of slots) with an explicit wall-clock budget, so a regression is caught by CI rather
than at 8:30pm before evening program.

### MEDIUM — Trash after a Replace. Accepted as-is.

Hundreds of delete rows land in Trash from one action. Restoring one `groups` row from the
old set resurrects bare metadata with a `tier_id` pointing at nothing (rendered as an em
dash, not a crash) and no schedule — `restore.js:33-38` refuses `template_slots` and
friends, and `CHILD_LINKS` (`restore.js:52-62`) only *reports* deleted children. Clutter,
not corruption. No code change in T61; grouping same-action Trash rows in the UI is a
follow-up.

### LOW — Day Override templates survive as empty shells.

Step 5 deletes `day_override_template_slots` but the parent `day_override_templates` rows
survive, so the director later finds a named override with nothing in it. Fold this into
the same Replace confirmation copy as the snapshots warning.

### Security review — no new exposure.

Confirmed against the code: reusing `groups.import` is correct and admin-only via
`admin: ['*']` (`electron/auth/permissions.js:36-49`); all three alternate mutation routes
a non-admin might try — `submit_op`/`write` → `<entity>.delete`, `bulkReplace` →
`<entity>.bulk_replace`, and `deleteRecordHandler` — are **already** admin-only through
default-deny, so the gate on this handler is not moot. No renderer-supplied value
(`mode`, `cohort_id`, `links`, `approved` keys) reaches SQL as anything but a bound
parameter *provided the Maker follows the "reuse `PARENT_SCOPED_ENTITIES`, do not
hand-write joins" instruction* — Code Reviewer should re-check that one point against the
real diff. `replaced` counts leak nothing an admin cannot already read.

Two items raised and **explicitly out of scope**: `authorize()` records audit events only
for `users.*`, so neither Add nor Replace is audited on allow (pre-existing gap); and an
admin token on any device can already destroy camp-wide data through the op log
(pre-existing property of the trusted-LAN model, not widened here). Both belong to the
Architect, not to T61.

### Activity data normalization — min_per_week ≥ 1 for eligible activities

When the engine receives an activity with `min_per_week = 0` (or null) and at least one
eligible group, it schedules that activity zero times — correct, but silently useless. The
observed effect in the dev camp: all Friday slots are `UNFILLABLE` because the imported
activities carry `min_per_week = 0` for Friday-eligible groups; the engine has nothing to
place.

The fix: during the entity-creation pass in `replaceScope` (and in the Add-mode create
pass), after parsing each activity from the approved payload, floor `min_per_week` to `1`
if the activity has any non-empty `eligible_group_ids` and the value is currently `0` or
null. This is a data normalization rule, not a scheduler rule.

**Normative:** applied to both Replace and Add mode, inside `commitIngest` before any op is
appended, so the invariant holds for every import path. A test confirms that an imported
activity with `min_per_week: 0` and eligible groups is stored with `min_per_week: 1`.

### Not adopted

- **A pre-flight dry-run pass before destroying anything.** The transaction rollback
  already gives the guarantee a dry run would, and a dry run introduces a
  time-of-check/time-of-use gap plus a second enumeration that can drift from the real one
  — precisely the drift `deleteRecord.js`'s single `SLOT_QUERY` exists to prevent.
  The one thing a dry run *would* add is a count shown to the director beforehand; that is
  what `existingCount` and the confirmation copy already do.
