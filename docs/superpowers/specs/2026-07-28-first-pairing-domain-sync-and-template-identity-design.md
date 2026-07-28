# T7 — joining device gets empty camp — design

Companion ADR: `docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md`.
Read that first for the *why*; this doc is the *how*, precise enough that no
further architectural judgment calls should be needed to implement it.

**Revision note (this version):** a Red-Hat + Governor correction round found
four defects in the first draft of this design. §2.4 (full-sync
acknowledgment), §3.4 (migration re-key procedure), and §2.3 (batch-validation
semantics) are corrected below; Part 4 (write-gating + completion push) is
new. §2.1, §2.2, and Part 1 are unchanged and were independently re-verified
as sound (apply order against `schema.sql`'s declared FKs; migration-before-
sync-wiring ordering in `openLocalDb`).

## Part 1 — Shared camp-scoped entity registry (prerequisite refactor)

`electron/main.js:46-79` currently hand-declares two constants used only by
its own `list()` IPC handler (`electron/main.js:602-628`):

```js
const DIRECT_CAMP_ENTITIES = new Set([
  'groups', 'tiers', 'activities', 'cohorts', 'days_of_operation',
  'time_blocks', 'anchor_activities', 'schedule_templates', 'day_override_templates',
])

const PARENT_SCOPED_ENTITIES = {
  template_slots:              { table: 'template_slots',              parentTable: 'schedule_templates',   parentKey: 'template_id' },
  template_overlays:           { table: 'template_overlays',            parentTable: 'schedule_templates',   parentKey: 'template_id' },
  schedule_snapshots:          { table: 'schedule_snapshots',           parentTable: 'schedule_templates',   parentKey: 'template_id' },
  day_override_template_slots: { table: 'day_override_template_slots',  parentTable: 'day_override_templates', parentKey: 'day_override_template_id' },
}
```

**Move these, verbatim, into a new module** `electron/ops/campScopedEntities.js`,
exporting both constants unchanged. `electron/main.js` imports them back from
there instead of declaring them locally. `electron/sync/syncServer.js`
imports the same module for Part 2 below. This is the only way both the
renderer's read path (`list()`) and the new full_sync snapshot path are
structurally guaranteed to cover the same table set — do not hand-write a
second list in `syncServer.js`.

## Part 2 — Full-sync domain snapshot on first pairing

### 2.1 What ships, and in what order

`sendFullSyncIfFirstPairing` (`electron/sync/syncServer.js:104-120`) ships
`users`/`camps` today. Extend it to also ship every table named in
`DIRECT_CAMP_ENTITIES` plus `template_slots`, `template_overlays`,
`day_override_template_slots` from `PARENT_SCOPED_ENTITIES` — **explicitly
excluding `schedule_snapshots`** (see ADR Consequences: unbounded historical
growth, out of scope for this ticket).

Query shape, reusing the existing `list()` handler's own scoping logic
(`electron/main.js:620-627`) so the Host-side query and the renderer's own
read-path query can never diverge in what "camp-scoped" means:

```js
// direct entities (in DIRECT_CAMP_ENTITIES minus schedule_snapshots, N/A here since it's parent-scoped):
db.prepare(`SELECT * FROM ${table} WHERE camp_id = ?`).all(campId)

// parent-scoped entities:
db.prepare(`SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`).all(campId)
```

`campId` here is the Host's own `SELECT id FROM camps LIMIT 1` — same
single-camp-per-db assumption used everywhere else in this file
(`syncServer.js` doesn't currently look this up; add one
`const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()` guard at the
top of the extended function, mirroring `main.js:617-618`. If there is no
camp row yet — should not be reachable via a real pairing flow, but
defensive — send empty arrays for every domain table rather than skipping
the message, so the Client's `applyFullSync` still runs and the rest of the
handshake still completes).

**Message shape** (new fields added to the existing `full_sync` type, none
removed):

```js
{
  type: 'full_sync',
  users, camps,                 // unchanged
  cohorts, days_of_operation, groups, tiers, time_blocks, activities,
  anchor_activities, schedule_templates, day_override_templates,
  template_slots, template_overlays, day_override_template_slots,
}
```

### 2.2 Client-side apply order (FK-respecting)

`applyFullSync` (`syncClient.js:166-193`) currently does `camps` then `users`
inside one `db.transaction()`, using `INSERT OR REPLACE`. Extend the same
transaction with the new tables, **in this order** — `PRAGMA foreign_keys = ON`
is set in `openLocalDb` (`electron/db/localDb.js:790`), so violating this
order throws:

