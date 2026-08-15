---
title: "Per-week activity and group participation, week duplication, and permanent week delete (Slices 2–3)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-03
depends_on:
  - docs/adr/2026-08-02-schedule-weeks-first-class.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
  - docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
supersedes: []
implementation_state: in-progress
---

# ADR: Per-week activity and group participation, week duplication, and permanent week delete (Slices 2–3)

## Context

Slice 1 (ADR `2026-08-02-schedule-weeks-first-class.md`) introduced `schedule_weeks` (migration v27),
re-scoped `schedule_templates` from camp to week via `UNIQUE(week_id, kind)`, and added the WeekSwitcher.
Groups, tiers, activities, and days remained camp-wide. The engine's `buildSchedule` signature was
unchanged. Slice 1 explicitly deferred per-week entity variance and week lifecycle operations (duplicate,
delete) to later slices.

Product owner direction established three binding constraints for Slices 2 and 3:

- Activities and groups may vary by week. Days never do.
- Variation is expressed in the setup screens as a per-row toggle, not in the schedule grid.
- `buildSchedule`'s signature is unchanged; the screen resolves the week's effective catalog before calling it.

This ADR covers the decisions required to implement that variation, plus the week duplication and
permanent delete operations introduced in Slice 3.

---

## Candidates considered

### Exclude list vs. include list (the reversal)

**Include list (rejected):** A row in a junction table means "this entity runs this week." Zero rows
means "inherit everything." The Architect's initial convergence landed here.

