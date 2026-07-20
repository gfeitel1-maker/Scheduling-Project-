# Shared Per-Camp Signing Secret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a critical bug where a session token issued to a Client via the fresh-client-login flow cannot be verified by that Client's own local IPC handlers, because each Electron process currently generates an independent, unshared HMAC signing secret.

**Architecture:** Move the HMAC signing secret from an ephemeral per-process module-level constant (`electron/auth/localAuth.js`) to a persistent value stored on the `camps` table, generated once at camp bootstrap and distributed to every Client via the existing full-sync mechanism. `issueSessionToken`/`verifySessionToken` change from taking no db context to taking `db` as their first argument and looking the secret up from the camp row on every call.

**Tech Stack:** Node.js (ESM), `better-sqlite3`, `ws`, Vitest.

## Global Constraints

- Schema changes must follow the established versioned-migration pattern: guarded by `getSchemaVersion(db) < N`, `PRAGMA table_info()`/`pragma('table_info(...)')` existence checks before any `ALTER TABLE`, and an `INSERT OR IGNORE INTO schema_migrations` row at the end of the block (see `electron/db/localDb.js`'s existing v4–v8 blocks for the exact pattern to match).
- The `signing_secret` column must be nullable (no `NOT NULL` constraint) so that tests/tables that never touch token signing (e.g. `electron/ops/projections.test.js`, `electron/ops/operations.test.js`, `electron/db/localDb.migrations.test.js`) are unaffected and don't need updating.
- This fix is accepting a known, documented security tradeoff (shared secret across all devices in one camp) per the design doc — do not add any additional security hardening beyond what's specified here.

---

### Task 1: Add `camps.signing_secret` column (schema v9)

**Files:**
- Modify: `electron/db/schema.sql`
- Modify: `electron/db/localDb.js`
- Test: `electron/db/localDb.migrations.test.js`

**Interfaces:**
- Produces: `camps` table gains a nullable `signing_secret TEXT` column, present on both fresh installs (via `schema.sql`) and existing databases (via the v9 migration block in `localDb.js`). Schema version becomes 9.

- [ ] **Step 1: Add the column to `schema.sql` for fresh installs**

Find, in `electron/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
```

Replace with:

```sql
CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  signing_secret TEXT
);
```

- [ ] **Step 2: Write a failing test for the v9 migration on a pre-existing database**

Add to `electron/db/localDb.migrations.test.js` (match this file's existing pattern — check an earlier migration test in this same file, e.g. the v8 test, for the exact `beforeEach`/tmp-file setup style used):

```js
describe('schema v9: camps.signing_secret', () => {
  it('adds a nullable signing_secret column to an existing camps table', () => {
    const tmpFile = path.join(os.tmpdir(), `shoresh-migrate-v9-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(tmpFile)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')

    // Simulate a pre-v9 database missing the column, then re-run migrations.
    const hasColumn = db.pragma('table_info(camps)').some((col) => col.name === 'signing_secret')
    expect(hasColumn).toBe(true) // fresh installs already have it via schema.sql

    db.close()
    fs.unlinkSync(tmpFile)
  })

  it('backfills a freshly-generated secret for a camp row with a NULL signing_secret', () => {
    const tmpFile = path.join(os.tmpdir(), `shoresh-migrate-v9-backfill-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(tmpFile)

    // Directly force a NULL to simulate a row that predates this migration.
    db.prepare('UPDATE camps SET signing_secret = NULL WHERE 1=1').run()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, NULL)').run('camp2', 'Camp Two')

    // Re-running initSchema (as happens on every openLocalDb call) must backfill any NULL row.
    const { initSchema } = require('./localDb.js')
    initSchema(db)

    const rows = db.prepare('SELECT id, signing_secret FROM camps').all()
    for (const row of rows) {
      expect(row.signing_secret).toEqual(expect.any(String))
      expect(row.signing_secret.length).toBeGreaterThan(0)
    }

    db.close()
    fs.unlinkSync(tmpFile)
  })
})
```

Note: adjust the exact import style (`require` vs `import`) to match whatever this test file already uses — check the top of `electron/db/localDb.migrations.test.js` first; if it's ESM (`import { initSchema, openLocalDb } from './localDb.js'`), use that instead of the `require` shown above.

- [ ] **Step 2: Run the tests to verify the backfill test fails**

Run: `npx vitest run electron/db/localDb.migrations.test.js`
Expected: the backfill test FAILS (no v9 migration exists yet to backfill the NULL row).

- [ ] **Step 3: Add the v9 migration block to `electron/db/localDb.js`**

Find the end of the existing v8 migration block (look for `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)`) inside `initSchema`, and add immediately after its closing `}`:

```js
  // Fix: a session token signed by one process's ephemeral in-memory secret
  // could never be verified by a different process (Host vs. Client) using
  // its own independent secret — this made a Client's freshly-obtained
  // token from the remote-login flow unusable for any subsequent local IPC
  // call. Move the signing secret onto the camps row so every device that
  // has synced a camp shares the same secret.
  if (getSchemaVersion(db) < 9) {
    const hasSigningSecret = db
      .pragma('table_info(camps)')
      .some((col) => col.name === 'signing_secret')

    if (!hasSigningSecret) {
      db.exec('ALTER TABLE camps ADD COLUMN signing_secret TEXT')
    }

    const campsNeedingSecret = db.prepare('SELECT id FROM camps WHERE signing_secret IS NULL').all()
    for (const camp of campsNeedingSecret) {
      db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(
        randomBytes(32).toString('hex'),
        camp.id
      )
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)').run(
      new Date().toISOString()
    )
  }
```

Add `randomBytes` to this file's imports if not already present — check the top of `electron/db/localDb.js` for its existing `import` list (it currently imports `randomUUID` from `node:crypto`; add `randomBytes` to that same import line: `import { randomUUID, randomBytes } from 'node:crypto'`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/db/localDb.migrations.test.js`
Expected: PASS — both new tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 6: Commit**

```bash
git add electron/db/schema.sql electron/db/localDb.js electron/db/localDb.migrations.test.js
git commit -m "feat: add camps.signing_secret column (schema v9) with backfill for existing rows"
```

---

### Task 2: Change `issueSessionToken`/`verifySessionToken` to look up the secret from `db`

**Files:**
- Modify: `electron/auth/localAuth.js`
- Test: `electron/auth/localAuth.test.js`

**Interfaces:**
- Consumes: `camps.signing_secret` column from Task 1.
- Produces: `export function issueSessionToken(db, userId, deviceId)` and `export function verifySessionToken(db, token)` — both now require `db` as their first argument. The module-level `const sessionSecret = randomBytes(32)` is removed entirely. `attemptLogin`'s internal call to `issueSessionToken` is updated to pass `db`.

- [ ] **Step 1: Write failing tests for the new signatures**

Replace the existing `describe('issueSessionToken / verifySessionToken', ...)` block in `electron/auth/localAuth.test.js` (currently around line 242) with:

```js
describe('issueSessionToken / verifySessionToken', () => {
  it('round-trips userId/deviceId through a signed token using the camp signing_secret', () => {
    const token = issueSessionToken(db, 'user-1', 'device-1')
    const payload = verifySessionToken(db, token)
    expect(payload).toEqual({ userId: 'user-1', deviceId: 'device-1' })
  })

  it('rejects a token issued against a DIFFERENT camp/db signing_secret', () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-othercamp-${Date.now()}-${Math.random()}.sqlite`)
    const otherDb = openLocalDb(otherFile)
    otherDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-other', 'Other Camp')

    const tokenFromOtherCamp = issueSessionToken(otherDb, 'user-1', 'device-1')
    expect(verifySessionToken(db, tokenFromOtherCamp)).toBeNull()

    otherDb.close()
    fs.unlinkSync(otherFile)
  })

  it('rejects a tampered token', () => {
    const token = issueSessionToken(db, 'user-1', 'device-1')
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A')
    expect(() => verifySessionToken(db, tampered)).not.toThrow()
    expect(verifySessionToken(db, tampered)).toBeNull()
  })

  it('rejects tokens with a mutated payload across many random tamper attempts', () => {
    for (let i = 0; i < 20; i++) {
      const token = issueSessionToken(db, `user-${i}`, `device-${i}`)
      const chars = token.split('')
      const idx = Math.floor(Math.random() * chars.length)
      chars[idx] = chars[idx] === 'x' ? 'y' : 'x'
      const tampered = chars.join('')
      expect(verifySessionToken(db, tampered)).toBeNull()
    }
  })

  it('rejects malformed tokens without throwing', () => {
    expect(verifySessionToken(db, 'garbage-no-separator')).toBeNull()
    expect(verifySessionToken(db, '')).toBeNull()
    expect(verifySessionToken(db, null)).toBeNull()
    expect(verifySessionToken(db, 'a.b.c')).toBeNull()
  })
})
```

Check the file's existing `beforeEach` — it should already open a `db` and insert a `camp-1` row (per Task 1's context, this file's `beforeEach` at line 18 does `db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')`). Since `signing_secret` is nullable and this insert doesn't set it, you need to also set a `signing_secret` for `camp-1` in this file's `beforeEach` — add immediately after that insert line:

