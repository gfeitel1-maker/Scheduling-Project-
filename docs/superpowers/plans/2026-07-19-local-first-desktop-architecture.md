# Local-First Desktop Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Shoresh's Supabase-hosted data layer with a local SQLite database, wrapped in an Electron desktop app, where one machine (Host) holds the source of truth and other staff machines (Clients) sync to it over the LAN, with local PIN auth and hybrid online-lock / offline-branch-and-merge conflict resolution.

**Architecture:** Electron main process owns a SQLite database (`better-sqlite3`) and, in Host mode, a WebSocket sync server advertised via mDNS. Every write is appended to an `operations` log rather than applied as a raw overwrite; the sync server grants per-record locks to online writers and rebroadcasts committed ops to all connected clients. Offline writes queue locally and reconcile against the op log on reconnect; true conflicts (same field, diverged since last common op) are surfaced as named versions in a merge screen instead of being auto-resolved. The existing React 19 renderer and `buildSchedule.js` engine are unchanged — only the data-access layer (`src/supabase.js` and its callers) is swapped for a new local client that talks to the main process over Electron IPC.

**Tech Stack:** Electron, better-sqlite3, ws (WebSocket), bonjour-service (mDNS), Node's built-in `crypto.scrypt` for PIN hashing, Vitest (existing), React 19 (existing, unchanged).

## Global Constraints

- All UI styling stays inline React style objects — no CSS files, no className for styling (per project CLAUDE.md).
- No Supabase, no RLS, no cloud auth anywhere in the new code paths.
- `buildSchedule.js` remains a pure function with no changes to its signature.
- Every op-log entry must be attributable: `{ id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id }`.
- SQLite access only happens in the Electron main process; the renderer never opens the DB file directly — it goes through `window.shoresh` (preload-exposed IPC).
- New Node-side modules (everything under `electron/`) use `// @vitest-environment node` at the top of their test files since the project's default Vitest environment is jsdom (browser-oriented, for the existing React tests).

---

## File Structure

```
electron/
  main.js                 - Electron entry point; boots DB, auth, sync server/client based on mode
  preload.js               - contextBridge exposing window.shoresh.* to the renderer
  db/
    schema.sql              - SQLite DDL for all tables
    localDb.js               - opens DB file, runs schema, exposes prepared-statement helpers
    localDb.test.js
  ops/
    operations.js            - append/apply op-log entries, common-ancestor conflict detection
    operations.test.js
  auth/
    localAuth.js             - create user, verify PIN (scrypt), issue/verify session tokens
    localAuth.test.js
  sync/
    lockManager.js            - acquire/release/expire per-record locks
    lockManager.test.js
    syncServer.js              - WebSocket server: connection handling, lock requests, op broadcast, mDNS advertise
    syncServer.test.js
    syncClient.js              - connects to a host, sends local ops, queues when offline, applies incoming ops
    syncClient.test.js
    discovery.js               - mDNS advertise (host) / browse (client) thin wrapper over bonjour-service
src/
  localClient.js            - renderer-side replacement for supabase.js; thin wrapper over window.shoresh
  screens/
    MergeScreen.jsx          - conflict resolution UI, registered in SCREENS in App.jsx
package.json                - add electron, better-sqlite3, ws, bonjour-service deps + electron dev/build scripts
```

---

### Task 1: SQLite schema and local-db module

**Files:**
- Create: `electron/db/schema.sql`
- Create: `electron/db/localDb.js`
- Test: `electron/db/localDb.test.js`

**Interfaces:**
- Produces: `openLocalDb(filePath: string) -> Database` (a `better-sqlite3` instance with schema applied, `PRAGMA foreign_keys = ON`), and `initSchema(db: Database) -> void`.

- [ ] **Step 1: Add dependencies**

```bash
npm install better-sqlite3
```

- [ ] **Step 2: Write the schema**

```sql
-- electron/db/schema.sql
CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  timestamp TEXT NOT NULL,
  parent_op_id TEXT REFERENCES operations(id)
);
CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity, entity_id, field);

CREATE TABLE IF NOT EXISTS locks (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  holder_device_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, field)
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  tier_id TEXT,
  availability TEXT
);

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_slots (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  group_id TEXT REFERENCES groups(id),
  activity_id TEXT REFERENCES activities(id),
  day_id TEXT,
  time_block_id TEXT
);
```

- [ ] **Step 3: Write the failing test**

