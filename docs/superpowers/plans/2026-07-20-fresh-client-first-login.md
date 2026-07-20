# Fresh-Client First-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a genuinely fresh Client device (zero local `users`/`camps` rows) obtain its first session token by verifying its PIN attempt against the Host over the existing WebSocket connection, closing a circular dependency that currently makes first-time joins impossible.

**Architecture:** Extract the PIN-check-and-lockout logic that already exists inside `main.js`'s `login()` closure into a shared, standalone `attemptLogin(db, { name, pin, deviceId })` function in `electron/auth/localAuth.js`. Add a new unauthenticated WebSocket message type (`login` → `login_ok`/`login_failed`) in `syncServer.js` that calls this same function on the Host's data. Extend `syncClient.js` so a Client can open its WebSocket connection *before* it has a token, and add a `loginRemote({ name, pin })` method that sends this new message and, on success, automatically authenticates using the returned token. Rewire `main.js` so client-mode `chooseMode` creates the syncClient immediately (without a token) and `login()` tries the remote path first when connected, falling back to local verification when offline.

**Tech Stack:** Node.js (ESM), `better-sqlite3`, `ws`, Vitest.

## Global Constraints

- All writes to synced entities must route through `syncClient.write(...)` — this plan does not touch that rule, but do not introduce any new direct `appendOp` call from application code.
- Any change to `electron/db/schema.sql` must follow the project's existing versioned migration pattern (`schema_migrations` table, `PRAGMA table_info()` existence guards). This plan does not require a schema change — flag it if a task turns out to need one.
- Every new WebSocket message handler must: reject non-object/malformed JSON before touching properties, validate every field's *type* (not just presence), and never let a single connection's bad message crash the server for other connections — match the existing `validateAcquireLockMsg`/`validateSubmitOpMsg` pattern in `electron/sync/syncServer.js`.
- Raw PIN values must never cross the Electron IPC boundary into the renderer under any circumstance (existing `sanitizeOpForIpc`/`sanitizeConflictForIpc` rule in `electron/main.js`) — this plan's new WebSocket traffic (Host↔Client) is explicitly exempted per the design doc's accepted tradeoff, but nothing in this plan should route a raw PIN through `webContents.send`.

---

### Task 1: Extract `attemptLogin` into `electron/auth/localAuth.js`

**Files:**
- Modify: `electron/auth/localAuth.js`
- Modify: `electron/main.js:13-14` (constants), `electron/main.js:76-90` (closures), `electron/main.js:135-172` (`login` function body)
- Test: `electron/auth/localAuth.test.js`

**Interfaces:**
- Produces: `export function attemptLogin(db, { name, pin, deviceId })` in `electron/auth/localAuth.js`, returning `{ token, userId, role }` on success, `{ locked: true, retryAfterMs }` when locked out, or `null` on bad credentials — identical shape to what `main.js`'s `login()` returns today.
- Consumes: nothing new — this task only relocates existing logic (`verifyPin`, `issueSessionToken`, and the `login_attempts` table already used by `main.js`).

This is a pure refactor: `login()`'s *external* behavior (return shapes, lockout timing, rate-limit thresholds) must not change. No existing test in `main.test.js` should need modification for this task.

- [ ] **Step 1: Read the current `login()` implementation and its helper closures**

Confirm you're looking at exactly this (in `electron/main.js`):

```js
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000
```

and, inside `makeHandlers`:

```js
  function attemptsRow(name) {
    return db.prepare('SELECT name, count, locked_until FROM login_attempts WHERE name = ?').get(name)
  }

  function saveAttempts(name, count, lockedUntil) {
    db.prepare(
      'INSERT OR REPLACE INTO login_attempts (name, count, locked_until) VALUES (?, ?, ?)'
    ).run(name, count, lockedUntil != null ? String(lockedUntil) : null)
  }

  function clearAttempts(name) {
    db.prepare('DELETE FROM login_attempts WHERE name = ?').run(name)
  }
```

and the body of `login`:

```js
  function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    const attempt = attemptsRow(name)
    const lockedUntil = attempt && attempt.locked_until ? Number(attempt.locked_until) : 0
    if (lockedUntil && lockedUntil > Date.now()) {
      return { locked: true, retryAfterMs: lockedUntil - Date.now() }
    }

    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return null
    const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
    if (!user || !verifyPin(db, user.id, pin)) {
      let count = (attempt ? attempt.count : 0) + 1
      let newLockedUntil = null
      if (count >= LOGIN_MAX_ATTEMPTS) {
        newLockedUntil = Date.now() + LOGIN_LOCKOUT_MS
        count = 0
      }
      saveAttempts(name, count, newLockedUntil)
      return null
    }

    clearAttempts(name)

    const token = issueSessionToken(user.id, deviceId)

    if (mode === 'client' && pendingServerUrl && !syncClient) {
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
        token,
      })
      wireOpApplied()
    }

    return { token, userId: user.id, role: user.role }
  }
```

Note the last block (the `if (mode === 'client' && ...)` syncClient-creation side effect) is **specific to `main.js`'s IPC handler** and must stay there — it does not belong in the shared `attemptLogin` function, which should only do PIN verification, lockout bookkeeping, and token issuance. Do not move it yet; Task 4 removes it entirely (client-mode syncClient creation moves to `chooseMode`).