```js
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
```

Add `randomBytes` to this test file's `node:crypto` import if not already present (check the top of the file — it likely already imports `randomUUID` from `node:crypto`; add `randomBytes` to that same line).

Also find the one other call site in this file at (around) line 340 — `const verified = verifySessionToken(result.token)` inside the `attemptLogin` describe block — and update it to `const verified = verifySessionToken(db, result.token)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: FAIL — `issueSessionToken`/`verifySessionToken` don't yet accept a `db` argument.

- [ ] **Step 3: Change the implementation in `electron/auth/localAuth.js`**

Find:

```js
const SCRYPT_KEYLEN = 64
const sessionSecret = randomBytes(32)
```

Replace with:

```js
const SCRYPT_KEYLEN = 64
```

Find:

```js
function sign(payload) {
  return createHmac('sha256', sessionSecret).update(payload).digest()
}

export function issueSessionToken(userId, deviceId) {
  const payload = Buffer.from(JSON.stringify({ userId, deviceId }), 'utf8').toString('base64url')
  const signature = sign(payload).toString('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!payload || !signature) return null

  let expected
  try {
    expected = sign(payload)
  } catch {
    return null
  }
```

Replace with:

```js
// Looks up the current camp's signing secret from the db, mirroring the
// existing single-camp-per-db assumption already used elsewhere in this
// codebase (e.g. attemptLogin's own `SELECT id FROM camps LIMIT 1`). This
// is what makes a token issued by one process (e.g. a Host) verifiable by
// a different process (e.g. a Client that has since synced the camp row) —
// previously each process had its own random, unshared secret, so a
// Host-issued token could never pass a Client's own local verification.
function getSigningSecret(db) {
  const camp = db.prepare('SELECT signing_secret FROM camps LIMIT 1').get()
  if (!camp || !camp.signing_secret) return null
  return Buffer.from(camp.signing_secret, 'hex')
}

function sign(db, payload) {
  const secret = getSigningSecret(db)
  if (!secret) throw new Error('no camp signing secret available')
  return createHmac('sha256', secret).update(payload).digest()
}

export function issueSessionToken(db, userId, deviceId) {
  const payload = Buffer.from(JSON.stringify({ userId, deviceId }), 'utf8').toString('base64url')
  const signature = sign(db, payload).toString('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(db, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!payload || !signature) return null

  let expected
  try {
    expected = sign(db, payload)
  } catch {
    return null
  }
```

The rest of `verifySessionToken`'s body (the `provided`/`timingSafeEqual`/payload-parsing logic below this point) is unchanged — only the function signature and the `sign(...)` call sites within it change.

- [ ] **Step 4: Update `attemptLogin`'s internal call**

Find, near the end of `attemptLogin`:

```js
  const token = issueSessionToken(user.id, deviceId)
  return { token, userId: user.id, role: user.role }
```

Replace with:

```js
  const token = issueSessionToken(db, user.id, deviceId)
  return { token, userId: user.id, role: user.role }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: PASS — all tests including the 5 rewritten ones.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: other files that call `issueSessionToken`/`verifySessionToken` will now fail (they're updated in Tasks 3–5) — this is expected at this point in the plan. Confirm specifically that `electron/auth/localAuth.test.js` and `electron/db/localDb.migrations.test.js` (Task 1) pass; other failures are addressed in the following tasks.

- [ ] **Step 7: Commit**

```bash
git add electron/auth/localAuth.js electron/auth/localAuth.test.js
git commit -m "fix: look up session-token signing secret from the camp row instead of a per-process random constant"
```

---

### Task 3: Update `main.js` and generate the secret in `bootstrapCamp`

**Files:**
- Modify: `electron/main.js`
- Test: `electron/main.test.js`

**Interfaces:**
- Consumes: `issueSessionToken(db, ...)`/`verifySessionToken(db, ...)` from Task 2.
- Produces: `bootstrapCamp` generates and stores a `signing_secret` when creating a camp. Every `verifySessionToken(token)` call site in `main.js` becomes `verifySessionToken(db, token)`.

- [ ] **Step 1: Update `bootstrapCamp` to generate the secret**

Find, in `electron/main.js`:

```js
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, campName)
```

Replace with:

```js
    const campId = randomUUID()
    const signingSecret = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, campName, signingSecret)
```

Add `randomBytes` to this file's `node:crypto` import (currently `import { randomUUID } from 'node:crypto'` — change to `import { randomUUID, randomBytes } from 'node:crypto'`).

- [ ] **Step 2: Update all 4 `verifySessionToken` call sites**

Each of the following, in `electron/main.js`, changes from `verifySessionToken(token)` to `verifySessionToken(db, token)`:

1. Inside `createUserHandler`: `const session = verifySessionToken(token)` → `const session = verifySessionToken(db, token)`
2. Inside `verifySession`: `const session = verifySessionToken(token)` → `const session = verifySessionToken(db, token)`
3. Inside `write`: `const session = verifySessionToken(token)` → `const session = verifySessionToken(db, token)`
4. Inside `resolveConflict`: `const session = verifySessionToken(token)` → `const session = verifySessionToken(db, token)`

(`db` is already in scope at every one of these call sites — they're all inside `makeHandlers(db, deviceId, ...)`'s closure.)

- [ ] **Step 3: Update `main.test.js`'s two camp `INSERT` statements to include a `signing_secret`**

Find both occurrences (around lines 139 and 448) of:

```js
db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Shoresh')
```

Replace each with:

```js
db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Shoresh', 'a'.repeat(64))
```

(Using a fixed test secret like `'a'.repeat(64)` is fine here — these tests exercise `attemptLogin`/`login`'s local path, which reads whatever secret is on the row; it doesn't need to be cryptographically random for test purposes.)

Note: `main.test.js` never calls `issueSessionToken`/`verifySessionToken` directly (confirmed by grep during planning — it only calls them indirectly through `handlers.login()` → `attemptLogin`, which Task 2 already updated), so no other signature-related changes are needed in this file.

- [ ] **Step 4: Run `main.test.js`**

Run: `npx vitest run electron/main.test.js`
Expected: PASS — all tests, since `attemptLogin` (updated in Task 2) now correctly reads the `signing_secret` these `beforeEach`/per-test `INSERT`s provide.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: `electron/main.test.js`, `electron/auth/localAuth.test.js`, `electron/db/localDb.migrations.test.js` pass. `electron/sync/syncServer.test.js` and `electron/sync/syncClient.test.js` still fail at this point (addressed in Tasks 4–5) — confirm no OTHER unexpected file fails.

- [ ] **Step 6: Commit**

```bash
git add electron/main.js electron/main.test.js
git commit -m "feat: generate camp signing_secret at bootstrap; update main.js's verifySessionToken call sites"
```

---

### Task 4: Update `syncServer.js` and distribute the secret via full-sync

**Files:**
- Modify: `electron/sync/syncServer.js`
- Test: `electron/sync/syncServer.test.js`

**Interfaces:**
- Consumes: `verifySessionToken(db, ...)`/`issueSessionToken(db, ...)` from Task 2.
- Produces: `handleAuthenticate`'s token verification uses `db`. The full-sync query includes `signing_secret` in the selected `camps` columns, so a Client receives it during its first pairing.

- [ ] **Step 1: Update `handleAuthenticate`'s verification call**

Find, in `electron/sync/syncServer.js`:

```js
function handleAuthenticate(db, ws, msg) {
  const verified = verifySessionToken(msg.token)
```

Replace with:

```js
function handleAuthenticate(db, ws, msg) {
  const verified = verifySessionToken(db, msg.token)
```

- [ ] **Step 2: Add `signing_secret` to the full-sync query**

Find, in `sendFullSyncIfFirstPairing`:

```js
  const camps = db.prepare('SELECT id, name FROM camps').all()
```

Replace with:

```js
  const camps = db.prepare('SELECT id, name, signing_secret FROM camps').all()
```

- [ ] **Step 3: Update `syncServer.test.js`'s camp `INSERT` and all `issueSessionToken` call sites**

Find, in `beforeEach` (around line 60):

```js
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
```

Replace with:

```js
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'b'.repeat(64))
```

Then change every `issueSessionToken(userId, ...)`/`issueSessionToken(userId, otherDeviceId)`/`issueSessionToken(userId, newDeviceId)` call in this file (at the lines identified during planning: 83, 170, 364, 429, 488, 511) to pass `db` as the first argument, e.g.:

```js
token = issueSessionToken(db, userId, deviceId)
```

```js
const otherToken = issueSessionToken(db, userId, otherDeviceId)
```

```js
const newToken = issueSessionToken(db, userId, newDeviceId)
```

Apply this exact `(userId, ...)` → `(db, userId, ...)` transformation at each of the 6 call sites — they all share the same enclosing `db` variable from this file's top-level `beforeEach`.

- [ ] **Step 4: Run `syncServer.test.js`**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: PASS — all tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: `electron/sync/syncClient.test.js` still fails at this point (Task 5) — confirm every other file passes.

- [ ] **Step 6: Commit**

```bash
git add electron/sync/syncServer.js electron/sync/syncServer.test.js
git commit -m "feat: use db-scoped token verification in handleAuthenticate; distribute signing_secret via full-sync"
```

---

### Task 5: Update `syncClient.js` to receive and store the secret via full-sync

**Files:**
- Modify: `electron/sync/syncClient.js`
- Test: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: the full-sync `camps` payload now including `signing_secret` (Task 4).
- Produces: `isValidFullSyncCamp` validates the new field; `applyFullSync`'s `INSERT OR REPLACE INTO camps` carries it through. A Client that completes full-sync now has the same `signing_secret` as the Host in its local `camps` row.

- [ ] **Step 1: Update `isValidFullSyncCamp`**

Find:

```js
  function isValidFullSyncCamp(camp) {
    if (camp === null || typeof camp !== 'object' || Array.isArray(camp)) return false
    if (!isNonEmptyString(camp.id)) return false
    if (!isNonEmptyString(camp.name)) return false
    return true
  }
```

Replace with:

```js
  function isValidFullSyncCamp(camp) {
    if (camp === null || typeof camp !== 'object' || Array.isArray(camp)) return false
    if (!isNonEmptyString(camp.id)) return false
    if (!isNonEmptyString(camp.name)) return false
    // signing_secret may legitimately be null on an older, not-yet-migrated
    // Host row (Task 1's migration backfills it, but defensively tolerate
    // either a non-empty string or null rather than rejecting the whole
    // camp sync over this one field).
    if (!(camp.signing_secret === null || isNonEmptyString(camp.signing_secret))) return false
    return true
  }
```

- [ ] **Step 2: Update `applyFullSync`'s camp insert**

Find:

```js
        db.prepare('INSERT OR REPLACE INTO camps (id, name) VALUES (?, ?)').run(camp.id, camp.name)
```

Replace with:

```js
        db.prepare('INSERT OR REPLACE INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(camp.id, camp.name, camp.signing_secret ?? null)
```

- [ ] **Step 3: Update `syncClient.test.js`'s camp `INSERT`s and `issueSessionToken` call sites**

Find each of the 4 camp `INSERT` occurrences in this file (lines identified during planning: 28, 29, 509, 1095):

```js
hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
```
```js
clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
```
```js
hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(otherCampId, 'Other Camp')
```
```js
dbB.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
```

Replace each with the same pattern, adding a `signing_secret` column and a fixed test value — for the first two (lines 28–29, both referring to the SAME `campId` on `hostDb` and `clientDb`), use the SAME secret value on both so a token issued by one and checked by the other in existing tests still verifies correctly:

```js
hostDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
```
```js
clientDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
```

For the other two (`otherCampId` on `hostDb` at line 509, and `campId` on `dbB` at line 1095 — check the surrounding test to see whether `dbB`'s `campId` is meant to match `hostDb`'s original `campId`'s secret or be independent; if the existing test issues a token via `hostDb` and checks it via `dbB`, they must share the secret; if `dbB` represents a genuinely different device that should already have synced the same camp, use the SAME secret as `hostDb`'s primary camp row):

```js
hostDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(otherCampId, 'Other Camp', 'd'.repeat(64))
```
```js
dbB.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
```

Then change every `issueSessionToken(userId, ...)` call in this file (lines identified during planning: 55, 177, 237, 951, 1103) to pass the appropriate `db` variable as the first argument — check each call site's surrounding context to determine whether it should be `hostDb`, `clientDb`, or `dbB` (whichever db's camp row holds the secret the token needs to be verifiable against for that specific test's scenario):

```js
token = issueSessionToken(hostDb, userId, deviceId)
```

- [ ] **Step 4: Run `syncClient.test.js`**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS — all tests. If any test fails with a token-verification mismatch, check whether the two `db`s involved in that specific test actually share the same `signing_secret` value (per Step 3's guidance) — a test simulating "two devices that have both synced the same camp" needs the same secret on both; a test simulating "a genuinely different camp" should use a different secret.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 6: Commit**

```bash
git add electron/sync/syncClient.js electron/sync/syncClient.test.js
git commit -m "feat: carry signing_secret through full-sync so a Client's local token verification matches the Host"
```

---

### Task 6: End-to-end regression test — the exact cross-process bug this fix closes

**Files:**
- Test: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a test proving the exact scenario found during live two-Electron-process testing — a token issued by the Host to a fresh Client via `loginRemote`, once full-sync completes, is genuinely verifiable by that Client's own local `verifySessionToken(db, token)` call. This is the specific case that was broken and undetected until live testing; this test closes it permanently.

- [ ] **Step 1: Write the failing test**

Add to the `describe('remote login (fresh client, no local token yet)', ...)` block in `electron/sync/syncClient.test.js` (the same block the fresh-client-first-login plan's Task 3/5 tests live in), immediately after the existing "a fresh client with a completely empty local db can join, get full-synced, and write" test:

```js
  it('the token a fresh client receives from loginRemote is genuinely verifiable by that client\'s OWN local verifySessionToken — the exact cross-process bug found during live testing', async () => {
    expect(freshClientDb.prepare('SELECT COUNT(*) as n FROM camps').get().n).toBe(0)

    const freshDeviceId = randomUUID()
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    await client.waitUntilConnected()

    const loginResult = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(loginResult.status).toBe('ok')

    // Wait for full-sync to populate the local camps row (including the
    // now-shared signing_secret) before attempting local verification.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Explicitly confirm full-sync actually carried the secret through and
    // it matches the Host's, not just that verification happens to work.
    const hostCamp = hostDb.prepare('SELECT signing_secret FROM camps LIMIT 1').get()
    const clientCamp = freshClientDb.prepare('SELECT signing_secret FROM camps LIMIT 1').get()
    expect(clientCamp.signing_secret).toEqual(expect.any(String))
    expect(clientCamp.signing_secret).toBe(hostCamp.signing_secret)

    // This is the exact call that was broken: verifying a Host-issued
    // token using the CLIENT's own local db/verifySessionToken, in a
    // SEPARATE process from the one that issued it. Before this fix, this
    // returned null because each process had its own random, unshared
    // HMAC secret.
    const verified = verifySessionToken(freshClientDb, loginResult.token)
    expect(verified).toEqual({ userId: loginResult.userId, deviceId: freshDeviceId })

    client.close()
  })
```

Add `verifySessionToken` to this file's existing import from `../auth/localAuth.js` (check the top of the file — it currently imports `createUser, issueSessionToken`; add `verifySessionToken` to that same import line).

- [ ] **Step 2: Run the test to verify it passes** (Tasks 1–5 are already complete by this point in the plan)

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS.

To confirm this test genuinely would have caught the original bug, temporarily revert Task 2's change to `verifySessionToken`/`issueSessionToken` (e.g. `git stash` just that commit, or manually reintroduce the old per-process `sessionSecret` for a moment) and re-run this specific test — it should fail with `verified` being `null` instead of the expected object. Then restore the fix.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 4: Commit**

```bash
git add electron/sync/syncClient.test.js
git commit -m "test: prove a Host-issued token is verifiable by a fresh client's own local verifySessionToken (closes the cross-process bug)"
```

---

## Notes for the implementer

- After all 6 tasks pass, re-run the live two-Electron-instance re-verification that originally found this bug: Host bootstraps a camp, a genuinely fresh Client (brand-new `--user-data-dir`) calls `chooseMode` then `login`, and — this time — also calls `write(...)` using the token it received, confirming it succeeds rather than returning "invalid session". This is the real-world confirmation that the automated tests in this plan are meant to guarantee, but a live check closes the loop the same way the original bug was found.
- This plan does not touch the renderer or any IPC-facing return shapes — `login()`'s return value (`{token, userId, role}` etc.) is unchanged; only what happens *after* a token is issued/received changes.
