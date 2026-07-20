# Users/Camps Cross-Machine Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user accounts genuinely sync across Host/Client machines by (1) adding a general-purpose op-log projection mechanism that applies each op onto its real domain table, (2) routing `createUser` through that mechanism instead of a direct INSERT, and (3) adding a one-time full-sync message so a newly-paired Client isn't stuck waiting for incremental ops to populate an empty `users` table.

**Architecture:** A small `PROJECTIONS` registry maps entity names to `{ table, key }`. `appendOp` (local writes) and `syncClient.js`'s remote-op handler both consult it after logging an op, running an `UPDATE` to keep the real table in sync with the log. `createUser` is rewritten to emit field-level ops instead of a direct insert. `syncServer.js` tracks a new `devices.last_synced_at` column and sends a `full_sync` message (current full `users`/`camps` contents) the first time a device successfully authenticates.

**Tech Stack:** Same as the parent plan — Node, better-sqlite3, ws, Vitest. No new dependencies.

## Global Constraints

- No comments unless the WHY is non-obvious.
- All new/modified SQL uses parameterized statements — no string concatenation.
- `applyProjection` must be entity-agnostic (usable by `template_slots` and other future entities later) — do not hardcode `users`-specific logic into `appendOp`/`applyRemoteOp` themselves; they only call `applyProjection(db, op)`.
- Every message-handling change that touches data from another process/device (the `full_sync` message) must apply the established defensive pattern from Tasks 5/6: validate shape/type before use, never let a malformed message crash the process.
- Existing tests for Tasks 1-8 (`electron/**/*.test.js`) must all continue passing — this plan modifies already-merged files (`operations.js`, `syncClient.js`, `syncServer.js`, `localAuth.js`, `schema.sql`, `localDb.js`) additively.

---

## File Structure

```
electron/
  ops/
    projections.js          - NEW: PROJECTIONS registry + applyProjection(db, op)
    projections.test.js
    operations.js            - MODIFIED: appendOp calls applyProjection after logging
  auth/
    localAuth.js              - MODIFIED: createUser emits field ops instead of direct INSERT
  sync/
    syncClient.js              - MODIFIED: applyRemoteOp calls applyProjection; new full_sync handling
    syncServer.js               - MODIFIED: send full_sync on a device's first successful auth
  db/
    schema.sql                  - MODIFIED (additive): devices.last_synced_at column, schema_migrations version 3
    localDb.js                   - MODIFIED (additive): version-3 migration insert
```

---

### Task 1: Op-log projection mechanism

**Files:**
- Create: `electron/ops/projections.js`
- Test: `electron/ops/projections.test.js`
- Modify: `electron/ops/operations.js`
- Modify: `electron/ops/operations.test.js` (add a projection-integration test)

**Interfaces:**
- Consumes: nothing new (works against any `better-sqlite3` `Database` instance).
- Produces: `applyProjection(db, op) -> void` where `op` is the same shape `appendOp`/`applyRemoteOp` already use (`{ entity, entity_id, field, value, ... }`). Exports `PROJECTIONS` (a plain object) so later tasks can register more entities.

- [ ] **Step 1: Write the failing test**

```js
// electron/ops/projections.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { applyProjection, PROJECTIONS } from './projections.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-proj-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'camp1', 'Original', 'h', 's', 'staff')
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers users', () => {
    expect(PROJECTIONS.users).toEqual({ table: 'users', key: 'id' })
  })
})

describe('applyProjection', () => {
  it('updates the real table row for a registered entity', () => {
    applyProjection(db, { entity: 'users', entity_id: 'u1', field: 'name', value: 'Updated' })
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('u1')
    expect(row.name).toBe('Updated')
  })

  it('is a no-op for an unregistered entity', () => {
    expect(() => applyProjection(db, { entity: 'not_a_real_entity', entity_id: 'x', field: 'y', value: 'z' })).not.toThrow()
  })

  it('does not throw when the target row does not exist', () => {
    expect(() => applyProjection(db, { entity: 'users', entity_id: 'nonexistent', field: 'name', value: 'X' })).not.toThrow()
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('nonexistent')
    expect(row).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ops/projections.test.js`