- [ ] **Step 2: Add `attemptLogin` to `electron/auth/localAuth.js`**

Add these constants near the top of the file (after the existing `SCRYPT_KEYLEN`/`sessionSecret` constants) and the new function at the end of the file:

```js
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000
```

```js
function attemptsRow(db, name) {
  return db.prepare('SELECT name, count, locked_until FROM login_attempts WHERE name = ?').get(name)
}

function saveAttempts(db, name, count, lockedUntil) {
  db.prepare(
    'INSERT OR REPLACE INTO login_attempts (name, count, locked_until) VALUES (?, ?, ?)'
  ).run(name, count, lockedUntil != null ? String(lockedUntil) : null)
}

function clearAttempts(db, name) {
  db.prepare('DELETE FROM login_attempts WHERE name = ?').run(name)
}

// Shared PIN-verification-and-lockout logic used both for local login (a
// device checking its own local `users` table — main.js's IPC `login`
// handler) and for a Host verifying a remote device's first-time login
// attempt sent unauthenticated over the sync WebSocket (syncServer.js's
// `login` message handler). Keeping this in one place means the two paths
// can never drift out of sync on lockout thresholds or verification rules.
export function attemptLogin(db, { name, pin, deviceId }) {
  const attempt = attemptsRow(db, name)
  const lockedUntil = attempt && attempt.locked_until ? Number(attempt.locked_until) : 0
  if (lockedUntil && lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: lockedUntil - Date.now() }
  }

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return null
  const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
  if (!user || !verifyPin(db, user.id, pin)) {
    let count = (attempt ? attempt.count : 0) + 1
    let newLockedUntil = null
    if (count >= LOGIN_MAX_ATTEMPTS) {
      newLockedUntil = Date.now() + LOGIN_LOCKOUT_MS
      count = 0
    }
    saveAttempts(db, name, count, newLockedUntil)
    return null
  }

  clearAttempts(db, name)

  const token = issueSessionToken(user.id, deviceId)
  return { token, userId: user.id, role: user.role }
}
```

- [ ] **Step 3: Write failing tests for `attemptLogin` directly (bypassing main.js)**