```js
// electron/db/localDb.test.js
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from './localDb.js'

let tmpFile

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('openLocalDb', () => {
  it('creates all expected tables', () => {
    tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}.sqlite`)
    const db = openLocalDb(tmpFile)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    expect(tables).toEqual(expect.arrayContaining([
      'camps', 'users', 'devices', 'operations', 'locks', 'groups', 'tiers', 'activities', 'template_slots',
    ]))
    db.close()
  })

  it('enforces foreign keys', () => {
    tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}.sqlite`)
    const db = openLocalDb(tmpFile)
    expect(() => {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'nonexistent-camp', 'Aleph')
    }).toThrow()
    db.close()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run electron/db/localDb.test.js`
Expected: FAIL with "Cannot find module './localDb.js'"

- [ ] **Step 5: Implement localDb.js**

```js
// electron/db/localDb.js
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function initSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
}

export function openLocalDb(filePath) {
  const db = new Database(filePath)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run electron/db/localDb.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add electron/db/schema.sql electron/db/localDb.js electron/db/localDb.test.js package.json package-lock.json
git commit -m "feat: add SQLite schema and local-db module"
```

---

### Task 2: Operation log — append and conflict detection

**Files:**
- Create: `electron/ops/operations.js`
- Test: `electron/ops/operations.test.js`

**Interfaces:**
- Consumes: `openLocalDb` from Task 1 (`electron/db/localDb.js`).
- Produces:
  - `appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id }) -> op` (adds `id`, `timestamp`, inserts row, returns full op object).
  - `latestOp(db, entity, entity_id, field) -> op | undefined`.
  - `detectConflict(db, incomingOp) -> { conflict: boolean, existingOp?: op }` — conflict is true when there is a `latestOp` for that `entity/entity_id/field` whose `id` is neither `incomingOp.parent_op_id` nor `incomingOp.id`, and whose `id` differs from what the incoming op descends from.

- [ ] **Step 1: Write the failing test**

```js
// electron/ops/operations.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp, detectConflict } from './operations.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ops-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'camp1', 'Sarah', 'x', 'y', 'staff')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Sarahs-Laptop')
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('appendOp', () => {
  it('inserts an op and returns it with id and timestamp', () => {
    const op = appendOp(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1', author_user_id: 'u1', device_id: 'd1', parent_op_id: null })
    expect(op.id).toBeTruthy()
    expect(op.timestamp).toBeTruthy()
    expect(latestOp(db, 'template_slots', 's1', 'activity_id').id).toBe(op.id)
  })
})

describe('detectConflict', () => {
  it('reports no conflict when incoming op descends from the current latest op', () => {
    const first = appendOp(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1', author_user_id: 'u1', device_id: 'd1', parent_op_id: null })
    const incoming = { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a2', parent_op_id: first.id }
    expect(detectConflict(db, incoming).conflict).toBe(false)
  })

  it('reports a conflict when two ops diverge from the same parent', () => {
    const first = appendOp(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1', author_user_id: 'u1', device_id: 'd1', parent_op_id: null })
    appendOp(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a2', author_user_id: 'u1', device_id: 'd1', parent_op_id: first.id })
    const incomingFromOtherDevice = { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a3', parent_op_id: first.id }
    const result = detectConflict(db, incomingFromOtherDevice)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.value).toBe('a2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ops/operations.test.js`
Expected: FAIL with "Cannot find module './operations.js'"

- [ ] **Step 3: Implement operations.js**

```js
// electron/ops/operations.js
import { randomUUID } from 'node:crypto'

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
  return op
}

export function latestOp(db, entity, entity_id, field) {
  return db.prepare(`SELECT * FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(entity, entity_id, field)
}

export function detectConflict(db, incomingOp) {
  const existing = latestOp(db, incomingOp.entity, incomingOp.entity_id, incomingOp.field)
  if (!existing) return { conflict: false }
  if (existing.id === incomingOp.parent_op_id) return { conflict: false }
  return { conflict: true, existingOp: existing }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ops/operations.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/ops/operations.js electron/ops/operations.test.js
git commit -m "feat: add operation log append and conflict detection"
```

---

### Task 3: Local auth — users and PIN verification

**Files:**
- Create: `electron/auth/localAuth.js`
- Test: `electron/auth/localAuth.test.js`

**Interfaces:**
- Consumes: `openLocalDb` (Task 1).
- Produces:
  - `createUser(db, { camp_id, name, pin, role }) -> { id, name, role }`.
  - `verifyPin(db, userId, pin) -> boolean`.
  - `issueSessionToken(userId, deviceId) -> string` (signed, non-persisted JWT-like token: base64 payload + HMAC using a per-install secret stored in `electron/auth/localAuth.js`-managed file, but for this task scope: a simple opaque token stored in-memory via `verifySessionToken`).
  - `verifySessionToken(token) -> { userId, deviceId } | null`.

- [ ] **Step 1: Write the failing test**

```js
// electron/auth/localAuth.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './localAuth.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-auth-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('createUser / verifyPin', () => {
  it('verifies the correct PIN and rejects an incorrect one', () => {
    const user = createUser(db, { camp_id: 'camp1', name: 'Sarah', pin: '1234', role: 'staff' })
    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '9999')).toBe(false)
  })

  it('never stores the raw PIN', () => {
    const user = createUser(db, { camp_id: 'camp1', name: 'Tom', pin: '5678', role: 'admin' })
    const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(user.id)
    expect(row.pin_hash).not.toBe('5678')
  })
})

