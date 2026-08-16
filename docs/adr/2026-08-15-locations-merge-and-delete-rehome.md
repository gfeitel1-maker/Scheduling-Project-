---
title: "ADR: Locations near-duplicate merge + re-homed delete primitive + migration-journal read path (M3c)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-15
deciders: [product-owner]
task_class: database-sync
implementation_state: implemented
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md]
related_adrs:
  - docs/adr/2026-08-15-camp-locations-entity.md
  - docs/adr/2026-08-15-locations-concurrent-create-collision.md
  - docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  - docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
supersedes: []
affects: []
---

# ADR: Locations merge + delete re-home + migration-journal read path (M3c)

**Status: PROPOSED — awaiting owner/Governor approval before Maker implements.** This is the DATA-layer
design beneath an already-owner-approved UX (`docs/work/specs/2026-08-15-m3-locations-design.md` §3,
`m3-mockup.html`): a first-run review region and a blocking near-duplicate merge gate. It designs the
merge operation, re-homes the M3a delete primitive per the standing Governor commitment, and adds the
journal read path. It builds **on** ADR #68 (concurrent-create collision) and the v32 ADR — it does not
re-litigate either.

## Context

Three loose ends converge at M3c, the last locations slice:

1. **The merge.** The v32 migration's `TRIM`-only/case-sensitive dedupe left `"Pool"`/`"pool"` as two
   real `locations` rows with independent capacity pools (`localDb.js:1575-1597`, `backfillLocations`).
   Capacity is now a *trusted* engine input (M2), so the split silently under-enforces it. The owner-
   approved fix is a blocking first-run gate that **merges** the two: re-point every activity on the
   loser to the winner, set the winner's capacity, delete the loser — reversibly.

2. **The M3a delete primitive is bespoke and non-atomic.** M3a shipped location delete as in-screen
   renderer code (`LocationsScreen.jsx:34-37, 220-247`): read activities, `writeFields('activities',
   …, {location_id: null})` one by one, then `deleteEntity('locations', …)`. Red Hat found it data-safe
   (op-logged, delete-last, fails safe) but **not atomic** — a crash between the unbinds and the delete
   leaves a partially-unbound place. Governor accepted it for M3a on an explicit commitment: **re-home
   this primitive into the host delete path at M3c**, where the merge is its second concrete consumer
   (`2026-08-15-locations-m3a-setup-screen.md:89, 115`).

3. **The journal has no read path.** `location_migration_reviews` is created and populated by the v32
   migration (`localDb.js:1462-1472, 1493-1598`), is **host-local / never replicated**, and lives on
   every device that ran the migration over real free-text activity data. No IPC/preload/localClient
   method reads it. The M3 review region cannot render without one.

The host delete path already exists and is the right home: `electron/ops/deleteRecord.js` runs a single
`db.transaction()` that clears soft references and then deletes the parent, returns the ops (broadcast
after commit), and is reached identically by a Host (`main.js:998-1022`) or a Client (`syncClient.js`
`requestDelete` → `syncServer.js:837-882` `handleDeleteRecordRequest` → same `deleteRecord`). Merge is
that exact shape with **"re-point to winner" substituted for "clear to null."**

## Candidate approaches considered

Divergence over the merge-operation shape (the one genuinely open structural question; the journal read
path and the delete re-home are near-determined by the standing commitments above).

- **A — Extend `deleteRecord.js` with a `reassign_to` parameter; ONE host-atomic primitive serves both
  single-delete (clear→null) and merge (clear→winner). ★ CHOSEN.** Key assumption: merge *is* a delete
  whose reference-clearing step re-points instead of nulls. Directly honors the M3a commitment (one
  primitive, both consumers), reuses the transaction/broadcast/Client-routing machinery unchanged, and
  needs no new op-log primitive.
- **B — A separate `mergeLocations.js` host op, structurally parallel to `deleteRecord.js`.** Rejected:
  duplicates the whole transaction + broadcast + Client-WS scaffold for a difference of one word
  (null vs winner-id) in the clear step. This is the "duplicated durable version" Code Reviewer's M3a
  merge-gate condition and `ARCHITECTURE_STANDARD.md` §9 both forbid; it also leaves two delete-shaped
  primitives to keep in sync.