Add to `electron/auth/localAuth.test.js` (check the existing file's imports/setup pattern first — it already opens a real `openLocalDb` against a tmp file and calls `createUser`; match that exact pattern for `db`/`tmpFile` setup):

```js
import { attemptLogin } from './localAuth.js'

describe('attemptLogin', () => {
  it('returns a token for correct camp-scoped name and pin', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Test')
    const user = await createUser(db, { camp_id: campId, name: 'Wanda', pin: '1234', role: 'staff' }, testWrite())

    const result = attemptLogin(db, { name: 'Wanda', pin: '1234', deviceId: 'device-1' })
    expect(result.token).toEqual(expect.any(String))
    expect(result.userId).toBe(user.id)
    expect(result.role).toBe('staff')
  })

  it('returns null for a wrong pin', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Test')
    await createUser(db, { camp_id: campId, name: 'Xena', pin: '1234', role: 'staff' }, testWrite())

    expect(attemptLogin(db, { name: 'Xena', pin: 'wrong', deviceId: 'device-1' })).toBeNull()
  })

  it('returns null when no camp exists at all', () => {
    expect(attemptLogin(db, { name: 'Nobody', pin: '1234', deviceId: 'device-1' })).toBeNull()
  })

  it('locks out after 5 failed attempts and reports retryAfterMs', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Test')
    await createUser(db, { camp_id: campId, name: 'Yara', pin: '5555', role: 'staff' }, testWrite())

    for (let i = 0; i < 5; i++) {
      expect(attemptLogin(db, { name: 'Yara', pin: 'wrong', deviceId: 'device-1' })).toBeNull()
    }
    const result = attemptLogin(db, { name: 'Yara', pin: '5555', deviceId: 'device-1' })
    expect(result).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('issues a token bound to the deviceId passed in, not any other device', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Test')
    await createUser(db, { camp_id: campId, name: 'Zane', pin: '9999', role: 'admin' }, testWrite())

    const result = attemptLogin(db, { name: 'Zane', pin: '9999', deviceId: 'remote-device-42' })
    const verified = verifySessionToken(result.token)
    expect(verified.deviceId).toBe('remote-device-42')
  })
})
```

If `localAuth.test.js` does not already export a `testWrite()`-style helper matching the pattern used elsewhere in this plan (a function returning an async `write` callback that calls `appendOp` directly against the test db), add one at the top of the file:

```js
function testWrite() {
  return async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, {
      entity,
      entity_id,
      field,
      value,
      author_user_id: null,
      device_id: 'test-device',
      parent_op_id: null,
    })
    return { status: 'applied', op }
  }
}
```

(Add `import { appendOp } from '../ops/operations.js'` and `import { randomUUID } from 'node:crypto'` if not already imported.)

- [ ] **Step 4: Run the new tests to verify they fail before the implementation exists (if you did Step 3 before Step 2, otherwise skip — Step 2 already added the implementation)**

If you implemented Step 2 before Step 3 (as ordered above), skip this — instead just run the tests now to confirm they pass:

Run: `npx vitest run electron/auth/localAuth.test.js`
Expected: all tests pass, including the 5 new ones.

- [ ] **Step 5: Rewire `main.js`'s `login()` to delegate to `attemptLogin`**

Replace the `attemptsRow`/`saveAttempts`/`clearAttempts` closures and the body of `login` in `electron/main.js` with:

```js
  function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    const result = attemptLogin(db, { name, pin, deviceId })
    if (!result || result.locked) return result

    if (mode === 'client' && pendingServerUrl && !syncClient) {
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
        token: result.token,
      })
      wireOpApplied()
    }

    return result
  }
```

Remove the now-unused `LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCKOUT_MS` constants from the top of `electron/main.js` (they now live in `localAuth.js`). Update the import line at the top of `electron/main.js`:

```js
import { createUser, verifyPin, issueSessionToken, verifySessionToken, attemptLogin } from './auth/localAuth.js'
```

(`verifyPin` may become unused in `main.js` after this — check with a grep for `verifyPin(` in `electron/main.js` after this edit; if no other call site remains, remove it from the import list.)

- [ ] **Step 6: Run the full existing test suite to confirm zero behavior change**

Run: `npx vitest run`
Expected: all tests pass with the same counts as before this task (no test in `electron/main.test.js` should have needed changes — if any did, something in this refactor changed observable behavior and needs to be fixed before proceeding).

- [ ] **Step 7: Commit**

```bash
git add electron/auth/localAuth.js electron/auth/localAuth.test.js electron/main.js
git commit -m "refactor: extract shared attemptLogin from main.js's login() closure"
```

---

### Task 2: Add unauthenticated `login` WebSocket message handling to `syncServer.js`

**Files:**
- Modify: `electron/sync/syncServer.js`
- Test: `electron/sync/syncServer.test.js`

**Interfaces:**
- Consumes: `attemptLogin(db, { name, pin, deviceId })` from Task 1 (`electron/auth/localAuth.js`).
- Produces: the Host now responds to an unauthenticated `{ type: 'login', device_id, name, pin }` WebSocket message with either `{ type: 'login_ok', token, userId, role }` or `{ type: 'login_failed', locked, retryAfterMs }` (the `locked`/`retryAfterMs` fields are present only when `attemptLogin` returned a lockout result; otherwise the message is just `{ type: 'login_failed' }`). This task does not touch `syncClient.js` or `main.js` — it's tested purely at the wire-protocol level using a raw `ws` connection, exactly like the existing `authenticate`/`acquire_lock` tests in `syncServer.test.js`.

- [ ] **Step 1: Write failing integration tests using the existing raw-`ws` test pattern**

Add to `electron/sync/syncServer.test.js` (this file already has `connect()`, `onceOpen()`, `onceMessage()` helpers and a `beforeEach` that seeds a camp + an `Alice`/`1234`/`admin` user — reuse them exactly as-is):

```js
import { attemptLogin } from '../auth/localAuth.js'

describe('unauthenticated login message', () => {
  it('responds login_ok with a token bound to the requesting device_id', async () => {
    const ws = connect()
    await onceOpen(ws)
    const remoteDeviceId = randomUUID()
    ws.send(JSON.stringify({ type: 'login', device_id: remoteDeviceId, name: 'Alice', pin: '1234' }))

    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_ok')
    expect(reply.token).toEqual(expect.any(String))
    expect(reply.userId).toBe(userId)
    expect(reply.role).toBe('admin')

    ws.close()
  })

  it('responds login_failed for a wrong pin, without closing the connection', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice', pin: 'wrong' }))

    const reply = await onceMessage(ws)
    expect(reply).toEqual({ type: 'login_failed' })
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.close()
  })

  it('responds login_failed with lockout info after 5 failed attempts', async () => {
    const ws = connect()
    await onceOpen(ws)

    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice', pin: 'wrong' }))
      await onceMessage(ws)
    }
    ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice', pin: '1234' }))
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_failed')
    expect(reply.locked).toBe(true)
    expect(reply.retryAfterMs).toBeGreaterThan(0)

    ws.close()
  })

  it('does not set ws.deviceId as a side effect of login alone (still requires authenticate)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice', pin: '1234' }))
    await onceMessage(ws)

    // A subsequent acquire_lock without ever sending `authenticate` must be
    // silently ignored, exactly like today's behavior for any message sent
    // before authenticate succeeds.
    ws.send(JSON.stringify({ type: 'acquire_lock', entity: 'x', entity_id: 'y', field: 'z' }))
    let gotReply = false
    ws.once('message', () => { gotReply = true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(gotReply).toBe(false)

    ws.close()
  })

  it('ignores a malformed login message (missing pin) without crashing the connection', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice' }))

    // Send a well-formed, unrelated message afterward and confirm the
    // connection is still alive and responsive.
    ws.send(JSON.stringify({ type: 'login', device_id: randomUUID(), name: 'Alice', pin: '1234' }))
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_ok')

    ws.close()
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: FAIL — no `login` message type is handled yet, so these tests time out waiting for a reply or see unexpected behavior.

- [ ] **Step 3: Implement the `login` message handler in `electron/sync/syncServer.js`**

Add the import at the top of the file:

```js
import { verifySessionToken, attemptLogin } from '../auth/localAuth.js'
```

(Check the existing import line — this file likely already imports `verifySessionToken` for `handleAuthenticate`; add `attemptLogin` to that same import.)

Add a validator function near the existing `validateAcquireLockMsg`/`validateSubmitOpMsg`:

```js
function validateLoginMsg(msg) {
  return isNonEmptyString(msg.device_id) && isNonEmptyString(msg.name) && isNonEmptyString(msg.pin)
}
```

Add a handler function near `handleAuthenticate`:

```js
function handleLogin(db, ws, msg) {
  if (!validateLoginMsg(msg)) return

  const result = attemptLogin(db, { name: msg.name, pin: msg.pin, deviceId: msg.device_id })

  if (!result) {
    send(ws, { type: 'login_failed' })
    return
  }
  if (result.locked) {
    send(ws, { type: 'login_failed', locked: true, retryAfterMs: result.retryAfterMs })
    return
  }
  send(ws, { type: 'login_ok', token: result.token, userId: result.userId, role: result.role })
}
```

(Use whatever the existing unauthenticated-send helper is named in this file — check whether `sendMissedOps`'s `send`/`sendWithAck` helper is reused elsewhere for a plain one-shot send, or if there's a simpler `ws.send(JSON.stringify(...))` pattern used directly in `handleAuthenticate`/`sendError`. Match the existing convention exactly rather than introducing a second way to send a message.)

In the main `wss.on('connection', ...)` message dispatch, add the `login` branch **before** the `if (!ws.deviceId) return` gate (in the same unauthenticated section as `authenticate`):

```js
        if (msg.type === 'authenticate') {
          handleAuthenticate(db, ws, msg)
          return
        }

        if (msg.type === 'login') {
          handleLogin(db, ws, msg)
          return
        }

        if (!ws.deviceId) return
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `npx vitest run electron/sync/syncServer.test.js`
Expected: PASS — all 5 new tests plus every pre-existing test in this file.

- [ ] **Step 5: Run the full suite to confirm no regressions elsewhere**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 6: Commit**

```bash
git add electron/sync/syncServer.js electron/sync/syncServer.test.js
git commit -m "feat: add unauthenticated login WS message so a fresh device can verify PIN remotely"
```

---

### Task 3: Add remote-login capability to `syncClient.js`

**Files:**
- Modify: `electron/sync/syncClient.js`
- Test: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: the `login`/`login_ok`/`login_failed` WebSocket protocol from Task 2 (tested against a real `startSyncServer` instance, same pattern as this file's existing tests).
- Produces: `createSyncClient(db, { device_id, author_user_id, serverUrl, token })` now accepts `token` as **optional** (previously implicitly required for a real connection to authenticate). The returned object gains a new method: `async loginRemote({ name, pin })` → returns `{ status: 'ok', token, userId, role }`, `{ status: 'failed', locked, retryAfterMs }` (fields present only when locked), `{ status: 'disconnected' }`, or `{ status: 'timeout' }`. On `'ok'`, the client automatically sends `authenticate` with the received token — callers do not need to do anything further for the connection to become authenticated.

- [ ] **Step 1: Write failing tests using this file's existing real-server-pair pattern**

Add to `electron/sync/syncClient.test.js` a new describe block. Use a fresh, dedicated port and a genuinely empty client db (do not reuse the shared `beforeEach`'s pre-seeded `clientDb`, since the whole point is testing the zero-local-state case):

```js
describe('remote login (fresh client, no local token yet)', () => {
  const REMOTE_LOGIN_PORT = 8240
  let freshClientDb, freshClientFile, remoteLoginServer

  beforeEach(() => {
    freshClientFile = path.join(os.tmpdir(), `shoresh-sc-fresh-${Date.now()}-${Math.random()}.sqlite`)
    freshClientDb = openLocalDb(freshClientFile)
    remoteLoginServer = startSyncServer(hostDb, { port: REMOTE_LOGIN_PORT })
  })

  afterEach(() => {
    remoteLoginServer.close()
    freshClientDb.close()
    fs.unlinkSync(freshClientFile)
  })

  it('connects with no token, then loginRemote yields a token and authenticates', async () => {
    const freshDeviceId = randomUUID()
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
      // no token — this is the whole point
    })
    await client.waitUntilConnected()

    const result = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(result.status).toBe('ok')
    expect(result.token).toEqual(expect.any(String))
    expect(result.userId).toBe(userId)
    expect(result.role).toBe('admin')

    // Now-authenticated: a real write should succeed (proves the automatic
    // `authenticate` send after loginRemote actually worked server-side).
    const writeResult = await client.write({ entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' })
    expect(writeResult.status).toBe('applied')

    client.close()
  })

  it('returns status "failed" for a wrong pin, and the connection stays usable', async () => {
    const client = createSyncClient(freshClientDb, {
      device_id: randomUUID(),
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    await client.waitUntilConnected()

    const result = await client.loginRemote({ name: 'Alice', pin: 'wrong' })
    expect(result).toEqual({ status: 'failed' })

    // Retry with the correct pin on the SAME connection must still work.
    const retry = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(retry.status).toBe('ok')

    client.close()
  })

  it('returns status "disconnected" if the socket is not open when loginRemote is called', async () => {
    const client = createSyncClient(freshClientDb, {
      device_id: randomUUID(),
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    client.close() // never awaited connection, then closed immediately

    const result = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(result.status).toBe('disconnected')
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: FAIL — `createSyncClient` currently requires `token` in order to send a meaningful `authenticate` on connect, and `loginRemote` does not exist yet.

- [ ] **Step 3: Make `token` mutable and skip sending `authenticate` on connect when it's absent**

In `electron/sync/syncClient.js`, the destructured `token` parameter is currently a `const` captured by `connect()`'s closure. Change it to a mutable local variable. Find:

```js
export function createSyncClient(
  db,
  { device_id, author_user_id, serverUrl, token, lockTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS, submitTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS }
) {
  const opAppliedListeners = []
  const opConflictListeners = []
  const queue = []
```

Replace with:

```js
export function createSyncClient(
  db,
  { device_id, author_user_id, serverUrl, token: initialToken, lockTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS, submitTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS }
) {
  const opAppliedListeners = []
  const opConflictListeners = []
  const queue = []
  let token = initialToken
```

Then find, inside `connect()`:

```js
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
      connected = true
      connectedResolve()
    })
```

Replace with:

```js
    ws.on('open', () => {
      if (token) {
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
      }
      connected = true
      connectedResolve()
    })
```

- [ ] **Step 4: Add a `loginResolvers` array and drain it on disconnect**

Find:

```js
  const lockResolvers = []
  const submitResolvers = []
```

Replace with:

```js
  const lockResolvers = []
  const submitResolvers = []
  const loginResolvers = []
```

Find `settlePendingOnDisconnect` (inside `connect()`):

```js
    function settlePendingOnDisconnect() {
      while (lockResolvers.length) {
        const resolve = lockResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (submitResolvers.length) {
        const resolve = submitResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
    }
```

Replace with:

```js
    function settlePendingOnDisconnect() {
      while (lockResolvers.length) {
        const resolve = lockResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (submitResolvers.length) {
        const resolve = submitResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (loginResolvers.length) {
        const resolve = loginResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
    }
```

- [ ] **Step 5: Handle `login_ok`/`login_failed` in the message dispatch**

Find the `if (msg.type === 'lock_result') { ... }` block inside `ws.on('message', ...)` and add a new block immediately after it (before the `op_applied` handling):

```js
        if (msg.type === 'lock_result') {
          const resolve = lockResolvers.shift()
          if (resolve) resolve(msg)
          return
        }

        if (msg.type === 'login_ok' || msg.type === 'login_failed') {
          const resolve = loginResolvers.shift()
          if (resolve) resolve(msg)
          return
        }
```

- [ ] **Step 6: Add the `loginRemote` method to the returned object**

`withResolverTimeout` already exists and is generic (`resolversArray`, `timeoutMs`, `sendFn`) — reuse it exactly as `acquireLockRemote`/`submitOpRemote` do. Add this function near those two (before the `return { ... }` block at the end of `createSyncClient`):

```js
  function sendLoginRemote({ name, pin }) {
    return withResolverTimeout(loginResolvers, lockTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'login', device_id, name, pin }))
    })
  }
```

(Named `sendLoginRemote`, not `loginRemote`, specifically to avoid a name collision with the public method of the same name added next — object-literal method names don't create a self-referencing binding in JS, so reusing the same name would technically still resolve correctly to this outer closure function, but it's a needless trap for a future edit. Keep them distinct.)

Add `loginRemote` to the returned object (inside the final `return { ... }`), and translate the raw message shape into the caller-facing status shape described in the Task 3 header:

```js
    async loginRemote({ name, pin }) {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        return { status: 'disconnected' }
      }
      const reply = await sendLoginRemote({ name, pin })
      if (reply.status === 'disconnected' || reply.status === 'timeout') return reply
      if (reply.type === 'login_ok') {
        token = reply.token
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
        return { status: 'ok', token: reply.token, userId: reply.userId, role: reply.role }
      }
      // login_failed
      return reply.locked
        ? { status: 'failed', locked: true, retryAfterMs: reply.retryAfterMs }
        : { status: 'failed' }
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected: PASS — all 3 new tests plus every pre-existing test in this file (the `token`-optional change and the connect()-without-authenticate change must not break any test that already passes a real `token` — double check the pre-existing `beforeEach`'s `token` variable still flows through unchanged for every other describe block).

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 9: Commit**

```bash
git add electron/sync/syncClient.js electron/sync/syncClient.test.js
git commit -m "feat: support connecting without a token and remote-verifying PIN via loginRemote"
```

---

### Task 4: Rewire `main.js`'s `chooseMode`/`login` for client mode

**Files:**
- Modify: `electron/main.js:103-172` (`chooseMode`, `login`)
- Modify: `electron/main.test.js` (see exact list of affected tests below)

**Interfaces:**
- Consumes: `syncClient.loginRemote({ name, pin })` from Task 3.
- Produces: `chooseMode({ mode: 'client', ... })` now creates the `syncClient` immediately (no token). `login({ name, pin })` is now `async`. For client mode with a connected `syncClient`, it tries `syncClient.loginRemote(...)` first; on `'disconnected'`/`'timeout'`, it falls back to local `attemptLogin`. For host mode (or no mode chosen yet), it always uses local `attemptLogin`, unchanged from today.

- [ ] **Step 1: Update `chooseMode` to create the syncClient immediately for client mode**

Find, in `electron/main.js`:

```js
    if (requestedMode === 'host') {
      startSyncServer(db, { port })
      advertiseHost({ campName, port })
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
    } else {
      pendingServerUrl = resolveClientServerUrl(args)
    }
```

Replace with:

```js
    if (requestedMode === 'host') {
      startSyncServer(db, { port })
      advertiseHost({ campName, port })
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
    } else {
      pendingServerUrl = resolveClientServerUrl(args)
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
      })
      wireOpApplied()
    }
```

- [ ] **Step 2: Rewrite `login` to try remote verification first for client mode**

Replace the `login` function (written in Task 1's Step 5) with:

```js
  async function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    if (mode === 'client' && syncClient) {
      const remoteResult = await syncClient.loginRemote({ name, pin })
      if (remoteResult.status === 'ok') {
        return { token: remoteResult.token, userId: remoteResult.userId, role: remoteResult.role }
      }
      if (remoteResult.status === 'failed') {
        return remoteResult.locked ? { locked: true, retryAfterMs: remoteResult.retryAfterMs } : null
      }
      // 'disconnected' or 'timeout': fall through to local verification below,
      // which only succeeds for a device that has already synced once before.
      // A genuinely fresh, offline device gets a clear, distinct signal
      // rather than the generic invalid-credentials response.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (!camp) {
        return { offline: true, reason: 'Connect to the camp network to sign in for the first time.' }
      }
    }

    return attemptLogin(db, { name, pin, deviceId })
  }
```

Note: `login` is now `async` for every mode, not just client mode — `ipcMain.handle('shoresh:login', ...)` already supports an async handler transparently (it always returns whatever the handler returns via `Promise.resolve`), so no change is needed at that call site.

- [ ] **Step 3: Update `electron/main.test.js`'s mocked `createSyncClient` to support `loginRemote`**

Find the mock definition near the top of the file:

```js
vi.mock('./sync/syncClient.js', () => ({
  createSyncClient: vi.fn((mockDb, opts) => {
    const client = {
      opts,
      write: vi.fn(async ({ entity, entity_id, field, value, author_user_id }) => {
        const op = appendOp(mockDb, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: author_user_id ?? opts.author_user_id ?? null,
          device_id: opts.device_id,
          parent_op_id: null,
        })
        return { status: 'applied', op }
      }),
      onOpApplied: vi.fn(),
      onOpConflict: vi.fn(),
    }
    lastCreatedSyncClient = client
    return client
  }),
}))
```

Replace with (adds a `loginRemote` mock that calls the real `attemptLogin` against the mocked db, mirroring what the real syncClient/syncServer round-trip would do — this keeps the mock's behavior faithful without needing a real WebSocket in this file's tests, which are deliberately main-process-only unit tests):

```js
vi.mock('./sync/syncClient.js', () => ({
  createSyncClient: vi.fn((mockDb, opts) => {
    const client = {
      opts,
      write: vi.fn(async ({ entity, entity_id, field, value, author_user_id }) => {
        const op = appendOp(mockDb, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: author_user_id ?? opts.author_user_id ?? null,
          device_id: opts.device_id,
          parent_op_id: null,
        })
        return { status: 'applied', op }
      }),
      onOpApplied: vi.fn(),
      onOpConflict: vi.fn(),
      loginRemote: vi.fn(async ({ name, pin }) => {
        const result = attemptLoginRef({ name, pin, deviceId: opts.device_id })
        if (!result) return { status: 'failed' }
        if (result.locked) return { status: 'failed', locked: true, retryAfterMs: result.retryAfterMs }
        return { status: 'ok', token: result.token, userId: result.userId, role: result.role }
      }),
    }
    lastCreatedSyncClient = client
    return client
  }),
}))
```

This mock needs access to the real `attemptLogin` and the real `mockDb` at call time — since `vi.mock` factories run before other imports are set up, add a small indirection. Immediately after the existing `import { createUser } from './auth/localAuth.js'` line near the top of the file, add:

```js
import { createUser, attemptLogin } from './auth/localAuth.js'
let attemptLoginRef = (args) => attemptLogin(db, args)
```

(`db` here refers to the `let db` already declared later in the file for `beforeEach`, which is fine since `attemptLoginRef` is only ever called after `beforeEach` has run and `db` is assigned — closures capture the variable, not its value at declaration time.)

- [ ] **Step 4: Update the `chooseMode: client path` describe block**

Find:

```js
  it('validates the host/port and stores the serverUrl WITHOUT creating a syncClient yet (Fix E)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('accepts a pre-validated hostAddress string directly without creating a syncClient yet', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('creates the syncClient with a token only after a successful login (Fix E)', async () => {
    const { user } = await seedCampAndUser({ name: 'Dana', pin: '5555' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })
    expect(createSyncClient).not.toHaveBeenCalled()

    const result = handlers.login({ name: 'Dana', pin: '5555' })

    expect(result).toBeTruthy()
    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
      token: result.token,
    })
    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
    void user
  })
```

Replace with:

```js
  it('validates the host/port and creates a syncClient immediately, without a token', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    })
    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
  })

  it('accepts a pre-validated hostAddress string directly and creates a syncClient without a token', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    })
  })

  it('a fresh client with zero local users can still log in via the syncClient.loginRemote path', async () => {
    const { user } = await seedCampAndUser({ name: 'Dana', pin: '5555' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    const result = await handlers.login({ name: 'Dana', pin: '5555' })

    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    expect(lastCreatedSyncClient.loginRemote).toHaveBeenCalledWith({ name: 'Dana', pin: '5555' })
    void user
  })
```

- [ ] **Step 5: Add a test for the offline-fresh-device fallback branch**

Add this test to the `chooseMode: client path` describe block (same block as Step 4's tests), using the same `mockResolvedValueOnce`-override pattern already used elsewhere in this file (see the existing `lastCreatedSyncClient.write.mockImplementationOnce(...)` test under `describe('createUser handler ...')` for precedent):

```js
  it('returns a distinct offline signal for a fresh device with no local camp and no live connection', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    lastCreatedSyncClient.loginRemote.mockResolvedValueOnce({ status: 'disconnected' })

    const result = await handlers.login({ name: 'Dana', pin: '5555' })
    expect(result).toEqual({ offline: true, reason: expect.any(String) })
  })
```

Confirm `db` has zero rows in `camps` at this point in the test (it does — nothing in this test seeds a camp), so `login`'s fallback branch in `electron/main.js` correctly hits the `if (!camp) return { offline: true, ... }` path rather than falling through to `attemptLogin`.

- [ ] **Step 6: Update the `chooseMode: idempotency (Fix C)` and `same-mode replay` describe blocks**

Find:

```js
  it('is a no-op when replayed for client mode too, without creating a second syncClient', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).not.toHaveBeenCalled()
  })
```

Replace with:

```js
  it('is a no-op when replayed for client mode, without creating a SECOND syncClient', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).toHaveBeenCalledTimes(1)
  })
```

(The other tests in `chooseMode: idempotency (Fix C)` and `chooseMode: same-mode replay is a no-op (Round 2 Fix 1)` exercise host mode only and are unaffected — leave them as-is.)

- [ ] **Step 7: Convert every remaining synchronous `handlers.login(...)` call site to `await`**

`login` is now `async` everywhere. Every one of the following call sites (by exact current line number, from a `grep -n "handlers.login("` on the pre-Task-4 file) must be changed from `handlers.login({...})` to `await handlers.login({...})`, and its enclosing `it(...)` callback must be `async` (all of them already are `async` except where noted):

- Line 236 (`describe('login')`, "succeeds with correct camp-scoped name and pin") — already `async`.
- Line 245 (same describe, "fails with wrong pin") — already `async`.
- Line 262 (`describe('login: rate limiting (Fix B)')`, inside the `for` loop of "locks out a name after 5 failed attempts...") — already `async`.
- Line 269 (same test, the locked-result check) — already `async`.
- Line 277 ("still returns plain null for a simple wrong PIN") — already `async`.
- Lines 285, 287, 290, 291, 292 ("resets the failure counter for a name after a successful login") — already `async`.
- Line 304 (`describe('login: lockout persists across a simulated app restart')`, `handlers1.login`) — already `async`.
- Line 315 (same test, `handlers2.login`) — already `async`.
- Line 324 (`describe('shoresh:verify-session handler')`, "returns valid:true...") — already `async`.
- Line 379 (`describe('createUser handler')`, "rejects create-user when the token belongs to a non-admin") — already `async`.
- Line 389 ("validates required fields once an admin session is presented") — already `async`.
- Line 401 ("creates a user when an admin session and all fields are valid") — already `async`.
- Line 411 ("propagates a clear rejection...") — already `async`.
- Line 425 (`describe('write handler')`, "rejects a write with a clear error when no syncClient exists yet") — already `async`.
- Line 449 ("delegates to syncClient.write with a valid session token") — already `async`.

Every one of these `it(...)` callbacks is already declared `async` (confirmed by reading the file in full during planning) — the only change needed at each of the 15 lines above is adding `await` immediately before `handlers.login(`. There is no test here whose callback needs to be converted from non-async to async as a separate step.

Two exceptions need a closer look — these currently call `login` and immediately assert on the return value being `null`/falsy in a way that must keep working with `await`:

Find (still inside `describe('login: rate limiting (Fix B)')`):

```js
    for (let i = 0; i < 5; i++) {
      expect(handlers.login({ name: 'Eve', pin: 'wrong' })).toBeNull()
    }
```

Replace with:

```js
    for (let i = 0; i < 5; i++) {
      expect(await handlers.login({ name: 'Eve', pin: 'wrong' })).toBeNull()
    }
```

Apply the exact same `expect(handlers.login(...))` → `expect(await handlers.login(...))` transformation at every other line listed above that wraps the call directly in `expect(...)`. For the lines that instead destructure the result (e.g. `const { token } = handlers.login({...})` or `const result = handlers.login({...})`), change to `const { token } = await handlers.login({...})` / `const result = await handlers.login({...})` respectively.

- [ ] **Step 8: Run the full `main.test.js` file**

Run: `npx vitest run electron/main.test.js`
Expected: PASS — every test in this file, including the rewritten Task-4 tests and every mechanically-`await`-ed call site from Step 6.

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 10: Commit**

```bash
git add electron/main.js electron/main.test.js
git commit -m "feat: create client syncClient at chooseMode time and try remote login before local fallback"
```

---

### Task 5: End-to-end regression test — the exact scenario that was broken

**Files:**
- Test: `electron/sync/syncClient.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3 (`syncServer.js`'s `login` handling, `syncClient.js`'s `loginRemote`) at the `syncClient`/`syncServer` layer directly — this task does not go through `main.js`'s IPC handlers, since `electron/main.test.js` already covers that layer in Task 4. This test proves the underlying mechanism works with a real WebSocket connection and two real, independent SQLite files, which is the exact configuration the original bug was found in (two real Electron processes, each with its own `shoresh.sqlite`).

- [ ] **Step 1: Write the failing end-to-end test**

Add to `electron/sync/syncClient.test.js`, inside (or after) the `describe('remote login (fresh client, no local token yet)', ...)` block added in Task 3:

```js
  it('a fresh client with a completely empty local db can join, get full-synced, and write', async () => {
    // Deliberately do NOT seed freshClientDb with any camps/users/devices
    // rows — this is the exact "genuinely fresh device" scenario the
    // original bug was found in. Confirm it really is empty first.
    expect(freshClientDb.prepare('SELECT COUNT(*) as n FROM camps').get().n).toBe(0)
    expect(freshClientDb.prepare('SELECT COUNT(*) as n FROM users').get().n).toBe(0)

    const freshDeviceId = randomUUID()
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    await client.waitUntilConnected()

    // Step 1: the circular dependency this whole plan exists to break —
    // login before any local data exists.
    const loginResult = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(loginResult.status).toBe('ok')

    // Step 2: full-sync should now have populated local camps/users (this is
    // the existing Sync-Task 4 mechanism — this test proves it actually
    // fires for a client that reached authentication via loginRemote,
    // exactly as it does for a client that already had a token).
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(freshClientDb.prepare('SELECT COUNT(*) as n FROM camps').get().n).toBeGreaterThan(0)
    expect(freshClientDb.prepare('SELECT COUNT(*) as n FROM users').get().n).toBeGreaterThan(0)
    const syncedUser = freshClientDb.prepare('SELECT * FROM users WHERE id = ?').get(loginResult.userId)
    expect(syncedUser.name).toBe('Alice')

    // Step 3: a normal op-log write now succeeds — this device is fully
    // operational, not just nominally authenticated.
    const writeResult = await client.write({ entity: 'activities', entity_id: 'a2', field: 'name', value: 'Ceramics' })
    expect(writeResult.status).toBe('applied')

    client.close()
  })
```

- [ ] **Step 2: Run the test to verify it fails on the pre-Task-1-through-4 code**

(This step is informational if you're implementing tasks in order — Tasks 1–4 will already be done by this point, so this test should already pass. If you want to verify it would have caught the original bug, temporarily `git stash` the Task 1–4 changes, run this test, confirm it fails/times out, then `git stash pop`.)

Run: `npx vitest run electron/sync/syncClient.test.js`
Expected (with Tasks 1–4 in place): PASS.

- [ ] **Step 3: Run the full suite one final time**

Run: `npx vitest run`
Expected: all pass except the known pre-existing flaky mDNS test.

- [ ] **Step 4: Commit**

```bash
git add electron/sync/syncClient.test.js
git commit -m "test: add end-to-end regression test for a genuinely fresh client's first login"
```

---

## Notes for the implementer

- This plan does **not** touch the renderer (`src/hooks/useDeviceMode.js`, `src/screens/LoginScreen.jsx`, `src/screens/JoinScreen.jsx`). The `login()` IPC handler's return shape is unchanged for every success/failure case except the new `{ offline: true, reason: '...' }` shape for a genuinely-fresh-and-offline device (Task 4, Step 2) — check whether `useDeviceMode.js`'s existing login-result handling needs a new branch for this shape, or whether it already falls through to a generic "login failed" UI state acceptably. If the UI needs a specific message for this case, that is out of scope for this plan and should be filed as a follow-up.
- The security tradeoff (raw PIN now travels over the LAN WebSocket during `login`/`loginRemote`, not just as an opaque hash) is an accepted, explicit design decision from the design doc — do not attempt to add encryption as part of this plan.
- After this plan lands, re-run the live two-Electron-process smoke test that originally found this bug (build the Host, bootstrap a camp, launch a second Electron process pointed at it with a completely fresh `--user-data-dir`, and confirm `login()` on the fresh Client now succeeds and full-sync populates its local data) before considering this fix verified end-to-end in the real app, not just in the test suite.
