# T117 — Imported schedule materializes as a saved version (slice 2)

See `docs/adr/2026-09-02-imported-schedule-materializes-as-a-version.md` for the decision this
implements. Slice 1 (merged, 68c7ca7) built `src/ingest/capturePlacements.js`; nothing calls it
yet. This ticket wires it in.

## Build test-first, in this order

### 1. Pure resolver — `electron/ops/resolveImportedPlacements.js` (new file)

No I/O. Signature:

```js
/**
 * @param {Array<{groupName, dayName, blockLabel, activityName}>} placements
 * @param {{
 *   groupIdByName: Map<string,string>,
 *   dayIdByName: Map<string,string>,
 *   blockIdByName: Map<string,string>,
 *   activityIdByName: Map<string,string>,
 *   anchorIdByName: Map<string,string>,
 * }} maps  keys are normalizeName(name) (import from '../../src/ingest/preview.js',
 *          the SAME key function commitIngest already uses for the six entities)
 * @returns {{
 *   slots: Array<{group_id, day_id, time_block_id, activity_id, anchor_id, is_anchor, flags}>,
 *   unresolved: Array<{groupName, dayName, blockLabel, activityName, reason}>,
 * }}
 */
export function resolveImportedPlacements(placements, maps) { ... }
```

Resolution order per placement:
1. Look up `group_id`, `day_id`, `time_block_id` via `normalizeName`. If any is missing, push to
   `unresolved` with `reason: 'group' | 'day' | 'block'` and skip — these three should always
   resolve (they were just created/matched by `commitIngest`), so a miss here is worth
   distinguishing from an activity-name miss.
2. **Anchor-first**: look up `activityName` in `anchorIdByName`. If found: `{ ..., anchor_id: id,
   activity_id: null, is_anchor: true, flags: {} }`.
3. Else look up in `activityIdByName`. If found: `{ ..., activity_id: id, anchor_id: null,
   is_anchor: false, flags: {} }`.
4. Else push to `unresolved` with `reason: 'activity'`.

v1 scope, matching `capturePlacements.js`'s own documented limitation: multi-block spans flatten
to one slot per (group, day, block) cell, no span-head merging. Do not add span logic here.

**Unit tests** — `electron/ops/resolveImportedPlacements.test.js`:
- all-resolved happy path (mix of activity and anchor placements) → correct slot shape, empty
  `unresolved`.
- an activity name that collides with an anchor name → anchor wins (assert `is_anchor: true`,
  `activity_id: null`).
- unresolved activity name → lands in `unresolved` with `reason: 'activity'`, not in `slots`.
- unresolved group/day/block name → `reason` matches which axis missed.
- empty `placements` → `{ slots: [], unresolved: [] }`.
- `flags` always `{}` (matches `useSnapshots.js:52`'s own shape — no flags on an imported
  placement).

### 2. Thread `placements` through the ingest commit path (additive, same convention as
   `fixedEvents`/`activityRules` etc.)

- `src/localClient.js:53-54` — add `placements` param, default `[]` in the mock's case (see next
  bullet), passed straight through to `shoresh.ingestCommit`.