1. `camps` (existing)
2. `users` (existing)
3. `cohorts`
4. `days_of_operation`
5. `groups`
6. `tiers` (references `cohorts.id`, nullable)
7. `time_blocks` (references `cohorts.id`, nullable)
8. `activities`
9. `anchor_activities` (references `cohorts.id` nullable, `days_of_operation.id` nullable)
10. `schedule_templates`
11. `day_override_templates` (references `cohorts.id` nullable)
12. `template_slots` (references `groups.id`/`activities.id`, both nullable — no declared FK to `schedule_templates.id` despite the logical relationship, per `schema.sql:195-202`)
13. `template_overlays` (references `schedule_templates.id` NOT NULL, `days_of_operation.id` nullable)
14. `day_override_template_slots` (references `day_override_templates.id` NOT NULL)

Each table gets one `INSERT OR REPLACE INTO <table> (<cols>) VALUES (...)`
per row, columns matching that table's full schema (see `schema.sql` for the
authoritative column list per table — don't re-derive it from `PROJECTIONS`,
which deliberately excludes non-synced/internal columns for some tables).

### 2.3 Row validation — corrected: validate everything up front, apply all-or-nothing

**Correction:** the previous version of this design validated each row with
a per-row `continue` (skip the bad row, keep applying the rest of that
table) inside the existing single shared transaction. That does not hold:
with `foreign_keys = ON` and all fourteen tables in one transaction, a
skipped row that is itself the FK target of a later table's row (e.g. a
skipped `schedule_templates` row referenced by a valid `template_overlays`
row, whose FK is declared `NOT NULL REFERENCES schedule_templates(id)`)
makes that later `INSERT` throw — aborting the whole transaction anyway, not
just the offending table. Building cross-table referential pruning to make
per-row-skip actually safe is materially more machinery than this ticket
needs (see ADR Consequences for why whole-batch-abort is an acceptable,
even correct, choice once §2.4's real ack exists).

**Do this instead:** validate every row of every table in the incoming
message *before* opening the transaction. If any row anywhere fails
validation, treat the entire `full_sync` message as invalid: apply nothing,
throw (so the caller — see §2.4 — does not send an acknowledgment), and let
the existing camps/users validators keep their current per-row `continue`
behavior only because those two tables are not FK targets of anything else
in this batch and were already independently correct on their own.

```js
function isValidSnapshotRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (!isNonEmptyString(row.id)) return false
  for (const value of Object.values(row)) {
    if (typeof value === 'boolean') return false
    if (value !== null && typeof value === 'object') return false
  }
  return true
}

function isValidDomainSnapshotBatch(msg) {
  for (const key of DOMAIN_SNAPSHOT_TABLES) { // the 12 tables from §2.1, in apply order
    const rows = Array.isArray(msg[key]) ? msg[key] : null
    if (rows === null) return false
    if (!rows.every(isValidSnapshotRow)) return false
  }
  return true
}
```

`applyFullSync` becomes: validate `camps`/`users` per-row exactly as today
(unchanged — `continue` on a bad row, apply the rest), **then**, only if
`isValidDomainSnapshotBatch(msg)` passes, open the one transaction and
`INSERT OR REPLACE` every domain-table row in §2.2's order. If the domain
batch fails validation, throw *before* starting that transaction — do not
attempt a partial insert.

This is intentionally looser, at the per-row level, than a full per-column
schema check: these rows come from a real `SELECT *` on the Host
(already-materialized SQLite values — string/number/null only, per
`better-sqlite3`'s own type mapping), so the only realistic failure mode for
an individual row is a fabricated/malformed message from a non-genuine
peer — which the all-or-nothing behavior above treats conservatively, by
design, not partially.

### 2.4 A real application-level acknowledgment, not just a transport-level one

**Correction:** the previous version of this design used `sendWithAck`
(transport-level: "did the bytes leave the Host") as the sole gate on the
Host's one-time `last_synced_at` latch. That is not sufficient.
`applyFullSync` currently commits or rolls back with no reply to the Host at
all (`syncClient.js:283-286` is `applyFullSync(msg); return` — no message
sent back), and the entire dispatch is wrapped in a silent catch-all
(`syncClient.js:394-396`). A Client whose transaction genuinely throws
(constraint violation, a batch that fails §2.3's validation, disk error)
would previously have looked, from the Host's side, identical to a fully
successful apply — the Host would latch `last_synced_at` on transport
success alone and never offer this device a snapshot again, since
`syncServer.js:105-106`'s guard is a one-time, non-retryable check. Add a
genuine reply:

**New message type, Client → Host:** `{ type: 'full_sync_applied' }`, sent
by the Client **only after** its transaction has committed successfully.

**`syncClient.js`'s `full_sync` branch** (`syncClient.js:283-286`):

```js
if (msg.type === 'full_sync') {
  try {
    applyFullSync(msg) // throws per §2.3 on any validation/DB failure — no partial commit
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'full_sync_applied' }))
    }
  } catch {
    // Apply failed (bad batch, genuine DB error) or the ack send itself
    // failed (connection already going bad). Either way: do NOT ack. The
    // Host's wait (below) times out, does not latch last_synced_at, and the
    // next reconnect retries the entire snapshot from scratch — safe, every
    // insert is INSERT OR REPLACE. No new logging/observability is added
    // here, matching this file's existing convention for swallowed
    // projection failures (applyRemoteOp's own catch, syncClient.js:249-253).
  }
  return
}
```

**`syncServer.js`: a per-connection resolver for the reply**, analogous in
shape to `syncClient.js`'s own `submitResolvers`/`lockResolvers` arrays but
scoped to a single pending wait per `ws` (only one `full_sync` is ever
in flight per connection, since `sendFullSyncIfFirstPairing`'s own guard
prevents re-entry until the latch is set):

```js
const FULL_SYNC_ACK_TIMEOUT_MS = 15000 // generous vs. SEND_ACK_TIMEOUT_MS's 8s:
  // this is a larger, one-time batch commit on the Client, not a single op

function waitForFullSyncAck(ws, timeoutMs = FULL_SYNC_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      ws.pendingFullSyncAckResolve = null
      resolve(result)
    }
    ws.pendingFullSyncAckResolve = settle
    setTimeout(() => settle(false), timeoutMs)
  })
}
```

Add one branch to the existing message dispatcher in
`wss.on('connection')` (alongside `acquire_lock`/`submit_op`, below the
`if (!ws.deviceId) return` gate — `full_sync_applied` is only ever sent
after `authenticate` has already set `ws.deviceId`):

```js
if (msg.type === 'full_sync_applied') {
  if (ws.pendingFullSyncAckResolve) ws.pendingFullSyncAckResolve(true)
  return
}
```

**`sendFullSyncIfFirstPairing` becomes:**

```js
async function sendFullSyncIfFirstPairing(db, ws, asOfSeq) {
  const device = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(ws.deviceId)
  if (!device || device.last_synced_at) return

  // Everything below this line, up to the first `await`, is synchronous —
  // see §2.5 on why that matters.
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  const campId = camp?.id ?? null
  const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
  const camps = db.prepare('SELECT id, name, signing_secret, signing_public_key FROM camps').all()
  // ... one SELECT per §2.1 table, each falling back to [] if campId is null ...

  const delivered = await sendWithAck(ws, { type: 'full_sync', users, camps, /* ...domain tables */ })
  if (!delivered) return // transport failure — no point waiting for an app-level ack that can't arrive

  const applied = await waitForFullSyncAck(ws)
  if (applied) {
    db.prepare('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(new Date().toISOString(), ws.deviceId)
  }
  // applied === false: transport delivered, but no application ack arrived
  // within the timeout (Client's apply failed, or the ack itself was lost).
  // last_synced_at stays NULL either way — next reconnect retries.
}
```

A redundant re-send (Client already has this exact data from a prior
attempt, ack got lost, Host resends on next reconnect) is safe by
construction: every insert is `INSERT OR REPLACE`, and re-sending an
identical ack for an already-applied batch is harmless.

### 2.5 Snapshot/watermark consistency — one shape, specified exactly

**Correction:** the previous version offered two interchangeable shapes for
computing the seq baseline once. Only one shape actually satisfies both
"computed once" and "`handleAuthenticate` must not block on either send" at
the same time — the other (`sendFullSyncIfFirstPairing` computes it and
passes it down to `sendMissedOps`) would require `handleAuthenticate` to
`await` the first call before starting the second, which is exactly the
blocking this file's existing fire-and-forget convention avoids. Use this
shape only:

`handleAuthenticate` (`syncServer.js:211-293`) computes `currentMaxOpSeq(db)`
itself, synchronously, once, before calling either function, and passes the
same value into both:

```js
function handleAuthenticate(db, ws, msg) {
  // ...existing verification/authorization/self-registration logic, unchanged...

  ws.deviceId = verified.deviceId
  ws.userId = verified.userId
  ws.token = msg.token

  // Computed once, synchronously, here — before either call below, and
  // before either has a chance to await anything. Both
  // sendFullSyncIfFirstPairing's row snapshot and sendMissedOps's own
  // first-time watermark baseline must agree on the exact same instant, or
  // a write landing between two separately-computed values could end up in
  // neither the snapshot nor any future replay (the watermark would already
  // claim it as seen). Nothing between here and the two calls below yields
  // to the event loop, so this is the one instant both need.
  const asOfSeq = currentMaxOpSeq(db)

  // Fire-and-forget, per this file's existing convention (sendMissedOps was
  // already un-awaited here before this change) — handleAuthenticate must
  // not block on either completing.
  sendFullSyncIfFirstPairing(db, ws, asOfSeq)
  sendMissedOps(db, ws, asOfSeq)
}
```

`sendMissedOps`'s signature changes to accept this value explicitly for its
first-time baselining branch (`syncServer.js:164-177`):

```js
export async function sendMissedOps(db, ws, asOfSeq, ackTimeoutMs = SEND_ACK_TIMEOUT_MS) {
  const device = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(ws.deviceId)

  if (!device || device.last_synced_seq === null || device.last_synced_seq === undefined) {
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(asOfSeq, ws.deviceId)
    return
  }
  // ...unchanged from here down...
}
```

This is a signature change to an exported, directly-unit-tested function
(`syncServer.js:156-160`'s own comment notes it's called directly from
tests) — update every existing direct call site
(`electron/sync/syncServer.test.js` and any integration scenario that calls
it) to pass `asOfSeq` explicitly. `sendFullSyncIfFirstPairing` receives the
same value as a parameter too (see §2.4), even though its own body does not
persist it anywhere — passing it through keeps the "one instant, one value,
used by both" invariant obviously true by construction rather than true
only because nothing currently `await`s between two independent reads.

## Part 3 — Schedule template identity

### 3.1 Deterministic id

New pure function, `electron/ops/scheduleTemplateId.js` (NOT under src/ — electron-builder packages only `electron/**`, `dist/**`, `package.json`, so an electron-side import of a src/ module works in dev and crashes the installed app during migration):

```js
export function deriveScheduleTemplateId(campId) {
  return `schedule-template:${campId}`
}
```

No format constraints exist on entity ids anywhere in this codebase
(confirmed: no UUID-shape validation on any `id` field in `main.js`,
`operations.js`, `projections.js`, `syncClient.js`) — a plain deterministic
string is a valid drop-in replacement for `crypto.randomUUID()` at both
mint sites.

### 3.2 Call sites to change

Both currently duplicate the same "mint if missing" block:

- `ScheduleScreen.jsx:259-264` (`generate()`)
- `ScheduleScreen.jsx:628-633` (`placeAnchors()`)

Extract one shared helper (this also removes the existing duplication) —
e.g. a top-level function in `ScheduleScreen.jsx` or a small new util:

```js
async function resolveOrCreateTemplateId({ templateId, campId, writeFields }) {
  if (templateId) return templateId
  const tid = deriveScheduleTemplateId(campId)
  await writeFields('schedule_templates', tid, { camp_id: campId, name: 'Master Template' })
  return tid
}
```

Both call sites replace their `if (!tid) { tid = crypto.randomUUID(); await writeFields(...) }`
block with `tid = await resolveOrCreateTemplateId({ templateId, campId, writeFields })`.
The subsequent `setTemplateId(tid)` stays. **Both call sites must also be
gated by the Part 4 write-gate below** — this helper does not itself check
readiness.

### 3.3 Initial-load resolution hardening

`ScheduleScreen.jsx:214-218`:

```js
const templates = await localClient.list('schedule_templates')
const tmpl = (templates || []).find(x => x.camp_id === campId)
```

Replace with a deterministic pick, defensive against any pre-existing or
future stray duplicate (should not occur after 3.4's migration + 3.1's
deterministic minting, but resolution should not silently depend on
whatever order SQLite/array iteration happens to return):

```js
const candidates = (templates || []).filter(x => x.camp_id === campId)
const canonicalId = deriveScheduleTemplateId(campId)
const tmpl =
  candidates.find(x => x.id === canonicalId) ??
  (candidates.length
    ? candidates.reduce((a, b) => (a.id < b.id ? a : b))
    : undefined)
```

### 3.4 Schema migration — `UNIQUE(camp_id)` on `schedule_templates`, WITH re-keying

**Correction:** the previous version of this design explicitly chose not to
re-key existing rows, reasoning that `UNIQUE(camp_id)` plus a thrown-exception
recovery path would backstop the mismatch for existing camps. Neither half of
that reasoning holds: `schedule_templates.ensureExists`
(`electron/ops/projections.js:207-213`) is `INSERT OR IGNORE`, so a create
attempt using the deterministic id against a camp whose existing row has a
*different* id is **silently absorbed** by the `camp_id` conflict — no
throw, no row created under the new id, and the following field `UPDATE`
affects zero rows. This is reachable today: the real production camp already
has one `schedule_templates` row under a random-UUID id. A device that races
ahead of `full_sync` (closed by Part 4 below, but defense-in-depth here
matters too) and calls `generate()` before that snapshot lands would collide
silently and then, finding nothing under the id it thinks it created,
proceed to build and `bulk_replace` a schedule from incomplete local data
under an orphaned id.

**Fix: re-key every existing row to the deterministic id, as part of the same
migration that adds the constraint.** A plain `UPDATE schedule_templates SET id = ?`
on a row other tables reference via a declared, `NOT NULL`, `foreign_keys = ON`
FK (`template_overlays.template_id`, `schedule_snapshots.template_id`) is not
safe — the instant the parent's `id` changes, any child still pointing at
the old value references a row that no longer exists, and that FK check is
immediate (not deferred) per-statement. Insert a new row under the new id
*before* repointing children, so no child ever points at a non-existent
parent, then delete the old row only after every child has been repointed:

New migration, version 21, in `electron/db/localDb.js`:

```js
if (getSchemaVersion(db) < 21) {
  db.transaction(() => {
    // 1. Dedupe: for any camp_id with more than one row (not live in
    // production today — see ADR Consequences — but a correct migration
    // must still handle it), keep MIN(rowid), repoint every table that
    // references a duplicate's id to the survivor, then delete the
    // duplicates. This step does not need the insert-copy dance below
    // because it keeps an EXISTING row (the survivor) rather than creating
    // a new id — only the rename step (2) does.
    const survivors = db
      .prepare(`SELECT camp_id, MIN(rowid) as keep_rowid FROM schedule_templates GROUP BY camp_id HAVING COUNT(*) > 1`)
      .all()

    for (const { camp_id, keep_rowid } of survivors) {
      const keepRow = db.prepare('SELECT id FROM schedule_templates WHERE rowid = ?').get(keep_rowid)
      const dupes = db
        .prepare('SELECT id FROM schedule_templates WHERE camp_id = ? AND rowid != ?')
        .all(camp_id, keep_rowid)

      for (const { id: dupeId } of dupes) {
        db.prepare('UPDATE template_slots SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
        db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
        db.prepare('UPDATE schedule_snapshots SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
      }
    }

    db.exec(`DELETE FROM schedule_templates WHERE rowid NOT IN (SELECT MIN(rowid) FROM schedule_templates GROUP BY camp_id)`)

    // 2. Re-key: after dedupe, exactly one row per camp_id. Rewrite each
    // row's id to the deterministic value, insert-copy-then-repoint-then-
    // delete (never a raw UPDATE of the referenced PK — see reasoning above).
    const rows = db.prepare('SELECT id, camp_id, name FROM schedule_templates').all()
    for (const { id: oldId, camp_id, name } of rows) {
      const newId = `schedule-template:${camp_id}`
      if (newId === oldId) continue
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(newId, camp_id, name)
      db.prepare('UPDATE template_slots SET template_id = ? WHERE template_id = ?').run(newId, oldId)
      db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(newId, oldId)
      db.prepare('UPDATE schedule_snapshots SET template_id = ? WHERE template_id = ?').run(newId, oldId)
      db.prepare('DELETE FROM schedule_templates WHERE id = ?').run(oldId)
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp ON schedule_templates(camp_id);`)
  })()

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (21, ?)').run(
    new Date().toISOString()
  )
}
```

Bump `CURRENT_SCHEMA_VERSION` to `21` (`electron/db/localDb.js:13`).

`schedule_snapshots.slots`/`.overlays` are JSON `TEXT` blobs
(`ScheduleScreen.jsx:511-540`'s `saveSnapshot`) that do **not** embed a
`template_id` field per-row (confirmed by reading `snapSlots`'s mapped
shape) — `restoreSnapshot` (`ScheduleScreen.jsx:542-...`) rebuilds rows using
the *current* `templateId` React state, not anything read back out of the
blob, so this re-key cannot desync a restore against stale embedded data.

After this migration, every device's canonical `schedule_templates` row for
an existing camp *is* the deterministic id, before any sync activity runs —
migrations apply at `openLocalDb`, before the sync client/server are wired up
(confirmed sound, no ordering hazard). The `UNIQUE(camp_id)` constraint's
role is now genuinely defense-in-depth only (see ADR Consequences for
exactly what "defense-in-depth" means here after this correction — a
same-id `INSERT OR IGNORE` PK collision, the intended and harmless case,
not a `camp_id`-mismatch collision).

## Part 4 — Write-gating on first-sync completion, and a completion push (new)

This closes Finding 3: a device is writable from the moment it authenticates,
independent of whether its domain data has actually arrived. Two parts, both
required — gating without a push signal leaves a correctly-disabled action
with no indication of when it becomes available and a screen that never
refreshes once data silently lands; a push signal without gating does not
stop a click that lands in the race window from destructively overwriting
real Host data with a schedule built from incomplete local state.

### 4.1 A persisted, per-device "first sync complete" flag

New column on the existing per-install singleton table `device_identity`
(`id, created_at` today — `schema.sql:209-212`, `getOrCreateDeviceId`,
`electron/db/localDb.js:847-856` confirms the `SELECT ... LIMIT 1` singleton
pattern this reuses):

New migration, version 22 (separate from version 21 — keeps each migration's
intent independently reviewable/testable):

```js
if (getSchemaVersion(db) < 22) {
  db.transaction(() => {
    const has = db.pragma('table_info(device_identity)').some((c) => c.name === 'first_sync_completed_at')
    if (!has) db.exec('ALTER TABLE device_identity ADD COLUMN first_sync_completed_at TEXT')

    // Backfill: a device that already has a camps row at migration time
    // already has SOME camp data locally — it's either the pre-existing
    // Host, or (hypothetically) a Client that already completed a sync
    // before this gate existed. Do not retroactively gate it; the gate is
    // meant to apply only to a Client pairing for the first time AFTER this
    // ships, not to punish an already-working install.
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (camp) {
      db.prepare('UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)').run(
        new Date().toISOString()
      )
    }
  })()
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (22, ?)').run(
    new Date().toISOString()
  )
}
```

Bump `CURRENT_SCHEMA_VERSION` to `22`.

**Two places set this column going forward** (the migration only backfills
retroactively, for installs that predate this feature):

1. **Host bootstrap** (wherever `bootstrapCamp`'s IPC handler in
   `electron/main.js` creates the `camps` row) additionally runs
   `UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)`
   for this device's own singleton row — a Host trivially has 100% of its
   own data from the instant of its own bootstrap and must never be gated.
2. **Client `full_sync` success** — fold the same `UPDATE` into
   `applyFullSync`'s own transaction (§2.3/§2.4), immediately after the
   domain-table inserts, so a rollback of the batch also rolls back this
   flag (correct: if the apply fails, the gate must stay closed).

### 4.2 Reading the flag from the renderer, and a push signal on completion

**New IPC read**, mirroring `getDeviceId`'s existing shape
(`electron/main.js:638-644`):

```js
// electron/main.js
function hasCompletedInitialSync(token) {
  if (!isNonEmptyString(token)) throw new Error('token is required')
  requireAuthorized(db, { token, action: 'devices.read' })
  const row = db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
  return !!(row && row.first_sync_completed_at)
}
```

Wire through `electron/preload.js` and `src/localClient.js` exactly like
every other simple read (`getDeviceId`'s three-file wiring is the template).

**New push event**, mirroring the existing `onOpApplied`/`onOpConflict`
wiring exactly (`syncClient.js` listener array → `main.js` forwards to
`mainWindow.webContents.send` → `preload.js` exposes `ipcRenderer.on` →
`localClient.js` passes through):

- `syncClient.js`: new `fullSyncAppliedListeners` array and
  `onFullSyncApplied(callback)` export; call every listener once, right
  after `applyFullSync` commits successfully in the `full_sync` branch
  (§2.4) — same point where the `full_sync_applied` ack is sent.
- `electron/main.js`: `if (typeof syncClient.onFullSyncApplied === 'function') { syncClient.onFullSyncApplied(() => { if (mainWindow) mainWindow.webContents.send('shoresh:full-sync-applied') }) }`,
  alongside the existing `onOpApplied`/`onOpConflict` wiring
  (`electron/main.js:167-174`).
- `electron/preload.js` / `src/localClient.js`: expose `onFullSyncApplied`,
  mirroring `onOpApplied`'s exact shape in both files.

### 4.3 Using both in `ScheduleScreen.jsx`

```js
const [syncReady, setSyncReady] = useState(false)