describe('session tokens', () => {
  it('round-trips userId and deviceId through a token', () => {
    const token = issueSessionToken('u1', 'd1')
    expect(verifySessionToken(token)).toEqual({ userId: 'u1', deviceId: 'd1' })
  })

  it('rejects a tampered token', () => {
    const token = issueSessionToken('u1', 'd1')
    expect(verifySessionToken(token + 'x')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: FAIL with "Cannot find module './localAuth.js'"

- [ ] **Step 3: Implement localAuth.js**

```js
// electron/auth/localAuth.js
import { randomUUID, randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto'

const SESSION_SECRET = randomBytes(32) // per-process; acceptable for a locally-run desktop app

function hashPin(pin, salt) {
  return scryptSync(pin, salt, 64).toString('hex')
}

export function createUser(db, { camp_id, name, pin, role }) {
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = hashPin(pin, salt)
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, camp_id, name, pin_hash, salt, role)
  return { id, name, role }
}

export function verifyPin(db, userId, pin) {
  const user = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').get(userId)
  if (!user) return false
  const candidate = hashPin(pin, user.pin_salt)
  const a = Buffer.from(candidate, 'hex')
  const b = Buffer.from(user.pin_hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function issueSessionToken(userId, deviceId) {
  const payload = Buffer.from(JSON.stringify({ userId, deviceId })).toString('base64url')
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token) {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expectedSig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  if (sig.length !== expectedSig.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/auth/localAuth.js electron/auth/localAuth.test.js
git commit -m "feat: add local PIN auth and session tokens"
```

---

### Task 4: Lock manager

**Files:**
- Create: `electron/sync/lockManager.js`
- Test: `electron/sync/lockManager.test.js`

**Interfaces:**
- Produces:
  - `acquireLock(db, { entity, entity_id, field, device_id }) -> { granted: boolean, holder_device_id?: string }`.
  - `releaseLock(db, { entity, entity_id, field, device_id }) -> void` (no-op if a different device holds it).
  - `expireLocks(db, olderThanMs) -> number` (releases stale locks, returns count released — guards against a client crashing while holding a lock).

- [ ] **Step 1: Write the failing test**

```js
// electron/sync/lockManager.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { acquireLock, releaseLock, expireLocks } from './lockManager.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-lock-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('acquireLock', () => {
  it('grants a lock to the first requester', () => {
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    expect(result.granted).toBe(true)
  })

  it('denies a lock held by another device', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(false)
    expect(result.holder_device_id).toBe('d1')
  })

  it('re-grants to the same device that already holds it', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    expect(result.granted).toBe(true)
  })
})

describe('releaseLock', () => {
  it('frees the lock for others to acquire', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    releaseLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(true)
  })
})

describe('expireLocks', () => {
  it('releases locks older than the given threshold', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    db.prepare("UPDATE locks SET acquired_at = datetime('now', '-1 hour')").run()
    const released = expireLocks(db, 60_000)
    expect(released).toBe(1)
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/sync/lockManager.test.js`
Expected: FAIL with "Cannot find module './lockManager.js'"

- [ ] **Step 3: Implement lockManager.js**

```js
// electron/sync/lockManager.js
export function acquireLock(db, { entity, entity_id, field, device_id }) {
  const existing = db.prepare('SELECT * FROM locks WHERE entity = ? AND entity_id = ? AND field = ?')
    .get(entity, entity_id, field)
  if (existing && existing.holder_device_id !== device_id) {
    return { granted: false, holder_device_id: existing.holder_device_id }
  }
  db.prepare(`INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity, entity_id, field) DO UPDATE SET holder_device_id = excluded.holder_device_id, acquired_at = excluded.acquired_at`)
    .run(entity, entity_id, field, device_id)
  return { granted: true }
}

export function releaseLock(db, { entity, entity_id, field, device_id }) {
  db.prepare('DELETE FROM locks WHERE entity = ? AND entity_id = ? AND field = ? AND holder_device_id = ?')
    .run(entity, entity_id, field, device_id)
}

export function expireLocks(db, olderThanMs) {
  const cutoffSeconds = Math.floor(olderThanMs / 1000)
  const result = db.prepare(`DELETE FROM locks WHERE acquired_at < datetime('now', '-' || ? || ' seconds')`)
    .run(cutoffSeconds)
  return result.changes
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/sync/lockManager.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/sync/lockManager.js electron/sync/lockManager.test.js
git commit -m "feat: add per-record lock manager"
```

---

### Task 5: Sync server (Host)

**Files:**
- Create: `electron/sync/syncServer.js`
- Test: `electron/sync/syncServer.test.js`

**Interfaces:**
- Consumes: `openLocalDb` (Task 1), `appendOp`/`detectConflict` (Task 2), `verifySessionToken` (Task 3), `acquireLock`/`releaseLock`/`expireLocks` (Task 4).
- Produces: `startSyncServer(db, { port }) -> { wss, close(): void }` (`close()` also clears the periodic expiry interval, see note below). Wire protocol (JSON messages over WebSocket):
  - Client → Server (must be the first message on a new connection): `{ type: 'authenticate', token, device_id }`
  - Client → Server: `{ type: 'acquire_lock', entity, entity_id, field }` (no `device_id` — the server uses the connection's authenticated `ws.deviceId`)
  - Server → Client: `{ type: 'lock_result', granted, holder_device_id? }`
  - Client → Server: `{ type: 'submit_op', op: { entity, entity_id, field, value, author_user_id, parent_op_id } }` (no `device_id` — same reason)
  - Server → all connected Clients: `{ type: 'op_applied', op }` or `{ type: 'op_conflict', incomingOp, existingOp }`

**Note (carried from Task 2 review):** the WebSocket message handler must process each client's `submit_op` synchronously end-to-end (call `detectConflict` then `appendOp` with no `await` between them, and no `await` between receiving one client's `submit_op` and finishing that check-then-append) since `operations.js` provides no atomic compare-and-swap primitive of its own — it depends entirely on the caller never interleaving two ops for the same entity/field between the conflict check and the append. Handle each incoming `ws` message's op fully before starting to process another.

**Note (carried from Task 4 review) — device_id must be bound to the connection, not trusted per-message:** `acquireLock`/`releaseLock` (Task 4) compare whatever `device_id` string they're handed with no identity verification of their own — that verification must happen here. On `wss.on('connection', (ws) => {...})`, require the first message to be `{ type: 'authenticate', token, device_id }`; call `verifySessionToken(token)` (Task 3) and reject the connection (close the socket) if it's invalid, or if the token's embedded `deviceId` doesn't match the claimed `device_id`. Store the verified `device_id` on the `ws` connection object (e.g. `ws.deviceId = device_id`) and use `ws.deviceId` — never the `device_id` field from a later `acquire_lock`/`submit_op` message body — when calling `acquireLock`/`releaseLock`/`appendOp`. This prevents one client from spoofing another device's lock ownership or op authorship by simply naming a different `device_id` in a message.

**Note (carried from Task 4 review) — schedule periodic lock expiry:** nothing in the current plan ever calls `expireLocks` (Task 4), so a crashed/disconnected client's lock would be held forever. After `startSyncServer` creates the WebSocket server, also start `setInterval(() => expireLocks(db, 60_000), 30_000)` (sweep every 30s, expire locks older than 60s) and clear the interval in the returned `close()` function alongside `wss.close()`.

- [ ] **Step 1: Add dependency**

```bash
npm install ws
```

- [ ] **Step 2: Write the failing test**

```js
// electron/sync/syncServer.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { startSyncServer } from './syncServer.js'

let db, tmpFile, server, port

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `shoresh-syncserver-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Test Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'camp1', 'Sarah', 'x', 'y', 'staff')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?), (?, ?)').run('d1', 'Dev1', 'd2', 'Dev2')
  port = 6100 + Math.floor(Math.random() * 1000)
  server = startSyncServer(db, { port })
})