Expected: FAIL with "Cannot find module './projections.js'"

- [ ] **Step 3: Implement projections.js**

```js
// electron/ops/projections.js
export const PROJECTIONS = {
  users: { table: 'users', key: 'id' },
}

export function applyProjection(db, op) {
  const projection = PROJECTIONS[op.entity]
  if (!projection) return
  db.prepare(`UPDATE ${projection.table} SET ${op.field} = ? WHERE ${projection.key} = ?`)
    .run(op.value, op.entity_id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ops/projections.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire applyProjection into appendOp**

Modify `electron/ops/operations.js`: import `applyProjection` from `./projections.js`, call it inside `appendOp` after the `INSERT INTO operations` statement runs, before `return op`.

```js
// electron/ops/operations.js (relevant excerpt after modification)
import { randomUUID } from 'node:crypto'
import { applyProjection } from './projections.js'

export function appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id }) {
  const op = {
    id: randomUUID(),
    entity,
    entity_id,
    field,
    value,
    author_user_id,
    device_id,
    timestamp: new Date().toISOString(),
    parent_op_id: parent_op_id ?? null,
  }
  db.prepare(`INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
    VALUES (@id, @entity, @entity_id, @field, @value, @author_user_id, @device_id, @timestamp, @parent_op_id)`).run(op)
  applyProjection(db, op)
  return op
}
```

- [ ] **Step 6: Write a failing integration test in operations.test.js**

Add to `electron/ops/operations.test.js`:

```js
describe('appendOp projection integration', () => {
  it('updates the real users row when entity is users', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp2', 'Camp Two')
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u2', 'camp2', 'Before', 'h', 's', 'staff')
    appendOp(db, { entity: 'users', entity_id: 'u2', field: 'name', value: 'After', author_user_id: 'u1', device_id: 'd1', parent_op_id: null })
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('u2')
    expect(row.name).toBe('After')
  })
})
```

- [ ] **Step 7: Run test to verify it fails then passes**

Run: `npx vitest run electron/ops/operations.test.js`
Expected: FAIL first (no `applyProjection` call yet — revert Step 5 mentally to confirm the red state if needed, then apply Step 5's change), then PASS after Step 5 is in place.

- [ ] **Step 8: Run the full existing operations.test.js suite to confirm no regressions**

Run: `npx vitest run electron/ops/operations.test.js`
Expected: PASS (all original tests plus the new one)

- [ ] **Step 9: Commit**

```bash
git add electron/ops/projections.js electron/ops/projections.test.js electron/ops/operations.js electron/ops/operations.test.js
git commit -m "feat: add op-log projection mechanism, wire into appendOp"
```

**CORRECTION (found during Sync-Task 1's round-1 review, applies before Task 2/3 build on it) — the design above is broken and must be fixed as part of Task 1 itself before proceeding:**

1. **UPDATE-only cannot create new rows.** Task 3's `createUser` plan requires the FIRST field-level op for a brand-new `entity_id` to actually create the `users` row. A bare `UPDATE ... WHERE id = ?` against a nonexistent row affects zero rows and silently does nothing — `createUser` would report success while never creating the user. Fix: extend each `PROJECTIONS` entry with an `ensureExists(db, entity_id)` function that `INSERT OR IGNORE`s a placeholder row with safe defaults for any `NOT NULL`/`CHECK`-constrained columns before the `UPDATE` runs (the subsequent field-level `UPDATE`s from the same batch immediately overwrite the placeholder values with real ones). For `users`: `{ table: 'users', key: 'id', fields: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'], ensureExists: (db, id) => db.prepare("INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, '', '', '', '', 'staff')").run(id) }` (empty-string placeholders for the `NOT NULL TEXT` columns, `'staff'` as a valid default satisfying the `role` `CHECK` constraint — all four get overwritten by `createUser`'s real field ops in the same transaction, see point 3).
2. **`op.field` is interpolated into SQL with no validation — a real, exploitable column-rewrite vector.** An authenticated device can submit `submit_op` with `entity: 'users'` and a crafted `field` string to rewrite arbitrary columns (e.g. escalate `role`, overwrite `pin_hash`). Fix: each `PROJECTIONS` entry now includes a `fields` allowlist (see point 1's example); `applyProjection` must check `PROJECTIONS[op.entity].fields.includes(op.field)` and no-op (not throw) if the field isn't in the allowlist, BEFORE building any SQL string with it.
3. **No transaction wrapping the op-log insert + projection.** A crash or a rejected/no-op'd field between them leaves the log and the live table permanently diverged, and (combined with point 2's fix) a rejected field would otherwise still have its `operations` row committed even though nothing was ever projected. Fix: wrap `appendOp`'s body (`INSERT INTO operations` + `applyProjection` call) in `db.transaction(() => { ... })()` so both succeed or neither does.