useEffect(() => {
  localClient.hasCompletedInitialSync?.().then(setSyncReady)
}, [])

useEffect(() => {
  if (typeof localClient.onFullSyncApplied !== 'function') return
  const unsub = localClient.onFullSyncApplied(() => {
    setSyncReady(true)
    loadAll() // re-run the same load already triggered by onOpApplied (ScheduleScreen.jsx:96-100)
  })
  return unsub
}, [])
```

`generate()`, `placeAnchors()`, and `restoreSnapshot()` — the three
functions that perform a `bulk_replace` against `schedule_templates`-scoped
data — each gain a guard at their top:

```js
if (!syncReady) {
  setActionError('Waiting for camp data to finish syncing from the Host — try again in a moment')
  return
}
```

Manual single-slot edits (a targeted field write to a specific, already-known
`template_slots.id`) are **not** gated — they don't carry the same risk
class: a field `UPDATE` against a row that doesn't exist locally yet
silently no-ops (via `ensureExists`) rather than destructively replacing a
whole scope the way `bulk_replace` does. Gating every write on this screen
would be a materially bigger UX change than this ticket calls for; gating
exactly the three `bulk_replace` entry points is the minimal scope that
actually closes the data-loss risk.

## Files/modules affected

- New: `electron/ops/campScopedEntities.js` (extracted registry, Part 1)
- New: `electron/ops/scheduleTemplateId.js` (`deriveScheduleTemplateId`, Part 3) — under electron/, not src/, so it survives packaging
- `electron/main.js` — import registry (Part 1); new `hasCompletedInitialSync` IPC handler and `full-sync-applied` push wiring (Part 4); `bootstrapCamp` sets `first_sync_completed_at` (Part 4)
- `electron/preload.js` — `hasCompletedInitialSync`, `onFullSyncApplied` (Part 4)
- `src/localClient.js` — same two, passthrough (Part 4)
- `electron/sync/syncServer.js` — `sendFullSyncIfFirstPairing` extended with real app-level ack wait (Part 2.4); `handleAuthenticate` computes `asOfSeq` once (Part 2.5); `sendMissedOps` signature change (Part 2.5); new `full_sync_applied` dispatch branch (Part 2.4); imports the shared registry (Part 1)
- `electron/sync/syncClient.js` — `applyFullSync` extended: new tables/order, validate-then-apply-all-or-nothing (Part 2.2/2.3), sends `full_sync_applied` ack and sets `first_sync_completed_at` on success (Part 2.4/4.1), new `onFullSyncApplied` listener export (Part 4.2)
- `electron/db/localDb.js` — new version-21 migration (re-key + `UNIQUE(camp_id)`, Part 3.4) and version-22 migration (`device_identity.first_sync_completed_at` + backfill, Part 4.1); `CURRENT_SCHEMA_VERSION` bump to 22
- `src/screens/ScheduleScreen.jsx` — `generate()`, `placeAnchors()`, `restoreSnapshot()` gated (Part 4.3); initial-load resolution hardened (Part 3.3); new `syncReady` state + two effects (Part 4.3)
- Test call sites: `electron/sync/syncServer.test.js` and any integration scenario calling `sendMissedOps` directly must add the new `asOfSeq` argument (Part 2.5)

## Required integration scenario

New file, `test/integration/scenarios/17-second-device-domain-sync.js`, following
the existing `Host`/`Client`/`pairAndLogin`/`waitFor` harness pattern used by
`06-catchup.js` and `11-snapshot-restore.js`. Must assert, end to end:

1. **Populated-camp join.** Host bootstraps, then (via a local no-network
   `createSyncClient` writer, matching `06-catchup.js`'s pattern) creates a
   handful of `groups`/`days_of_operation`/`time_blocks`/`activities`, then
   exercises `appendBulkReplaceOp` for `template_slots` to produce a real
   schedule under the Host's (now deterministic, post-migration)
   `schedule_templates.id`. A *second* device then pairs and logs in for the
   first time. Assert: the Client's local db has non-empty `groups`,
   `days_of_operation`, `time_blocks`, `activities`, `schedule_templates`,
   and `template_slots` tables; the Client's `schedule_templates.id` matches
   the Host's row exactly; the Client received a `full_sync_applied`-gated
   `hasCompletedInitialSync() === true`; and the Host's `devices.last_synced_at`
   is set only after that ack, not merely after the send.
2. **Zero-schedule join, then concurrent first-create.** Host bootstraps
   with zero `schedule_templates` rows. Client pairs (full_sync ships empty
   domain tables — assert this doesn't error, and that both sides'
   `hasCompletedInitialSync()` becomes true). Both Host and Client then
   independently call the "create template if missing" path (simulating two
   people clicking Generate near-simultaneously) using
   `deriveScheduleTemplateId(campId)` directly against their respective dbs.
   Assert both writes land on `schedule_templates.id === deriveScheduleTemplateId(campId)`
   and that after both sides sync, there is exactly **one** `schedule_templates`
   row camp-wide (not two) — a recorded, trivially-resolvable conflict on
   `camp_id`/`name` is an acceptable, expected side effect of this case, not
   a failure.
3. **Application-level apply failure does not permanently strand a device.**
   Force the Client's `applyFullSync` to throw (e.g. inject one malformed row
   that fails §2.3's validation) during a first pairing. Assert: no
   `full_sync_applied` is sent, `devices.last_synced_at` stays `NULL` on the
   Host, `first_sync_completed_at` stays `NULL` on the Client, and a
   subsequent reconnect with a corrected/valid payload successfully delivers
   and the flags then flip. This specifically covers Finding 1 — a
   transport-only ack (the first draft's mechanism) would have incorrectly
   latched in this exact scenario.
4. **Write-gate blocks a premature mutation and lifts on the completion
   push.** Pair a Client but delay/withhold its `full_sync` (e.g. pause the
   Host before calling `sendFullSyncIfFirstPairing`). Assert a simulated
   `generate()`-equivalent call is refused (or, if driving through
   `ScheduleScreen` directly isn't practical at this test's level, assert
   `hasCompletedInitialSync()` is `false` and that a `bulk_replace` attempt
   made in that state is the thing gated at the renderer, not the server —
   this scenario is about proving the *signal* the gate depends on is
   correctly `false` until the ack lands and correctly flips to `true`
   immediately after, not about re-testing IPC authorization already covered
   elsewhere).

## Open questions for Governor

1. **Cross-device build/schema-version consistency is assumed, not
   enforced.** This design (like every existing camp-scoped table in this
   app) assumes every device in a camp runs a build that agrees on schema
   version and on entity-derivation functions like
   `deriveScheduleTemplateId`. There is no protocol-level version check
   today (confirmed: no schema-version exchange in the `authenticate`
   handshake). Given the user is about to roll this out to multiple camp
   computers imminently, is "every device gets reinstalled/updated from the
   same build" an acceptable operational expectation to state explicitly
   (e.g., in user-facing install docs), or does this ticket need to also add
   a version-mismatch guard at pairing time? This is a product/rollout-process
   decision, not a technical one — the technical fix above works either way.
2. **`schedule_snapshots` exclusion from first-sync — acceptable?** A newly
   joined device's Versions/undo dropdown starts empty until the next
   snapshot is taken while it's connected. Confirming this is an acceptable
   product tradeoff (vs. the alternative of shipping potentially large
   historical JSON blobs on every join) before Maker builds to this spec.
3. **(New) Is a 15-second application-ack timeout the right bound?** A camp
   with an unusually large accumulated schedule (many groups/days/blocks over
   a long season) makes the Client's one-time `applyFullSync` transaction
   larger, and this is a one-time cost, not a recurring one — but confirming
   15s is generous enough for the largest realistic camp before Maker builds
   to this exact constant, rather than picking a number that later needs a
   follow-up ticket to loosen.