afterEach(() => {
  server.close()
  db.close()
  fs.unlinkSync(tmpFile)
})

function connect(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => resolve(ws))
  })
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
}

describe('startSyncServer', () => {
  it('grants a lock request', async () => {
    const client = await connect(port)
    client.send(JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' }))
    const result = await nextMessage(client)
    expect(result).toEqual({ type: 'lock_result', granted: true })
    client.close()
  })

  it('applies a submitted op and broadcasts it to other connected clients', async () => {
    const clientA = await connect(port)
    const clientB = await connect(port)
    const broadcastPromise = nextMessage(clientB)
    clientA.send(JSON.stringify({
      type: 'submit_op',
      op: { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1', author_user_id: 'u1', device_id: 'd1', parent_op_id: null },
    }))
    const broadcast = await broadcastPromise
    expect(broadcast.type).toBe('op_applied')
    expect(broadcast.op.value).toBe('a1')
    const stored = db.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s1')
    expect(stored.value).toBe('a1')
    clientA.close()
    clientB.close()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: FAIL with "Cannot find module './syncServer.js'"

- [ ] **Step 4: Implement syncServer.js**

```js
// electron/sync/syncServer.js
import { WebSocketServer } from 'ws'
import { appendOp, detectConflict } from '../ops/operations.js'
import { acquireLock } from './lockManager.js'

export function startSyncServer(db, { port }) {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())

      if (msg.type === 'acquire_lock') {
        const result = acquireLock(db, msg)
        ws.send(JSON.stringify({ type: 'lock_result', granted: result.granted, ...(result.holder_device_id ? { holder_device_id: result.holder_device_id } : {}) }))
        return
      }

      if (msg.type === 'submit_op') {
        const { conflict, existingOp } = detectConflict(db, msg.op)
        if (conflict) {
          ws.send(JSON.stringify({ type: 'op_conflict', incomingOp: msg.op, existingOp }))
          return
        }
        const op = appendOp(db, msg.op)
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'op_applied', op }))
          }
        }
      }
    })
  })

  return {
    wss,
    close: () => wss.close(),
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add electron/sync/syncServer.js electron/sync/syncServer.test.js package.json package-lock.json
git commit -m "feat: add WebSocket sync server with lock requests and op broadcast"
```

---

### Task 6: Sync client (Host-local and remote Client mode)

**Files:**
- Create: `electron/sync/syncClient.js`
- Test: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: `appendOp`, `detectConflict` (Task 2) for the local-only path; connects over `ws` to a `syncServer` (Task 5) for the networked path.
- Produces: `createSyncClient(db, { device_id, author_user_id, serverUrl? }) -> SyncClient` where `SyncClient` has:
  - `write({ entity, entity_id, field, value }) -> Promise<{ status: 'applied' | 'queued' | 'conflict', op?, existingOp? }>`
  - `onOpApplied(callback)` — registers a callback invoked whenever an op (local or remote) is applied.
  - `getQueuedOps() -> op[]` — ops written while offline, not yet acknowledged by the host.
  - `flushQueue() -> Promise<void>` — attempts to resend queued ops once reconnected.

**Note (carried from Task 2 review):** `operations.latestOp`'s ordering column `seq` is an `AUTOINCREMENT` scoped to a single SQLite file — it is never comparable across two different database files (e.g. a client's local db vs. the host's db). When reconciling queued local ops against the host (in `flushQueue` and in the local-only write path's own `detectConflict` calls), always compare ops via `parent_op_id`/`id` chains, never by comparing a `seq` value read from one db against a `seq` value read from another. `seq` is purely a local tie-breaker within a single db's own `latestOp` query — it does not travel over the wire as meaningful ordering data between host and client.

**Note (carried from Task 4/5 review) — updated wire protocol, authenticate first:** per Task 5's revised protocol, `connect()` must send `{ type: 'authenticate', token, device_id }` as the very first message once the WebSocket opens (before any `acquire_lock`/`submit_op`), and wait for the server's acknowledgement before considering the client `connected` (i.e., don't flip `connected = true`/call `flushQueue()` until authentication succeeds). `submit_op` and `acquire_lock` payloads no longer include `device_id` in the message body — the server derives it from the authenticated connection. `createSyncClient`'s constructor arg still takes `device_id` (used to populate the `authenticate` message and for the local-only/host-mode direct-write path's `appendOp` call), just don't also put it in `acquire_lock`/`submit_op` message bodies sent to a connected server.

**Note (carried from Task 4 review) — flushQueue must re-acquire locks before resubmitting:** `flushQueue`'s current sketch resends queued ops directly via `submit_op` without re-requesting the field's lock first. Since another device may have acquired that lock (or the underlying data may have changed) during the time this client was offline, `flushQueue` must, for each queued op, first send `acquire_lock` for that op's `entity/entity_id/field` and wait for `lock_result` before resending the `submit_op` — if the lock is denied, surface that queued item to the caller as a conflict (via the same `onOpApplied`/promise-resolution path used for `op_conflict`) rather than silently sending the write anyway.

- [ ] **Step 1: Write the failing test**

```js
// electron/sync/syncClient.test.js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'

let hostDb, clientDb, hostTmp, clientTmp, server, port

beforeEach(() => {
  hostTmp = path.join(os.tmpdir(), `shoresh-host-${Date.now()}-${Math.random()}.sqlite`)
  clientTmp = path.join(os.tmpdir(), `shoresh-client-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostTmp)
  clientDb = openLocalDb(clientTmp)
  port = 6200 + Math.floor(Math.random() * 1000)
  server = startSyncServer(hostDb, { port })
})

afterEach(() => {
  server.close()
  hostDb.close()
  clientDb.close()
  fs.unlinkSync(hostTmp)
  fs.unlinkSync(clientTmp)
})

describe('createSyncClient — no server (local/host mode)', () => {
  it('applies writes directly to the local db when serverUrl is not provided', async () => {
    const client = createSyncClient(hostDb, { device_id: 'd1', author_user_id: 'u1' })
    const result = await client.write({ entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1' })
    expect(result.status).toBe('applied')
    const row = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s1')
    expect(row.value).toBe('a1')
  })
})

describe('createSyncClient — connected to a remote host', () => {
  it('sends the write to the host and applies it locally once acknowledged', async () => {
    const client = createSyncClient(clientDb, { device_id: 'd2', author_user_id: 'u1', serverUrl: `ws://localhost:${port}` })
    await client.waitUntilConnected()
    const result = await client.write({ entity: 'template_slots', entity_id: 's2', field: 'activity_id', value: 'b1' })
    expect(result.status).toBe('applied')
    const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s2')
    expect(hostRow.value).toBe('b1')
    const clientRow = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s2')
    expect(clientRow.value).toBe('b1')
    client.close()
  })

  it('queues the write when disconnected and flushes it once reconnected', async () => {
    const client = createSyncClient(clientDb, { device_id: 'd3', author_user_id: 'u1', serverUrl: `ws://localhost:${port + 999}` })
    const result = await client.write({ entity: 'template_slots', entity_id: 's3', field: 'activity_id', value: 'c1' })
    expect(result.status).toBe('queued')
    expect(client.getQueuedOps()).toHaveLength(1)
    client.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: FAIL with "Cannot find module './syncClient.js'"

- [ ] **Step 3: Implement syncClient.js**

```js
// electron/sync/syncClient.js
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { appendOp } from '../ops/operations.js'

export function createSyncClient(db, { device_id, author_user_id, serverUrl }) {
  const listeners = []
  const queue = []
  let ws = null
  let connected = false
  let connectPromiseResolve = null

  function notify(op) {
    for (const cb of listeners) cb(op)
  }

  function connect() {
    if (!serverUrl) return
    ws = new WebSocket(serverUrl)
    ws.on('open', () => {
      connected = true
      if (connectPromiseResolve) connectPromiseResolve()
      flushQueue()
    })
    ws.on('close', () => { connected = false })
    ws.on('error', () => { connected = false })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'op_applied') {
        appendOp(db, msg.op)
        const pending = queue.find(q => q.pendingId === msg.op.pendingId)
        if (pending) pending.resolve({ status: 'applied', op: msg.op })
        notify(msg.op)
      }
      if (msg.type === 'op_conflict') {
        const pending = queue.find(q => q.pendingId === msg.incomingOp.pendingId)
        if (pending) pending.resolve({ status: 'conflict', existingOp: msg.existingOp })
      }
    })
  }

  if (serverUrl) connect()

  function write({ entity, entity_id, field, value }) {
    const parent_op_id = null
    if (!serverUrl) {
      const op = appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id })
      notify(op)
      return Promise.resolve({ status: 'applied', op })
    }

    const pendingId = randomUUID()
    const opRequest = { entity, entity_id, field, value, author_user_id, device_id, parent_op_id, pendingId }

    if (!connected) {
      queue.push({ pendingId, opRequest, resolve: () => {} })
      return Promise.resolve({ status: 'queued' })
    }

    return new Promise((resolve) => {
      queue.push({ pendingId, opRequest, resolve })
      ws.send(JSON.stringify({ type: 'submit_op', op: opRequest }))
    })
  }

  function flushQueue() {
    if (!connected) return
    for (const item of queue) {
      ws.send(JSON.stringify({ type: 'submit_op', op: item.opRequest }))
    }
  }

  return {
    write,
    onOpApplied: (cb) => listeners.push(cb),
    getQueuedOps: () => queue.map(q => q.opRequest),
    flushQueue: () => Promise.resolve(flushQueue()),
    waitUntilConnected: () => connected ? Promise.resolve() : new Promise((resolve) => { connectPromiseResolve = resolve }),
    close: () => { if (ws) ws.close() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/sync/syncClient.js electron/sync/syncClient.test.js
git commit -m "feat: add sync client with online write path and offline queueing"
```

---

### Task 7: LAN discovery (mDNS)

**Files:**
- Create: `electron/sync/discovery.js`
- Test: `electron/sync/discovery.test.js`

**Interfaces:**
- Produces:
  - `advertiseHost({ campName, port }) -> { stop(): void }` — advertises a `_shoresh._tcp` mDNS service.
  - `discoverHosts({ timeoutMs }) -> Promise<{ name: string, host: string, port: number }[]>` — browses for `_shoresh._tcp` services for the given window and resolves with whatever was found.

- [ ] **Step 1: Add dependency**

```bash
npm install bonjour-service
```

- [ ] **Step 2: Write the failing test**

```js
// electron/sync/discovery.test.js
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { advertiseHost, discoverHosts } from './discovery.js'

let stopAdvertise

afterEach(() => {
  if (stopAdvertise) stopAdvertise()
})

describe('advertiseHost + discoverHosts', () => {
  it('finds an advertised host on the LAN', async () => {
    const port = 6300 + Math.floor(Math.random() * 1000)
    const { stop } = advertiseHost({ campName: 'Camp Test', port })
    stopAdvertise = stop
    const found = await discoverHosts({ timeoutMs: 2000 })
    expect(found.some(h => h.port === port)).toBe(true)
  }, 5000)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/sync/discovery.test.js`
Expected: FAIL with "Cannot find module './discovery.js'"

- [ ] **Step 4: Implement discovery.js**

```js
// electron/sync/discovery.js
import { Bonjour } from 'bonjour-service'

export function advertiseHost({ campName, port }) {
  const bonjour = new Bonjour()
  const service = bonjour.publish({ name: campName, type: 'shoresh', port })
  return {
    stop: () => {
      service.stop(() => bonjour.destroy())
    },
  }
}

export function discoverHosts({ timeoutMs }) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour()
    const found = []
    const browser = bonjour.find({ type: 'shoresh' }, (service) => {
      found.push({ name: service.name, host: service.host, port: service.port })
    })
    setTimeout(() => {
      browser.stop()
      bonjour.destroy()
      resolve(found)
    }, timeoutMs)
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/sync/discovery.test.js`
Expected: PASS (1 test) — note: this test uses real LAN multicast on localhost; if it's flaky in CI sandboxes without multicast support, mark it `it.skip` there and rely on manual LAN verification (per the spec's testing strategy).

- [ ] **Step 6: Commit**

```bash
git add electron/sync/discovery.js electron/sync/discovery.test.js package.json package-lock.json
git commit -m "feat: add mDNS host advertise/discover for LAN pairing"
```

---

### Task 8: Electron main process — mode selection and IPC bridge

**Files:**
- Create: `electron/main.js`
- Create: `electron/preload.js`
- Modify: `package.json:scripts` (add `"electron:dev"`, `"electron:build"`)

**Interfaces:**
- Consumes: `openLocalDb`/`getOrCreateDeviceId` (1), `createUser`/`verifyPin`/`issueSessionToken`/`verifySessionToken` (3), `startSyncServer` (5), `createSyncClient` (6), `advertiseHost`/`discoverHosts` (7).
- Produces: `window.shoresh` exposed to the renderer with methods: `login({ name, pin }) -> { token, userId, role } | null`, `write({ entity, entity_id, field, value }) -> Promise<result>`, `onOpApplied(cb)`, `discoverHosts() -> Promise<host[]>`, `chooseMode({ mode: 'host' | 'client', hostAddress? })`.

**Note (carried from Task 1 round-2 review):** use `getOrCreateDeviceId(db)` for `deviceId` (not a fresh `randomUUID()` per launch) so lock re-acquisition survives app restarts, and pass `author_user_id: null` for system-attributed sync-client writes (the `operations.author_user_id` column is nullable specifically for this case — a non-null unmatched string like `'system'` would still fail its foreign key). Also insert a row into `devices` (id = the persisted device id, name = an OS hostname or user-chosen label) before first use, since `operations.device_id` is a `NOT NULL REFERENCES devices(id)` and `getOrCreateDeviceId`'s `device_identity` table does not itself populate `devices`.

**Note (carried from Task 7 review) — validate host/port before building the WebSocket URL:** `discoverHosts` (Task 7) type-checks but does not value/format-validate the `host`/`port` it returns (e.g. `port` could be `0`/negative/non-integer, `host` could contain characters that alter URL parsing). Wherever `chooseMode`'s client-mode path turns a discovered `{ host, port }` into the `hostAddress`/`serverUrl` passed to `createSyncClient`, validate `Number.isInteger(port) && port > 0 && port <= 65535` and that `host` matches a simple hostname/IPv4/IPv6 pattern (e.g. `/^[a-zA-Z0-9.\-:]+$/`) before constructing `` `ws://${host}:${port}` ``; reject (surface an error to the renderer rather than attempting the connection) if either check fails.

- [ ] **Step 1: Write main.js**

```js
// electron/main.js
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './auth/localAuth.js'
import { startSyncServer } from './sync/syncServer.js'
import { createSyncClient } from './sync/syncClient.js'
import { advertiseHost, discoverHosts } from './sync/discovery.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(app.getPath('userData'), 'shoresh.sqlite')
const db = openLocalDb(dbPath)
const deviceId = getOrCreateDeviceId(db)

let syncClient = null
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle('shoresh:choose-mode', (_event, { mode, hostAddress, campName, port }) => {
  if (mode === 'host') {
    startSyncServer(db, { port })
    advertiseHost({ campName, port })
    syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
  } else {
    syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null, serverUrl: hostAddress })
  }
  syncClient.onOpApplied((op) => {
    if (mainWindow) mainWindow.webContents.send('shoresh:op-applied', op)
  })
})

ipcMain.handle('shoresh:discover-hosts', () => discoverHosts({ timeoutMs: 3000 }))

ipcMain.handle('shoresh:login', (_event, { name, pin }) => {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
  if (!user || !verifyPin(db, user.id, pin)) return null
  const token = issueSessionToken(user.id, deviceId)
  return { token, userId: user.id, role: user.role }
})

ipcMain.handle('shoresh:create-user', (_event, { camp_id, name, pin, role }) => createUser(db, { camp_id, name, pin, role }))

ipcMain.handle('shoresh:write', (_event, { token, ...writeArgs }) => {
  const session = verifySessionToken(token)
  if (!session) throw new Error('invalid session')
  return syncClient.write({ ...writeArgs, author_user_id: session.userId })
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 2: Write preload.js**

```js
// electron/preload.js
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('shoresh', {
  chooseMode: (args) => ipcRenderer.invoke('shoresh:choose-mode', args),
  discoverHosts: () => ipcRenderer.invoke('shoresh:discover-hosts'),
  login: (args) => ipcRenderer.invoke('shoresh:login', args),
  createUser: (args) => ipcRenderer.invoke('shoresh:create-user', args),
  write: (args) => ipcRenderer.invoke('shoresh:write', args),
  onOpApplied: (callback) => ipcRenderer.on('shoresh:op-applied', (_event, op) => callback(op)),
})
```

- [ ] **Step 3: Add electron dependency and scripts**

```bash
npm install --save-dev electron
```

Modify `package.json` scripts block to:

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "lint": "eslint .",
  "preview": "vite preview",
  "test": "vitest run",
  "electron:dev": "concurrently -k \"vite\" \"cross-env VITE_DEV_SERVER_URL=http://localhost:5200 electron electron/main.js\"",
  "electron:build": "vite build && electron-builder"
}
```

```bash
npm install --save-dev concurrently cross-env electron-builder
```

- [ ] **Step 4: Manual verification**

Run: `npm run electron:dev`
Expected: an Electron window opens, loading the existing Vite dev server at localhost:5200 (same UI as before — no data wiring yet, that's Task 9).

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/preload.js package.json package-lock.json
git commit -m "feat: add Electron main process with host/client mode IPC bridge"
```

---

### Task 9: Renderer local client — replace supabase.js call sites

**Files:**
- Create: `src/localClient.js`
- Modify: `src/hooks/useSession.js` (replace Supabase auth calls with `window.shoresh.login`)
- Modify: `src/App.jsx` (mode-selection screen before the existing auth gate, when no `campId`/mode chosen yet)

**Interfaces:**
- Consumes: `window.shoresh.*` exposed by Task 8's preload script.
- Produces: `localClient.login(name, pin) -> Promise<{ token, userId, role } | null>`, `localClient.write(entity, entity_id, field, value) -> Promise<result>`, `localClient.onOpApplied(cb)`, `localClient.discoverHosts()`, `localClient.chooseMode(args)`. This is the new single import site other screens will use instead of `import { supabase } from '../supabase'`.

- [ ] **Step 1: Write localClient.js**

```js
// src/localClient.js
export const localClient = {
  chooseMode: (args) => window.shoresh.chooseMode(args),
  discoverHosts: () => window.shoresh.discoverHosts(),
  login: (name, pin) => window.shoresh.login({ name, pin }),
  createUser: (args) => window.shoresh.createUser(args),
  write: (token, entity, entity_id, field, value) => window.shoresh.write({ token, entity, entity_id, field, value }),
  onOpApplied: (cb) => window.shoresh.onOpApplied(cb),
}
```

- [ ] **Step 2: Update useSession.js to use localClient instead of Supabase**

Replace the Supabase `auth.getSession()`/`onAuthStateChange` calls in `src/hooks/useSession.js` with a `useState`-backed session that's set by calling `localClient.login(name, pin)` from the auth screen and cleared on logout. `resolveCampId(session)` becomes unnecessary — `campId` comes directly from the local `camps` table via a new `shoresh:get-camp` IPC call (add this handler to `electron/main.js` alongside the others from Task 8, following the same pattern: `ipcMain.handle('shoresh:get-camp', () => db.prepare('SELECT * FROM camps LIMIT 1').get())` and expose it in `preload.js` as `getCamp: () => ipcRenderer.invoke('shoresh:get-camp')`).

- [ ] **Step 3: Manual verification**

Run: `npm run electron:dev`, log in with a seeded test user (create one via a temporary script calling `createUser` against the userData SQLite file), confirm the auth gate in `App.jsx` renders the main app shell after login, matching current behavior.

- [ ] **Step 4: Commit**

```bash
git add src/localClient.js src/hooks/useSession.js electron/main.js electron/preload.js
git commit -m "feat: wire renderer auth and writes through localClient instead of Supabase"
```

---

### Task 10: Merge screen for conflict resolution

**Files:**
- Create: `src/screens/MergeScreen.jsx`
- Modify: `src/App.jsx` (register `merge` in the `SCREENS` object; navigate there when `localClient.onOpApplied` reports a `status: 'conflict'` write)

**Interfaces:**
- Consumes: conflict payloads of the shape `{ incomingOp, existingOp }` (from Task 6's `write()` return value when `status === 'conflict'`).
- Produces: a screen listing pending conflicts with two named choices ("Keep [author]'s version" for each side) plus a manual text override; resolving a conflict calls `localClient.write` again with the chosen value and `parent_op_id` set to the winning `existingOp.id` so it applies cleanly.

- [ ] **Step 1: Write MergeScreen.jsx**

```jsx
// src/screens/MergeScreen.jsx
import { useState } from 'react'
import { localClient } from '../localClient'

export default function MergeScreen({ conflicts, token, onResolved }) {
  const [resolving, setResolving] = useState(null)

  async function resolve(conflict, chosenValue) {
    setResolving(conflict.incomingOp.entity_id)
    await localClient.write(
      token,
      conflict.incomingOp.entity,
      conflict.incomingOp.entity_id,
      conflict.incomingOp.field,
      chosenValue,
    )
    onResolved(conflict)
    setResolving(null)
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Unresolved changes</h2>
      {conflicts.length === 0 && <p style={styles.empty}>No conflicts to resolve.</p>}
      {conflicts.map((conflict) => (
        <div key={conflict.incomingOp.entity_id + conflict.incomingOp.field} style={styles.card}>
          <p style={styles.fieldLabel}>{conflict.incomingOp.entity} / {conflict.incomingOp.entity_id} / {conflict.incomingOp.field}</p>
          <div style={styles.choices}>
            <button
              style={styles.choiceButton}
              disabled={resolving === conflict.incomingOp.entity_id}
              onClick={() => resolve(conflict, conflict.existingOp.value)}
            >
              Keep existing value: {conflict.existingOp.value}
            </button>
            <button
              style={styles.choiceButton}
              disabled={resolving === conflict.incomingOp.entity_id}
              onClick={() => resolve(conflict, conflict.incomingOp.value)}
            >
              Use incoming value: {conflict.incomingOp.value}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

const styles = {
  container: { padding: 24 },
  heading: { fontSize: 20, fontWeight: 600, marginBottom: 16 },
  empty: { color: 'var(--text-secondary)' },
  card: { border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 12, background: 'var(--surface)' },
  fieldLabel: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 },
  choices: { display: 'flex', gap: 12 },
  choiceButton: { padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-elevated)', cursor: 'pointer' },
}
```

- [ ] **Step 2: Register the screen in App.jsx**

Add `import MergeScreen from './screens/MergeScreen'` and an entry `merge: MergeScreen` to the existing `SCREENS` object. Maintain a `conflicts` array in `App.jsx` state; push onto it whenever `localClient.write(...)` resolves with `status === 'conflict'`, and switch `screen` to `'merge'` when the array is non-empty (surfacing it via the existing sidebar navigation, same pattern as other screens).

- [ ] **Step 3: Manual verification**

Simulate a conflict: with two Electron windows open against the same host (one Host, one Client), disconnect the Client's network, have both edit the same `template_slots` field with different values, reconnect the Client, and confirm the Merge screen appears with both named values and that resolving it clears the conflict.

- [ ] **Step 4: Commit**

```bash
git add src/screens/MergeScreen.jsx src/App.jsx
git commit -m "feat: add merge screen for offline conflict resolution"
```

---

## Self-Review Notes

- **Spec coverage:** Electron packaging (Task 8), SQLite local-db (Task 1), operation log (Task 2), local PIN auth (Task 3), online locking (Task 4–5), offline queueing (Task 6), LAN discovery (Task 7), renderer integration (Task 9), merge UI (Task 10) — every component in the spec's table has a corresponding task.
- **Type consistency checked:** `op` shape (`entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id`) is identical across Tasks 2, 5, 6, 8, 10. `SyncClient.write()`'s return shape (`{ status, op?, existingOp? }`) matches what Task 10's `MergeScreen` expects.
- **Out of scope (per spec):** auto-update mechanism for the Electron app itself and any Supabase data migration tooling are explicitly excluded, matching the spec's "Out of Scope" section.