- `src/localClient.mock.js:575` — add `placements` param for signature parity. The mock does not
  need to replicate materialization (there is no `syncClient`/host DB to write real
  `schedule_templates`/`schedule_snapshots` rows against in the mock's in-memory model) — confirm
  this against how the mock already handles `fixedEvents`/`captureInverse` (it stores/echoes but
  the mock's read layer is a separate in-memory projection, not a second implementation of
  `commitIngest`'s logic). If existing snapshot-related mock state exists
  (`localClient.mock.js` already implements `writeSnapshotFields`/snapshots per `useSnapshots.js`
  calls), reuse that same in-memory snapshot store so mock-backed tests (`npm run dev` /
  Vitest component tests) can assert a version got created too. Do not build a second resolver in
  the mock — call the same `resolveImportedPlacements` pure function against the mock's own
  in-memory catalog maps.
- `electron/main.js`'s `ingestCommit` handler (~line 282): add `placements` to the destructured
  args, default `[]`.

### 3. Host-side orchestrator — `electron/ops/materializeImportedVersion.js` (new file)

Impure (touches `db`, calls `syncClient.write`). Signature:

```js
/**
 * @param {Database} db
 * @param {{write: Function}} syncClient
 * @param {{campId: string, authorUserId: string, placements: Array}} args
 * @returns {{created: boolean, snapshotId: string|null, unresolvedCount: number, unresolvedNames: string[]}}
 */
export function materializeImportedVersion(db, syncClient, { campId, authorUserId, placements }) { ... }
```

Steps (only runs when `placements.length > 0` — if the import carried no placements, e.g. a plain
catalog CSV, return `{ created: false, snapshotId: null, unresolvedCount: 0, unresolvedNames: [] }`
immediately, no writes):

1. `weekId = db.prepare('SELECT id FROM schedule_weeks WHERE camp_id = ? AND is_archived = 0 ORDER BY sort_order ASC LIMIT 1').get(campId)?.id`.
   If no week exists, return `created: false` with `unresolvedCount: placements.length` (nothing
   to attach a version to) — do not mint a `schedule_weeks` row here, that is out of scope.
2. Resolve the `(weekId, 'manual')` `schedule_templates` row: `SELECT id FROM schedule_templates
   WHERE week_id = ? AND kind = 'manual'`. If none, mint via
   `deriveScheduleTemplateId(weekId, 'manual')` (import from `./scheduleTemplateId.js`) and create
   it via `syncClient.write` field-writes for `kind`, `camp_id`, `week_id`, `name: ''` — mirror
   `scheduleRepository.js:250`'s `writeFields` call exactly (same fields, same order), not a new
   pattern.
3. Build the five name→id maps by querying the live tables scoped to `campId`, keyed by
   `normalizeName(row.name)` (import from `../../src/ingest/preview.js`):
   `activities`, `anchor_activities`, `groups`, `days_of_operation`, `time_blocks`.
4. Call `resolveImportedPlacements(placements, maps)`.
5. If `slots.length === 0` (nothing resolved at all): return `{ created: false, snapshotId: null,
   unresolvedCount: unresolved.length, unresolvedNames: unresolved.map(...) }` — do NOT write an
   empty snapshot. An empty version is worse than no version (matches the existing
   `useSnapshots.js:86-88` comment about empty snapshots being a known bad state to avoid
   reintroducing).
6. Otherwise write ONE `schedule_snapshots` row via `syncClient.write`, same field set
   `useSnapshots.js:70-77` writes: `template_id, name: 'Imported schedule', is_auto: false,
   created_at: new Date().toISOString(), slots: JSON.stringify(slots), day_overrides_json: '[]'`.
   Use `randomUUID()` for the id (matches `useSnapshots.js:61`).
7. Return `{ created: true, snapshotId: id, unresolvedCount: unresolved.length, unresolvedNames:
   unresolved.map(u => u.activityName) }`.

### 4. Wire into `electron/main.js`'s `ingestCommit` handler

After `commitIngest(db, {...})` resolves successfully and only when `placements?.length`, call
`materializeImportedVersion(db, syncClient, { campId: camp.id, authorUserId: session.userId,
placements })` and merge its result onto the returned outcome as `version: {...}`. If
`materializeImportedVersion` throws, catch it, do NOT rethrow (the catalog import already
succeeded and must not be reported as failed) — return `version: { created: false, snapshotId:
null, unresolvedCount: placements.length, unresolvedNames: [] }` and log the error server-side
(match whatever logging convention nearby handlers use — check for an existing `console.error`
pattern in `main.js` for a precedent, e.g. near the backup-write best-effort block at line ~899).

### 5. Renderer: compute `placements` and surface `version` outcome

- Find the renderer call site that currently invokes `localClient.ingestCommit({...})` for a raw
  schedule import (grep `ingestCommit(` under `src/` outside `localClient.js`/`.mock.js` — likely
  an ingest/import screen or hook). At that call site, call `capturePlacements(parsed, proposal)`
  (already available from slice 1) and pass `placements` into the `ingestCommit` call.
- After the call resolves, if `outcome.version`:
  - `created: false && unresolvedCount > 0` → surface a message distinct from the catalog
    import's own success/failure message, e.g. via the same `describeWriteFailure`-adjacent
    pattern used elsewhere (`setActionError` or whatever this screen's error-surface convention
    is) — "Imported schedule could not be saved as a version (N placements didn't match your
    catalog)."
  - `created: true && unresolvedCount > 0` → a softer, non-blocking notice: "M placements could
    not be matched and were skipped." The catalog import and the version are both real; this is
    informational, not an error.
  - `created: true && unresolvedCount === 0` → no extra message needed (or a quiet confirmation,
    match the screen's existing tone) — the import succeeded fully.
- This step's exact toast/banner mechanics depend on which screen owns the ingest-commit call;
  match its existing error-surface convention rather than inventing a new one. This is the one
  step in this ticket where the exact UI call is not fully specified above — locate the call site
  first, then follow its existing pattern.

## Test list

- `electron/ops/resolveImportedPlacements.test.js` — see unit test list above (pure, no DB).
- `electron/ops/materializeImportedVersion.test.js` — against a real in-memory `better-sqlite3` db
  (match the fixture pattern other `electron/ops/*.test.js` files use, e.g. `ingest.test.js`):
  - no `schedule_weeks` row → `created: false`.
  - `schedule_templates` row for `(weekId, 'manual')` does not exist yet → gets minted, snapshot
    attaches to it.
  - `schedule_templates` row already exists (e.g. director already built a manual schedule before
    importing) → reused, not duplicated (assert only one row for that `(week_id, kind)` after the
    call — the existing `SCHEDULE_TEMPLATE_KIND_CONFLICT` guard in `projections.js:675` should
    make a second mint attempt throw if this is wrong).
  - all placements resolve → one `schedule_snapshots` row, correct `slots` JSON, `unresolvedCount:
    0`.
  - 0 of N placements resolve → no `schedule_snapshots` row is written, `created: false`.
  - some resolve, some don't → one row written with only the resolved slots, `unresolvedCount > 0`,
    `unresolvedNames` populated.
  - re-run the same call twice (simulating Add-mode re-import) → two separate
    `schedule_snapshots` rows exist afterward (the accepted v1 "always a new version" rule from
    the ADR) — assert this explicitly so a future change to that rule is a deliberate test edit,
    not a silent regression.
- Integration/parity: a test exercising `ingestCommit` end-to-end through `electron/main.js`'s
  handler (or the nearest existing integration harness for ingest commits) with a fixture that
  includes `placements`, asserting the returned `outcome.version` shape.
- Mock parity: a Vitest test against `localClient.mock.js`'s `ingestCommit` with `placements`,
  asserting it does not throw and (if the mock reuses the real resolver per step 2) that a version
  shows up in the mock's in-memory snapshot store, so dev-server/browser-mock testing of this flow
  is possible without Electron.
- Restore fidelity (can extend an existing `useSnapshots`/`restoreSnapshot` test rather than adding
  a new file): a snapshot written by `materializeImportedVersion` restores through the unchanged
  `restoreSnapshot` path and produces grid cells for both activity and anchor placements.

## Verification gates

`npm run verify` (lint + test + test:integration + check:governance) must pass. Additionally, per
the native-module ABI note in `CLAUDE.md`, run `npm rebuild better-sqlite3` before the Vitest run
if `electron/ops/**` changes were made under a differently-built `better-sqlite3` (e.g. after
`electron:dev`).

## Open items for Governor (not decided here — product calls)

- The exact renderer surface for "N placements skipped" — which screen, and whether it's a toast,
  a banner, or a summary line in the import-review UI — needs a look at the real ingest screen
  before Designer/Maker commit to specific copy and placement. Flagged in step 5 above.
- Whether re-importing on top of an *existing* imported version should ever be treated as "update"
  rather than "new woodpile entry" is explicitly punted to v1's simple rule (always new); if a
  director complains about junk versions piling up from repeated Add-mode imports during testing,
  that is a product question for a follow-up ticket, not a slice-2 scope change.