Re-open Task 1 and apply these three fixes before Task 2 begins — Task 2/3 below already assume the corrected interface (`ensureExists`, `fields` allowlist, transactional `appendOp`).

**SECOND CORRECTION (found during Sync-Task 1's round-2 review — the round-2 fix for point 1 above was itself flawed):** Point 1's `ensureExists` used a sentinel `camps` row (`id: ''`, `name: ''`) to satisfy the `users.camp_id` foreign key when creating a placeholder row. This was wrong in two ways: (a) `main.js`'s `login` (`SELECT id FROM camps LIMIT 1`) and `bootstrapCamp` (`SELECT COUNT(*) FROM camps`) have no filter distinguishing the sentinel from a real camp, so the sentinel can silently break login or block bootstrap; (b) every new user's placeholder collides on the same sentinel `(camp_id: '', name: '')` pair under the `UNIQUE(camp_id, name)` index, so a second concurrent user-creation's placeholder insert is silently swallowed by `INSERT OR IGNORE`, reintroducing the original "user never created" bug under concurrency.

**Corrected fix — relax `users.camp_id` to allow `NULL` instead of using a sentinel camp row:**
- Add a schema migration (version 4, using Task 1's `schema_migrations` versioning hook) that rebuilds the `users` table with `camp_id TEXT REFERENCES camps(id)` (nullable — no `NOT NULL`), since SQLite doesn't support dropping a `NOT NULL` constraint via `ALTER TABLE`:
  ```sql
  CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    camp_id TEXT REFERENCES camps(id),
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
  );
  INSERT INTO users_new SELECT * FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_camp_name ON users(camp_id, name);
  ```
  Run this inside `initSchema` guarded by `getSchemaVersion(db) < 4`, same idempotency pattern as the version-2/3 migrations, and insert `(4, <timestamp>)` into `schema_migrations` afterward.
- Update `PROJECTIONS['users'].ensureExists` to: `(db, id) => db.prepare("INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, NULL, '', '', '', 'staff')").run(id)` — no `camps` table touched at all. SQLite foreign keys are not checked against a `NULL` value, so this satisfies the FK without needing any camp row to exist.
- This also fixes the concurrency collision for free: SQLite's `UNIQUE` index treats `NULL` as distinct from every other `NULL` (two rows with `camp_id: NULL, name: ''` do NOT violate `UNIQUE(camp_id, name)`), so two users being created concurrently no longer collide on a shared placeholder identity — each gets its own row, and normal duplicate-name detection still works correctly once real (non-null) `camp_id`/`name` values are set by their respective `UPDATE`s.
- Remove all sentinel-`camps`-row logic from `ensureExists` entirely — it should never touch the `camps` table.

Re-open Task 1 again and apply this corrected fix — this supersedes point 1's original `ensureExists` implementation above (points 2 and 3 from the first correction are unaffected and remain as specified).

**THIRD CORRECTION (found during Sync-Task 1's round-3 review) — small, mechanical fixes, no further redesign needed:**
1. **Wrap the version-4 migration in a transaction.** The `CREATE TABLE users_new` / `INSERT INTO users_new SELECT * FROM users` / `DROP TABLE users` / `RENAME` / `CREATE UNIQUE INDEX` sequence currently runs as an untransacted multi-statement `db.exec()` — a mid-sequence failure (constraint violation, disk/IO error) can leave the `users` table half-migrated or entirely lost. Fix: wrap the whole sequence in `db.transaction(() => { db.exec('CREATE TABLE users_new (...); INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users; CREATE UNIQUE INDEX IF NOT EXISTS idx_users_camp_name ON users(camp_id, name);') })()` (or split into individual `.prepare().run()`/`.exec()` calls inside the same `db.transaction(() => {...})()` wrapper — either is fine, the requirement is that all of it either fully commits or fully rolls back).
2. **Fix `schema.sql`'s `users` table definition to declare `camp_id TEXT` (no `NOT NULL`)**, matching the post-migration final state. This is cosmetic for existing/migrated databases (the version-4 migration already fixes any pre-existing db) but matters for a genuinely fresh install: right now `schema.sql`'s `CREATE TABLE IF NOT EXISTS users` still creates `camp_id NOT NULL`, and the version-4 migration then immediately rebuilds it to nullable on the very next line of `initSchema` — harmless but wasteful and confusing for anyone reading `schema.sql` expecting it to reflect final state. Update `schema.sql` directly; the version-4 migration in `localDb.js` can then become a no-op table-rebuild guard for pre-existing databases only (still needed for anyone who already has a database at schema version < 4), or simply detect via `PRAGMA table_info(users)` whether `camp_id` is already nullable and skip the rebuild if so — use your judgment on the cleanest way to avoid the redundant rebuild on brand-new installs while still fixing existing ones.
3. **Resolve the `appendOp`-throws vs `applyProjection`-no-ops inconsistency by documentation, not code change.** `appendOp` throwing on a disallowed field (fail-fast, already tested and correct) is the right behavior for the local-write path. `applyProjection`'s own no-op branch exists for defense-in-depth on paths that don't pre-validate (e.g. Task 2's future remote-op path, if it ever calls `applyProjection` directly without going through `appendOp`'s validation first) — this is intentional layered defense, not a bug, and does not need to change. No code change required for this item; it's noted here only so a future reader isn't confused by the apparent inconsistency.

---

### Task 2: Wire projection into remote op application (syncClient)

**Files:**
- Modify: `electron/sync/syncClient.js`
- Modify: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: `applyProjection` (Task 1).
- Produces: no new exports — `applyRemoteOp`'s existing behavior gains a projection side-effect.

- [ ] **Step 1: Write the failing test**

Add to `electron/sync/syncClient.test.js` (adapt to the file's existing db/server setup helpers):

```js
it('projects a remote op_applied onto the real users table', async () => {
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
  hostDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'camp1', 'Before', 'h', 's', 'staff')
  clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
  clientDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'camp1', 'Before', 'h', 's', 'staff')

  const client = createSyncClient(clientDb, { device_id: 'd2', author_user_id: 'u1', serverUrl: `ws://localhost:${port}` })
  await client.waitUntilConnected()
  await client.write({ entity: 'users', entity_id: 'u1', field: 'name', value: 'After' })

  const clientRow = clientDb.prepare('SELECT name FROM users WHERE id = ?').get('u1')
  expect(clientRow.name).toBe('After')
  client.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: FAIL — `clientRow.name` is still `'Before'` since `applyRemoteOp` doesn't project yet.

- [ ] **Step 3: Wire applyProjection into applyRemoteOp**

Modify `electron/sync/syncClient.js`: import `applyProjection` from `../ops/projections.js`, call it inside `applyRemoteOp` after the `INSERT INTO operations ... ON CONFLICT(id) DO NOTHING` statement.

```js
// electron/sync/syncClient.js (relevant excerpt after modification)
import { applyProjection } from '../ops/projections.js'

function applyRemoteOp(op) {
  db.prepare(
    `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(op.id, op.entity, op.entity_id, op.field, op.value, op.author_user_id ?? null, op.device_id, op.timestamp, op.parent_op_id ?? null)
  applyProjection(db, op)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS (all tests including the new one)

- [ ] **Step 5: Commit**

```bash
git add electron/sync/syncClient.js electron/sync/syncClient.test.js
git commit -m "feat: project remote ops onto their live domain table in syncClient"
```

---

### Task 3: Route createUser through the op-log

**Files:**
- Modify: `electron/auth/localAuth.js`
- Modify: `electron/auth/localAuth.test.js`

**Interfaces:**
- Consumes: `appendOp` (Task 2, already existed — `createUser` now calls it instead of a direct `INSERT`).
- Produces: `createUser(db, { camp_id, name, pin, role, device_id }) -> { id, name, role }` — same return shape as before, but now requires a `device_id` argument (needed to attribute the ops) that the original signature didn't have. **This is an interface change** — callers of `createUser` (Task 8's `main.js`, both `shoresh:create-user` and `shoresh:bootstrap-camp` handlers) must be updated to pass their own `deviceId` through. This task only changes `localAuth.js` and its tests; a follow-up task updates `main.js`'s call sites.

- [ ] **Step 1: Write the failing test**

Modify the existing `createUser`/`verifyPin` tests in `electron/auth/localAuth.test.js` to pass a `device_id` (e.g. seed a `devices` row and pass its id), and add:

```js
describe('createUser routes through the op-log', () => {
  it('creates one operation per field, all sharing the new user id', () => {
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Dev1')
    const user = createUser(db, { camp_id: 'camp1', name: 'Priya', pin: '1234', role: 'staff', device_id: 'd1' })
    const ops = db.prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ?').all('users', user.id)
    const fields = ops.map(o => o.field).sort()
    expect(fields).toEqual(['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'])
    expect(ops.every(o => o.parent_op_id === null)).toBe(true)
  })

  it('still creates a real, queryable users row (via projection)', () => {
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Dev1')
    const user = createUser(db, { camp_id: 'camp1', name: 'Priya', pin: '1234', role: 'staff', device_id: 'd1' })
    const row = db.prepare('SELECT name, role FROM users WHERE id = ?').get(user.id)
    expect(row).toEqual({ name: 'Priya', role: 'staff' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: FAIL — no `operations` rows exist yet since `createUser` still does a direct `INSERT`.

- [ ] **Step 3: Rewrite createUser**

```js
// electron/auth/localAuth.js (relevant excerpt after modification)
import { randomUUID, randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto'
import { appendOp } from '../ops/operations.js'

// ...assertValidPin, hashPin unchanged...

export function createUser(db, { camp_id, name, pin, role, device_id }) {
  assertValidPin(pin)
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = hashPin(pin, salt)
  const fields = { camp_id, name, pin_hash, pin_salt: salt, role }
  for (const [field, value] of Object.entries(fields)) {
    appendOp(db, { entity: 'users', entity_id: id, field, value, author_user_id: null, device_id, parent_op_id: null })
  }
  return { id, name, role }
}
```

Note: the existing `UNIQUE(camp_id, name)` constraint and `SQLITE_CONSTRAINT_UNIQUE` error-friendlying (Task 3 round 2) now needs to move to wherever the `name` field's `applyProjection` UPDATE runs (inside `appendOp` → `applyProjection`, Task 1) — catch the constraint violation in `createUser`'s loop around the `appendOp` call for the `name` field specifically, and re-throw the same friendly `Error('A user named "${name}" already exists in this camp')` as before.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: PASS (all tests, including the original round-1/round-2 tests updated to pass `device_id`, plus the two new ones)

- [ ] **Step 5: Update main.js call sites**

Modify `electron/main.js`: both the `shoresh:create-user` handler and the `shoresh:bootstrap-camp` handler's `createUser(db, {...})` calls now pass `device_id: deviceId` (the module-level persisted device id already in scope).

- [ ] **Step 6: Run the full main.test.js suite to confirm no regressions**

Run: `npx vitest run electron/main.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add electron/auth/localAuth.js electron/auth/localAuth.test.js electron/main.js
git commit -m "feat: route createUser through the op-log instead of a direct insert"
```

---

### Task 4: Full-sync on first pairing

**Files:**
- Modify: `electron/db/schema.sql` (additive)
- Modify: `electron/db/localDb.js` (additive migration)
- Modify: `electron/db/localDb.migrations.test.js`
- Modify: `electron/sync/syncServer.js`
- Modify: `electron/sync/syncServer.test.js`
- Modify: `electron/sync/syncClient.js`
- Modify: `electron/sync/syncClient.test.js`

**Interfaces:**
- Produces: a new wire message `{ type: 'full_sync', users: [...], camps: [...] }` sent server→client once, immediately after a device's first successful `authenticate`.

- [ ] **Step 1: Add the schema migration**

Add to `electron/db/schema.sql`: `ALTER TABLE devices ADD COLUMN last_synced_at TEXT;` — note `ALTER TABLE ... ADD COLUMN` is not idempotent under `IF NOT EXISTS` in SQLite; guard it in `initSchema` instead (Step 2).

- [ ] **Step 2: Guard the migration in localDb.js**

Modify `electron/db/localDb.js`'s `initSchema(db)`: after the existing version-1/version-2 migration inserts, check `getSchemaVersion(db) < 3`; if so, run `db.exec('ALTER TABLE devices ADD COLUMN last_synced_at TEXT')` inside a try/catch (SQLite has no `ADD COLUMN IF NOT EXISTS`; catching a "duplicate column" error keeps re-runs safe) and insert `(3, <timestamp>)` into `schema_migrations`.

- [ ] **Step 3: Write a failing test for the migration**

Add to `electron/db/localDb.migrations.test.js`:

```js
it('adds last_synced_at to devices and reaches schema version 3', () => {
  expect(() => db.prepare('SELECT last_synced_at FROM devices').all()).not.toThrow()
  expect(getSchemaVersion(db)).toBe(3)
})
```

- [ ] **Step 4: Run test to verify it fails, then implement Steps 1-2, then verify it passes**

Run: `npx vitest run electron/db/localDb.migrations.test.js`
Expected: FAIL then PASS (3 tests plus prior ones, version now 3)

- [ ] **Step 5: Write the failing full_sync round-trip test**

Add to `electron/sync/syncServer.test.js`:

```js
it('sends full_sync to a device on its first successful authentication', async () => {
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u2', 'camp1', 'ExistingStaff', 'h', 's', 'staff')
  const token = issueSessionToken('u1', 'd1')
  const client = await connect(port)
  const fullSyncPromise = nextMessage(client)
  client.send(JSON.stringify({ type: 'authenticate', token, device_id: 'd1' }))
  const msg = await fullSyncPromise
  expect(msg.type).toBe('full_sync')
  expect(msg.users.some(u => u.id === 'u2')).toBe(true)
  expect(msg.camps.some(c => c.id === 'camp1')).toBe(true)
  client.close()
})

it('does not send full_sync again on a device\'s second authentication', async () => {
  const token = issueSessionToken('u1', 'd1')
  const first = await connect(port)
  first.send(JSON.stringify({ type: 'authenticate', token, device_id: 'd1' }))
  await new Promise(r => setTimeout(r, 50))
  first.close()

  const second = await connect(port)
  let gotFullSync = false
  second.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === 'full_sync') gotFullSync = true
  })
  second.send(JSON.stringify({ type: 'authenticate', token, device_id: 'd1' }))
  await new Promise(r => setTimeout(r, 100))
  expect(gotFullSync).toBe(false)
  second.close()
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: FAIL — no `full_sync` message is ever sent.

- [ ] **Step 7: Implement full_sync sending in syncServer.js**

```js
// electron/sync/syncServer.js (relevant excerpt after modification)
function handleAuthenticate(ws, msg) {
  const verified = verifySessionToken(msg.token)
  if (!verified || verified.deviceId !== msg.device_id) {
    ws.close()
    return
  }
  ws.deviceId = verified.deviceId
  ws.userId = verified.userId

  const device = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(ws.deviceId)
  if (device && !device.last_synced_at) {
    const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
    const camps = db.prepare('SELECT id, name FROM camps').all()
    send(ws, { type: 'full_sync', users, camps })
    db.prepare('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(new Date().toISOString(), ws.deviceId)
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: PASS (all tests including the two new ones)

- [ ] **Step 9: Write the failing client-side full_sync handling test**

Add to `electron/sync/syncClient.test.js`:

```js
it('bulk-loads users/camps from a full_sync message', async () => {
  const client = createSyncClient(clientDb, { device_id: 'd4', author_user_id: 'u1', serverUrl: `ws://localhost:${port}` })
  await client.waitUntilConnected()
  await new Promise(r => setTimeout(r, 100))
  const row = clientDb.prepare('SELECT * FROM users WHERE id = ?').get('u2')
  expect(row).toBeTruthy()
  client.close()
})
```

(Seed `hostDb` with a `u2` user before this test runs, matching Step 5's server-side seeding pattern.)

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: FAIL — the client doesn't handle `full_sync` yet.

- [ ] **Step 11: Implement full_sync handling in syncClient.js**

```js
// electron/sync/syncClient.js (add inside the ws.on('message', ...) dispatch, alongside lock_result/op_applied/op_conflict)
function isValidUserRow(u) {
  return u !== null && typeof u === 'object' && !Array.isArray(u)
    && isNonEmptyString(u.id) && isNonEmptyString(u.camp_id) && isNonEmptyString(u.name)
    && isNonEmptyString(u.pin_hash) && isNonEmptyString(u.pin_salt)
    && (u.role === 'admin' || u.role === 'staff')
}

function isValidCampRow(c) {
  return c !== null && typeof c === 'object' && !Array.isArray(c)
    && isNonEmptyString(c.id) && isNonEmptyString(c.name)
}

function applyFullSync(msg) {
  if (!Array.isArray(msg.users) || !Array.isArray(msg.camps)) return
  for (const camp of msg.camps) {
    if (!isValidCampRow(camp)) continue
    db.prepare('INSERT OR REPLACE INTO camps (id, name) VALUES (?, ?)').run(camp.id, camp.name)
  }
  for (const user of msg.users) {
    if (!isValidUserRow(user)) continue
    db.prepare(`INSERT OR REPLACE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(user.id, user.camp_id, user.name, user.pin_hash, user.pin_salt, user.role)
  }
}

// inside the message dispatch, alongside the existing type checks:
if (msg.type === 'full_sync') {
  applyFullSync(msg)
  return
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS (all tests including the new one)

- [ ] **Step 13: Run the FULL test suite to confirm no regressions across all prior tasks**

Run: `npx vitest run`
Expected: all test files pass

- [ ] **Step 14: Commit**

```bash
git add electron/db/schema.sql electron/db/localDb.js electron/db/localDb.migrations.test.js electron/sync/syncServer.js electron/sync/syncServer.test.js electron/sync/syncClient.js electron/sync/syncClient.test.js
git commit -m "feat: add one-time full-sync of users/camps on first device pairing"
```

---

## Self-Review Notes

- **Spec coverage:** all 5 components from the design spec's table have a corresponding task (Task 1: projections registry; Task 2: syncClient wiring; Task 3: createUser rewrite; Task 4: schema migration + full-sync send/receive). Merge-screen PIN-display handling is explicitly deferred to Task 10 of the parent plan (not this sync-focused plan), consistent with the design spec's scope.
- **Type consistency checked:** `applyProjection(db, op)`'s `op` shape matches exactly what `appendOp`/`applyRemoteOp` already produce/consume across Tasks 1-4. `createUser`'s new required `device_id` parameter is threaded through to its only two call sites (`main.js`'s create-user and bootstrap-camp handlers) in Task 3.
- **Out of scope (per design spec):** general snapshot-transfer for all entities, camp-level peer-editing, user deletion/cascade — none of these are implemented here, matching the spec's "Out of Scope" section.