Red Hat correctly reversed this. The defect: a director who turns off every activity for a themed week
produces zero rows — bit-for-bit identical to a week nobody has ever customized. The app would then
silently schedule the entire camp catalog, the inverse of what the director intended, while the
"customized" badge reads "not customized." This is a correctness violation of Article V ("the engine
surfaces conflicts; it never resolves them silently") baked into the specification, not an edge case.

**Exclude list (adopted):** A row means "this entity does NOT run in this week." Absence means it runs.
This eliminates the ambiguity entirely. A never-touched week and a week with every activity turned off
produce distinct states. Storage is smaller for the common case (nothing stored, not N rows). The
toggle UX maps directly: the first OFF click creates the row; clicking ON deletes it. There is no
"enable customization" mode to enable.

| State | Include list (rejected) | Exclude list (adopted) |
|---|---|---|
| Untouched week | 0 rows | 0 rows |
| All activities off | 0 rows — collides with untouched | N rows — distinct |
| Some off | subset rows | rows for the off ones only |
| Storage for common case | seeds N rows on first toggle | stores nothing |

### Duplicate op shape

**Single inline payload op (rejected):** Invent a new op kind carrying the entire duplication as a
single payload. Rejected because `applyProjection` / `applyBulkReplaceProjection` have no such shape,
there is no precedent in `electron/ops/operations.js`, and introducing a new op kind is a sync-layer
contract change with its own risk surface.

**Pure per-row appendOp (rejected):** Fan out every slot and overlay as individual ops. A duplication
can produce hundreds of slot rows. Individual ops can half-arrive under reconnect, producing a
selectable-but-hollow week with partial slots — the exact failure mode the bulk-replace mechanism
was designed to prevent for normal generation runs.

**Mixed routing by existing registration (adopted):** Route each entity through the mechanism it is
already registered for.
- `template_slots` and `template_overlays` are already in `BULK_REPLACE_ENTITIES`. Use
  `appendBulkReplaceOp` against the fresh empty target `template_id` — one atomic op per table,
  the same replication shape a normal `generate()` run already produces.
- `schedule_weeks`, `schedule_templates`, and exclusion rows are low-cardinality with no bulk-replace
  registration. Use ordinary per-row `appendOp`, the same as `createWeek` today.

This is not a compromise — it is correct by construction: each entity type receives the op shape it
was designed for.

### Downgrade contract (Gate B — product owner decision)

**Graceful degradation (rejected by product owner):** Accept that an old build running against a v28+
database would schedule activities the director explicitly excluded for a given week. Recommended by
the Architect as "documented, bounded degradation." The product owner rejected this.

**Hard block (adopted, product owner decision):** An old build must be refused from running against a
v28+ database. The app detects `schema_version` at startup and refuses to open if
`schema_version > KNOWN_VERSION`. The owner's reasoning: silently scheduling excluded activities is
not graceful degradation — it is silent misrepresentation of the director's intent. The correctness
property matters even in a single-user, single-device install where rollback risk is theoretical.

---

## Decision

### Schema (migration v28)

Two new junction tables keyed `(week_id, entity_id)` against the camp-wide catalog:

```sql
CREATE TABLE IF NOT EXISTS week_activity_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  activity_id TEXT NOT NULL REFERENCES activities(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_week_activity_exclusions_week_activity
  ON week_activity_exclusions(week_id, activity_id);

CREATE TABLE IF NOT EXISTS week_group_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  group_id TEXT NOT NULL REFERENCES groups(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_week_group_exclusions_week_group
  ON week_group_exclusions(week_id, group_id);
```

**Semantics, load-bearing and stated once:** A row means "this activity/group does not run in this
week." Absence means it runs. There is no third state.

`CREATE TABLE` statements go in `electron/db/schema.sql` unconditionally, matching how `schedule_weeks`
is handled. Indexes are created only inside the migration block, matching the `idx_schedule_weeks_camp_name`
pattern — `schema.sql` re-executes on every open.

No schema change to `activities` or `groups` themselves. They are not forked per week.

**Migration gate:** `getSchemaVersion(db) >= 27 && < 28`, not a bare `< 28`. See Migration ordering note.

### Required registrations (all four, or the feature silently half-works)

1. `electron/ops/campScopedEntities.js` → `PARENT_SCOPED_ENTITIES`, both tables,
   `parentTable: 'schedule_weeks'`, `parentKey: 'week_id'`.
2. `electron/ops/projections.js` → two `PROJECTIONS` entries, `fields: ['week_id','activity_id']` /
   `['week_id','group_id']`, with `ensureExists` gated on `field === 'week_id'` arriving first,
   mirroring `day_override_template_slots`. Without this, writes silently never materialize.
3. `electron/sync/syncServer.js` → `DOMAIN_PARENT_SCOPED_ENTITIES` (~line 25). This array is
   hand-maintained and is NOT derived from `PARENT_SCOPED_ENTITIES`'s keys, despite
   `campScopedEntities.js`'s own header comment claiming structural guarantee. Registering in
   `campScopedEntities.js` alone makes both tables invisible to first-pairing full sync.
   This pre-existing drift is noted as a separate cleanup (see Consequences).
4. Not added to `RESTORABLE_ENTITIES` or `CLEARABLE_ENTITIES` — an exclusion row is created and
   destroyed by an ordinary toggle, not by the Trash flow.

### Catalog resolution — `weekCatalog.js`

New pure module `src/engine/weekCatalog.js`, co-located with `buildSchedule.js` (no React, no IPC,
unit-testable directly):

```js
export function resolveWeekCatalog({
  groups, activities, anchors, weekId,
  activityExclusions, groupExclusions,
}) → { groups, activities, anchors, suppressedAnchors }
```

- `activities` = camp activities minus those with an exclusion row for `weekId`.
- `groups` = camp groups minus those with an exclusion row for `weekId`.
- `anchors` = camp anchors minus any whose activity or every one of whose groups was excluded.
- `suppressedAnchors` = the anchors that were dropped and why, returned so the screen can surface it.
  Never silently swallowed.

`buildSchedule`'s signature is unchanged. `ScheduleScreen.jsx` resolves once per week load and threads
the resolved arrays into `useGeneration`. The grid is not filtered post-hoc — exclusions constrain what
the generator and setup pickers offer; they never retroactively hide slots already placed.

**Anchor suppression is required, not optional.** `buildSchedule` pre-places anchors as locked slots
before the eligibility pass, without checking whether the anchor's activity is in the `activities`
array passed alongside it. Filtering activities and groups but not anchors lets an excluded activity
reappear, locked, in the generated schedule. `resolveWeekCatalog` filters anchors too and the screen
surfaces `suppressedAnchors` as a visible finding. Dropping them silently would be the
tidiness-over-truth failure Article V forbids.

### Duplicate a week — `duplicateWeek.js`

New host-only module `electron/ops/duplicateWeek.js`, structured like `electron/ops/deleteRecord.js`:
one `db.transaction()`, host only, ops collected and returned for broadcast after commit.

Op routing per entity type (see Candidates considered):
- `template_slots` and `template_overlays` → `appendBulkReplaceOp` against the fresh empty target
  `template_id`.
- `schedule_weeks`, `schedule_templates`, exclusion rows → per-row `appendOp`.

Every id is fresh: `crypto.randomUUID()` for the new week, exclusion rows, slots and overlays;
`deriveScheduleTemplateId(newWeekId, kind)` for each template. No row is aliased between weeks.

Both routes are copied — manual and generated. Neither is canonical (ADR `2026-07-28-plural-candidate-schedules-per-camp.md`), so copying only one would be the app picking a winner.

`schedule_snapshots` are not copied. They are point-in-time history belonging to the source template.
A duplicated week starts with no version history.

**Op ordering:** the new `schedule_weeks` row's ops are appended last, after every template, slot,
overlay, and exclusion row. A client replaying only part of the duplication then does not see a
selectable-but-hollow week in the switcher. Whether the sync layer guarantees strict per-entity seq
ordering across a reconnect is unconfirmed (Gate D — Verifier must confirm before S2-5 is considered
done).

**Idempotent retry:** `client_write_id` idempotency is per-op. A renderer-side timeout-and-retry that
mints fresh ids would produce a second complete duplicate week, not a no-op. Every op in a duplication
derives its `client_write_id` deterministically from the duplication's own identity —
`dup:${sourceWeekId}:${newWeekId}:${entity}:${n}` — with `newWeekId` minted once before the transaction
and reused on retry.

**Duplicate naming:** default `"{sourceName} copy"`, collision-suffixed " (2)", " (3)" etc., matching
`duplicateActivity`'s existing convention.

New IPC: `shoresh:duplicate-week` handler in `electron/main.js` behind `authorize()`, exposed as
`window.shoresh.duplicateWeek` in `electron/preload.js`, mirrored in `src/localClient.mock.js`.

### Permanent delete a week — `deleteWeek.js`

New host-only module `electron/ops/deleteWeek.js`, one transaction, children before parents, routed
through the op-log as tombstone/delete ops. Never a raw SQL DELETE outside the op-log, or it neither
replicates nor audits.

**Cascade order (authoritative), for both the manual and generated template of the week:**

1. `schedule_snapshots` — rows for both templates.
2. `template_overlays` — rows for both templates.
3. `template_slots` — rows for both templates. No FK exists; leaving them is exactly the orphan class
   `removeDayFromWeek` already treats as a defect.
4. `week_activity_exclusions`, `week_group_exclusions` — rows for the week.
5. `conflicts` — any unresolved rows whose `entity_id` is one of the rows deleted above.
6. `schedule_templates` — both rows.
7. `schedule_weeks` — the week row itself, last.

**Not cascaded (stated to prevent omission being mistaken for oversight):**
`day_override_templates` / `day_override_template_slots` are camp-scoped via `camp_id` and have no
relationship to weeks. `operations` is append-only history and is never deleted — that is what makes
the delete auditable.

**Last-week guard:** before anything else, `SELECT COUNT(*) FROM schedule_weeks WHERE camp_id = ?`.
If the week being deleted is the camp's only week, refuse — return `{ error: 'last-week' }`, delete
nothing. This is a data-layer invariant, not a UI nicety. `deriveScheduleTemplateId`, `templateRowFor`,
the WeekSwitcher, and v27's assumption that every camp has ≥1 week all depend on it.
`ScheduleScreen.jsx`'s week resolution falls back to `camp[0]?.id`, which is `undefined` on an empty
array — an unrecoverable state nothing downstream handles. The UI blocks it too, but the guard lives in
the data layer.

**Conflict closure:** unresolved `conflicts` rows pointing at deleted entities must be closed in step 5,
or the conflicts UI shows a conflict about a slot in a week that no longer exists.

**No pre-delete snapshot:** unlike group/day deletion, no automatic snapshot is taken. A snapshot of the
doomed week would point at a `template_id` deleted in the same transaction — orphaned on creation.

**Concurrent delete:** a device mid-edit when another device deletes the week redirects gracefully —
the in-flight edit's op fails to project (parent gone) and the editing screen redirects to another week
with a plain message. Silent failure or a frozen drag is not acceptable.

**Authorization — permanent week delete is ADMIN-ONLY (owner decision, 2026-08-15).** The other week
operations (create, rename, archive/unarchive, duplicate, and per-week activity/group exclusion toggles)
are staff-capable, gated `schedule_weeks.write` and the two `week_*_exclusions.*` grants. Permanent
delete is different in kind: it is non-restorable (`electron/ops/restore.js` refuses every entity the
cascade above touches) and it destroys `schedule_snapshots` wholesale, whose *individual* deletion is
itself admin-only (`src/screens/schedule/useSnapshots.js`). Allowing staff to erase those en masse via
the week delete would contradict that existing invariant, so `deleteWeekHandler` (`electron/main.js`)
authorizes `schedule_weeks.delete` — a verb staff do not hold — and `ScheduleScreen.jsx` withholds
`onDelete` from the WeekSwitcher for non-admins, hiding the "Delete permanently" menu item rather than
presenting a control that would be rejected. This was clarified while fixing a separate `permissions.js`
matrix gap (the multi-week entities `schedule_weeks` / `week_activity_exclusions` / `week_group_exclusions`
were accidentally absent from `permissions.ENTITIES`, so staff were wrongly denied ordinary week
read/write); granting staff `schedule_weeks.write` surfaced the fact that `deleteWeekHandler` had been
gated on `.write`, which — before the matrix gap fix — had made permanent delete unreachable for staff by
accident. The gate above makes admin-only the deliberate, tested state. Boundary pinned in
`electron/auth/authorize.test.js` and `electron/main.test.js`.

---

## Consequences

**Positive:**
- Per-week variation is expressed entirely in setup screens, leaving the schedule grid and engine
  unchanged. `buildSchedule` receives a pre-resolved catalog and remains a pure function with a stable
  signature.
- The exclude-list design is strictly smaller and simpler than the include-list it replaces: the common
  case (no customization) stores nothing, and all-off is unambiguous.
- Duplicate-a-week reuses existing bulk-replace and per-row op shapes with no new op kind.
- Permanent delete is auditable — all mutations route through the op-log.

**Negative / accepted costs:**
- `syncServer.js`'s `DOMAIN_PARENT_SCOPED_ENTITIES` is hand-maintained and not derived from
  `PARENT_SCOPED_ENTITIES`'s keys, despite the code comment claiming they are structurally guaranteed
  to match. This is pre-existing drift this ADR surfaces but does not fix; it is noted as a separate
  cleanup ticket (derive the list from `Object.keys`).
- Anchor suppression adds a UI surface (`suppressedAnchors` banner) that did not exist before. This is
  required, not optional — the alternative is silently scheduling an excluded activity as a locked slot.
- The downgrade hard block means a production install that cannot roll forward (data corruption, etc.)
  is unrecoverable without manual intervention. The product owner accepted this trade.
- Gate D (sync ordering for partial duplication) is unconfirmed. Verifier must confirm strict per-entity
  seq ordering across reconnect before S2-5 is closed; if refuted, `duplicateWeek` needs a completeness
  marker rather than relying on ordering.
- v26 escape hatch deferred knowingly (Gate C). The spec recommended taking it alongside S2-1. The
  product owner accepted deferral for a single-user production install. The coupling risk (a persistently
  failing v26 camp freezes the whole device below all later migrations) is documented here and remains
  unresolved.

---

## Rollback

Migration v28 is additive-only, forward-only per project convention (no down migration is written).

**Downgrade is a hard block** (product owner decision, Gate B): an old build must refuse to open
against a v28+ database. Detection: compare `schema_version` from `getSchemaVersion(db)` against a
compile-time `KNOWN_VERSION` constant at startup. If `schema_version > KNOWN_VERSION`, the app shows
an upgrade-required screen and stops. No data operations proceed.

This reverses Slice 1's rollback story ("non-destructive downgrade is supported"). Slice 1's degradation
was subtractive — extra weeks are invisible but preserved. Per-week exclusions produce a different
failure mode: an old build that cannot see exclusion rows would schedule activities the director
explicitly turned off for that week. Silent misrepresentation of intent is not acceptable degradation
for this app; the hard block is the only correct posture.

If a future slice reintroduces a supported downgrade path, the `KNOWN_VERSION` constant is the
single control point.

---

## Migration ordering note (v27 coupling)

v28 is gated on `getSchemaVersion(db) >= 27 && < 28`, not a bare `< 28`, for the same reason v27 was
gated `>= 26 && < 27`: v26's deferred-retry pattern leaves `MAX(version)` unstamped for a camp whose
snapshot write fails, and a bare `< 28` would let v28 stamp 28 while v27 is still pending for that
camp. Adding the `>= 27` lower bound ensures v28 does not run until v27 has completed for all camps
on the device.

This continues the coupling first documented in ADR `2026-08-02-schedule-weeks-first-class.md`:
every migration after v26 is gated behind v26 completing for all camps on a device. A bounded escape
hatch for persistently failing v26 camps was deferred knowingly (see Consequences).