- **C — Merge in the renderer (extend M3a's bespoke flow: re-point in JS, then `deleteEntity`).**
  Rejected outright: it *re-commits* the exact non-atomicity the M3a commitment exists to remove, now on
  a multi-activity re-point where a partial failure is worse (some activities on winner, some on loser,
  loser deleted). The task brief names this as "what does not count as done."
- **D — Model merge as an `op_conflict` / deterministic auto-dedupe (the #68 machinery).** Rejected —
  #68 already decided this. Its option (b) rejected a generalized silent merge; near-duplicate merge is
  a **human judgment call under Art. V** on two *already-existing* rows with *different* names, not a
  write-time collision on one name. Different problem, different layer, correctly kept separate
  (#68 "M3c coordination note").

## Decision

### D1 — The merge is `deleteRecord.js` with a `reassign_to` winner (one primitive, host-atomic)

`locations` joins `CLEARABLE_ENTITIES`. The shared primitive gains one optional input:

- **`deleteRecord(db, { entity, entity_id, expected_ref_count, reassign_to, winner_capacity, … })`.**
  - `reassign_to` **absent** → plain delete: the reference-clearing step writes `location_id = null`
    (this is M3a's single-delete, now host-atomic).
  - `reassign_to` **present** (a winner `locations.id`) → merge: the clearing step writes
    `location_id = reassign_to`; if `winner_capacity` is provided, one additional
    `locations`/`capacity` op is emitted onto the winner; then the loser (`entity_id`) is deleted.

**Locations get their own non-destructive branch inside `deleteRecord`, bypassing the schedule-slot
machinery.** The existing three clearable entities (`groups`, `activities`, `days_of_operation`) clear
`template_slots` rows that a real FK (`ON DELETE NO ACTION`) would otherwise block
(`deleteRecord.js:5-32`). **Locations have no such blocker** — `activities.location_id` and
`week_location_exclusions.location_id` are both no-FK convention references (`schema.sql:291, 604`,
matching `weather_alternative_id`). So a location DELETE never fails on SQLite; the clearing step exists
to prevent **dangling references**, not to unblock the delete. Locations therefore behave like the
`activities` case (clear a column, keep the referrers' shape), **never** like `groups`/`days`
(no route snapshot, `DESTRUCTIVE` unchanged, no `writeRouteSnapshot`, no `routesFor`/`SLOT_QUERY`).

**Ordering inside the one transaction (fixed, load-bearing, mirrors the existing contract
`deleteRecord.js:254-259`):**

```
re-count references (abort on drift)
  → re-point/clear activities.location_id  (one op per bound activity)
  → re-point/clear week_location_exclusions.location_id
  → [merge only] winner.capacity op
  → delete loser (DELETE_FIELD, LAST — highest seq, broadcast last)
```

The loser delete is last so a peer replaying in seq order has already moved the references before the
row disappears (the same invariant the existing module relies on). The ops are returned, not broadcast
from inside the transaction; the caller broadcasts after commit.

**`week_location_exclusions`.** Handle them in the same transaction: on merge, re-point
`location_id → winner`; on single-delete, delete them. **Currently zero rows are reachable** (the M5
exclusion UI is not built), but leaving them unhandled is a latent dangling-ref once M5 ships, and the
cost to include is one query — decided here rather than deferred. A re-point that duplicates an existing
`(week_id, winner)` exclusion is harmless (the engine reads presence, not count); no dedup required.

**`expected_ref_count`** reuses the existing `expected_slot_count` count-drift guard verbatim
(`deleteRecord.js:276-278`): the number of bound activities the director was shown, re-counted inside
the transaction, **abort on mismatch** — a peer may bind an activity between preview and confirm, and a
count nobody agreed to is not a count. For merge the drift guard is defense-in-depth; keep it identical
to avoid a second code path.

**Undo payload.** The result returns the list of re-pointed activity ids (alongside the existing
`cleared`/`name` fields). This is what the spec's "immediate Undo affordance" (§3.1) consumes: the
renderer can re-point exactly those activities back to the loser after a Trash restore. Trash restore
alone brings back only the empty place (see D4); the returned id list is what makes a *full* undo
possible without persisting anything.

### D2 — `locations` joins `CLEARABLE_ENTITIES`; the M3a bespoke delete is replaced by the host path

Yes. Both consumers now exist, so `ARCHITECTURE_STANDARD.md` §9 is satisfied and the M3a commitment is
discharged. `CLEARABLE_ENTITIES` becomes `{groups, activities, days_of_operation, locations}`.

`previewDelete` gains a locations branch returning `{ ok, entity, name, ref_count, activities:[{id,
name, max_groups_per_slot}] }` (bound-activity count + the rows, for the dialog copy and for D5's
activity naming) — not the `routes`/`slot_count`/`unprotected_count` shape, which is schedule-specific.

**LocationsScreen's delete changes** (it does not "transparently take over" — `deleteEntity` does not
clear references, so the screen must route through the host path or it reintroduces dangling refs):
`boundActivities` + per-activity `writeFields(null)` + `deleteEntity` (`LocationsScreen.jsx:34-37,
220-247`) is **removed**, replaced by `localClient.previewDelete('locations', id)` →
`DeleteRecordDialog` → `localClient.deleteRecord({entity:'locations', entity_id, expected_ref_count})`
— the same flow Days/Activities already use (unified by #67). The renderer no longer mutates
`activities.location_id` itself; the host transaction owns it.

### D3 — The journal read path is a plain host-local read, outside every sync/projection registry

New IPC `listMigrationReviews(token)`:

- **`electron/main.js`** handler: gated `requireAuthorized(db, { token, action: 'locations.read' })`
  (staff may read locations; this is location-review data). Reads **the calling device's own local
  DB directly** — it is **not routed to the Host** like delete/restore, because the journal is
  per-device and host-local. Guard the table's absence: `SELECT name FROM sqlite_master WHERE type=
  'table' AND name='location_migration_reviews'` → empty result → return `[]`, no error (a device that
  paired into an already-v32 camp has no journal; §3.3 of the spec is a correctness requirement). Filter
  by the singleton camp; parse `detail` JSON per row.
- **`electron/preload.js`**: `listMigrationReviews: (token) => ipcRenderer.invoke('shoresh:list-migration-reviews', { token })`.
- **`src/localClient.js`**: thin passthrough.
- **`src/localClient.mock.js`**: the mock twin (dev `:5200`). Returns `[]` by default (the mock has no
  journal), or a small seeded fixture for the review-region UI. Required by `ipcSurfaceParity.test.js`
  — the method must exist on both surfaces.

**It participates in NO op-log/sync machinery** — not `PROJECTIONS`, not `DIRECT_CAMP_ENTITIES`, not the
snapshot tables, not `list()`. Confirmed: the journal is created inside the migration, never in a sync
registry, "recomputed identically on every device, never replicated" (`localDb.js:1456-1461`; the v32
ADR "Sync" section makes locations replicated but says nothing puts the *journal* in a registry). It is
a plain local read, the same posture as reading `migration_v24_repoint_log`.

### D4 — Reversibility, resolution, and the restore-after-merge interaction with #68

**Merge reversibility = the existing Trash/restore path, no new audit table.** The loser's
`DELETE_FIELD` op puts it in Trash; `locations` is already `restorable` (`restore.js:28`). The op-log
records the re-point ops and the delete — that *is* the audit trail. No `merged_into` column, no merge-
history table. Trash is the reversibility mechanism the v32 ADR and the spec both require.

**Restore-after-merge vs #68 — the sharp trace (this is the load-bearing correctness argument):**

1. Merge `pool`(`location:{camp}:pool`) → `Pool`(`location:{camp}:Pool`): activities re-pointed to
   `Pool`, `pool` deleted → Trash.
2. Director restores `pool`. `restoreEntity` runs on the Host (`main.js:963-966`), re-emitting `pool`'s
   own last-known fields (`id, camp_id, name='pool', capacity, notes, sort_order`).
3. **#68's Finding A guard fires first** (`restore.js:198-217`): `detectUniqueFieldCollision` for
   `locations.name = 'pool'`. `UNIQUE(camp_id, name)` is **case-sensitive** (`schema.sql:592`), so
   `'pool' ≠ 'Pool'` → **no collision** → restore proceeds. `pool` returns with its own deterministic
   id (the physical row was `DELETE`d, `projections.js:494-495`, so `ensureExists`'s `INSERT OR IGNORE`
   re-inserts cleanly — no PK conflict).
4. **The restored `pool` comes back EMPTY.** Restore re-emits only the loser's *own* fields; it does
   **not** touch `activities.location_id`. The activities are still on `Pool`. So `pool` exists again
   with nothing bound — coherent, and identical to M3a's established single-delete-restore semantics
   ("you can put it back — but the activities won't automatically start using it again",
   `LocationsScreen.jsx:352`). **No re-orphaning, no data corruption.**

**The one case #68 *does* catch, correctly:** merge `pool`→`Pool`, then the director interactively
creates a *new* location also named `pool` (a fresh `randomUUID` id, not `deriveLocationId` — #68
option (d)), then restores the old `pool` from Trash. Now a *different* entity_id holds name `pool`, so
Finding A's guard returns `{error:'unique_field', existing:<new pool>}` and the restore is refused with
an honest, permanent message (`TrashScreen` `OUTCOME_COPY.unique_field`, #68 T12). This is exactly the
behavior #68 built; M3c inherits it for free and must not fight it.

**Because near_duplicate merges are by definition different spellings, loser.name ≠ winner.name always
holds, so the ordinary undo-restore never collides.** The merge does not, and must not, produce two
exact-same-name rows — #68 guarantees that can't exist, and the merge is the human-reviewed heal of the
*different*-name artifact, never a same-name create.

**Journal resolution (per-device, no schema change):**
- **Dismiss = delete the local journal row(s).** A new host-local IPC `dismissMigrationReviews(token,
  ids)` deletes by id from the calling device's own `location_migration_reviews` — **local DB write,
  never an op, never routed to the Host**, gated `locations.write`. Used by the advisory strip's "Looks
  right" and by the gate's "these are different places" (a considered decision that resolves the group
  without changing any replicated data). Deleting the row (rather than adding a `resolved_at` column)
  avoids a journal schema change and keeps the fresh-vs-migrated table-shape equivalence test intact.
- **near_duplicate additionally derives resolution from location existence at read time.** The renderer
  (which already loads the locations + activities lists for the gate) hides a near_duplicate group whose
  variant `locations` rows no longer both exist. This is the **cross-device self-heal**: when the Host
  merges, the loser delete replicates to every peer; a peer that ran its *own* migration still holds its
  own near_duplicate journal rows, but derive-at-read hides them because the loser location is gone
  fleet-wide. Local-dismiss handles the initiating device and the no-merge "different places" case;
  derive-at-read handles every non-initiating device. No mechanism reaches into another device's local
  journal, and none needs to.

**Accepted, per-device property:** a "these are different places" decision changes no replicated data,
so it resolves only the deciding device's journal. Another migrated device re-presents the gate and
independently confirms. This is inherent to a host-local, per-device journal (the v32 ADR's own design);
in practice the migrating device is the Host and most camps migrate once. Recorded, not fixed.

### D5 — D-2: ship numbers-only copy; guarded activity-naming is optional polish

The `capacity_disagreement` detail stores `{declaredCaps, seededCapacity}` only — not which activities
disagreed. Naming them ("Swim Lessons said 1, Free Swim said 3") requires joining
`activities WHERE location_id = review.location_id` — which is **cheap at execution** (the review region
already loads that activity list for the gate's per-location counts, so it is a filter over data in
hand, not a new query).

**The cost is not the join; it is semantic honesty.** The journal is a point-in-time migration snapshot;
live `activities.max_groups_per_slot` is mutable and may have diverged since (an activity edited,
re-pointed away, or deleted). A label sourced from live activities can therefore **contradict** the
stored `declaredCaps` ("Swim Lessons said 1" when Swim Lessons now reads 3). Reconstruction also has to
re-apply the migration's `NULL/0 → 1` normalization (`localDb.js:1540`) to match, and handle activities
that no longer point at the place.

**Recommendation: ship the numbers-only copy (§3.4) as M3c's deliverable** — it is guaranteed honest and
renderable from journal data alone. If naming is added, it MUST be **guarded**: show an activity's name
only when its live normalized cap still equals one of the stored `declaredCaps` values, and fall back to
numbers-only for that item otherwise, so the label can never contradict the stored numbers. Given the
fragility for a first-run, once-only advisory, numbers-only is the right ship; guarded naming is a later
polish, not an M3c requirement. **Confidence: medium-high** — the join is provably cheap; the recommend-
ation turns on the point-in-time-vs-live contradiction risk, which is a correctness argument, not a cost
one.

## Files / modules affected

| File | Change |
|---|---|
| `electron/ops/deleteRecord.js` | Add `locations` to `CLEARABLE_ENTITIES`; new non-destructive locations branch (reference query = activities by `location_id` + `week_location_exclusions`); `reassign_to`/`winner_capacity` params; return re-pointed activity ids. `previewDelete` locations branch (`ref_count` + activity rows). **No** slot/route/snapshot logic for locations. |
| `electron/main.js` | `deleteRecordHandler` already generic — passes `reassign_to`/`winner_capacity` through (Host + Client-route). New `listMigrationReviews` + `dismissMigrationReviews` handlers (local-only, gated `locations.read`/`.write`). New `mergeLocation` entry OR extend delete args (see Open Q1). |
| `electron/sync/syncServer.js` | `handleDeleteRecordRequest` (`:837`) already calls `deleteRecord` + broadcasts; carry `reassign_to`/`winner_capacity` on the request (or a sibling `merge_location_request` handler — Open Q1). |
| `electron/sync/syncClient.js` | `requestDelete` (`:1187`) carries the new fields (or `requestMerge`). Journal reads are **not** here — they never leave the device. |
| `electron/preload.js` | Expose `listMigrationReviews`, `dismissMigrationReviews` (+ `mergeLocation` if chosen). |
| `src/localClient.js` | Passthroughs for the new methods. |
| `src/localClient.mock.js` | Mock twins (journal read `[]`/fixture; dismiss no-op; merge mirrors delete). `ipcSurfaceParity.test.js` gate. |
| `src/screens/LocationsScreen.jsx` | Delete switches from bespoke unbind to `previewDelete`/`DeleteRecordDialog`/`deleteRecord` host path (D2). Review region consumes `listMigrationReviews`; gate calls the merge; strip/gate call `dismissMigrationReviews`; derive-at-read hides resolved near_duplicates. |

## Reused vs. new

- **Reused:** the entire `deleteRecord` host transaction + broadcast + Client-WS routing
  (`deleteRecord.js`, `main.js:998-1022`, `syncServer.js:837-882`); the `weather_alternative_id`
  no-FK-clear template as the pattern for re-pointing a convention reference inside the host transaction;
  the count-drift guard; `DeleteRecordDialog`/`previewDelete` (unified by #67); the Trash/`restoreEntity`
  path incl. #68's Finding A collision guard (`restore.js:198-217`); the v32 journal table and
  `deriveLocationId`.
- **Genuinely new:** (1) the `reassign_to` clearing mode — nothing today re-points a convention
  reference to a *target* rather than null; (2) the three local-only journal IPCs — no host-local read
  path exists for `location_migration_reviews` yet. Both are the smallest additions that discharge the
  M3a commitment and render the owner-approved review region.

## Non-goals / what M3c must NOT do

- **No schema change.** No new table, no `merged_into`/audit column, no `resolved_at` on the journal
  (dismiss deletes the row). Fresh-vs-migrated equivalence and idempotency are **unaffected** — confirmed:
  there is no DDL in this slice, so the v32 migration tests (`locations.migration.test.js`) do not move.
- **No second delete/merge path.** One primitive, `deleteRecord`, both consumers (D1/B rejected).
- **No exact-name auto-merge.** #68 owns write-time collisions; M3c is the human-reviewed heal of
  *different* names. They must not share code or a queue (#68 M3c coordination note).
- **No new conflict type / no op-log primitive.** Merge is ordinary field-level ops (`location_id`,
  `capacity`, `DELETE_FIELD`) + host atomicity, exactly like the existing delete.
- **No map, no import, no week-exclusion UI** (M6/M4/M5). The primitive *handles* the exclusion
  reference for forward-correctness, but no exclusion UI ships here.
- **No cross-device propagation of the "different places" decision** (accepted per-device property, D4).

## Migration / rollback / integration implications

- **Merge is a data mutation, not a migration.** No schema change → nothing to migrate, no `v32_down`
  change, fresh-vs-migrated unaffected (confirmed: no DDL).
- **Rollback:** already covered by the v32 ADR — `v32_down.js` repopulates the frozen `activities.
  location` from the entity and drops the tables; merged/re-pointed activities carry the winner's name
  through the frozen column, so rollback stays lossless for names (structure, incl. the merge outcome,
  does not survive rollback — already disclosed).
- **Integration (mandatory, `database-sync`):** a new LAN-sync scenario — Host has `Pool` + `pool` each
  with bound activities; a merge re-points `pool`'s activities to `Pool`, sets winner capacity, deletes
  `pool`; assert on a second real Client that (a) the re-point + delete replicated, (b) zero activities
  still point at the deleted `pool`, (c) restoring `pool` from Trash brings back an empty place and does
  **not** re-point activities, (d) the count-drift guard aborts a merge whose bound-activity count
  changed between preview and confirm. Red Hat mandatory (multi-entity stored-data op interacting with
  #68 and the op-log).

## Consequences

- **Positive:** merge is host-atomic (can't half-apply); the M3a non-atomicity is closed and the delete
  primitive is unified (delete = clear→null, merge = clear→winner) with no duplication; the review region
  renders from a plain local read that can never error on an absent journal; restore-after-merge is
  proven safe against #68 with no new machinery; zero schema change.
- **Costs / risks:** `deleteRecord` grows a fourth entity on a genuinely different (non-slot) branch —
  the branch must be fenced so locations never reach the route/snapshot code (test-pinned). The journal's
  per-device resolution is a real, bounded limitation (D4). Naming activities in D-2 copy is deferred as
  fragile.
- **Security-relevant surface (Security must check):** three new IPCs. `listMigrationReviews` /
  `dismissMigrationReviews` are **local-only** and must (a) require a valid session token and
  `locations.read`/`.write` — an unauthenticated review read would enumerate camp place names; (b) touch
  only the local DB and **never** emit an op or reach the Host (a dismiss must not be a covert write
  channel); (c) parse `detail` JSON defensively. The merge path reuses the already-audited
  `deleteRecord`/WS gate (`${entity}.delete`), adds no auth surface, and returns only field-picked data
  (activity id/name), never raw rows — matching #68 Finding E's discipline.

## Open questions — RESOLVED (Governor + owner, 2026-08-15)

1. **Merge wire/IPC shape → (a) dedicated `mergeLocation` IPC + `merge_location_request` WS handler,
   delegating to the shared `deleteRecord` atomic core.** Governor accepted Architect's recommendation
   (technical, not owner-facing): named intent, distinct return data (re-pointed ids + winner capacity),
   shared atomic core satisfies the M3a commitment.
2. **D-2 copy → NUMBERS-ONLY (owner decision).** Guarded activity-naming deferred as optional later polish.
   The owner's earlier "name if cheap" was conditioned on cost; the deciding factor is point-in-time-vs-
   live contradiction risk (a named label could be factually wrong → Art V honesty), so numbers-only ships.
3. **Immediate-Undo → NOT wired for M3c (owner decision): Trash-restore-of-the-empty-place suffices**
   (consistent with M3a single-delete, and the reversibility already in the approved design). The merge
   still returns the re-pointed ids (no data-layer change), so a thin immediate-Undo renderer affordance
   remains a cheap future polish if wanted.

**ADR accepted** by the product owner 2026-08-15 (the structural direction — host-path re-home +
`CLEARABLE_ENTITIES` — was already sanctioned at v32-ADR approval and the M3a commitment; this ADR is its
detailed design, with the two product-facing refinements above answered by the owner directly).
