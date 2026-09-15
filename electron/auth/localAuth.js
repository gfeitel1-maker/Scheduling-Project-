import {
  randomUUID,
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import { recordAuditEvent } from '../audit/auditLog.js'
import { signAuthFields } from './authSignature.js'

const SCRYPT_KEYLEN = 64

// PIN HASHING COST, AND WHAT IT DOES AND DOES NOT BUY (T150).
//
// `users.pin_hash`/`pin_salt` are modeled document fields: they replicate to
// every approved device and sit in a plaintext `.automerge` file on each one.
// That is deliberate — offline login has to work on a device that cannot reach
// anyone — but it means the hash is available to anyone holding the file.
//
// Be honest about what raising this cost achieves. The PIN is four digits: ten
// thousand candidates. No KDF parameter makes that space safe; at any cost a
// determined attacker with the file recovers every PIN eventually. What the
// cost DOES do is turn a few minutes of work into a few hours, which is worth
// having and is nearly free (one ~400ms hash at login, not per keystroke).
//
// What actually bounds this risk is the trust model (SECURITY.md): whoever has
// the document already has the camp's data, because the document IS the data.
// Cracking a PIN buys impersonation — authorship, and staff -> admin role
// escalation — not access. That is the exposure to weigh, and it is why the
// open question this leaves is PIN LENGTH and role separation, not scrypt.
//
// N is the memory/CPU cost parameter; 2^16 needs 128*r*N = 64MB, which exceeds
// Node's 32MB default maxmem, so maxmem must be raised with it or scryptSync
// throws.
export const SCRYPT_PARAMS = Object.freeze({ N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 })

// The parameters NEW hashes are minted with. Normally SCRYPT_PARAMS; lowered by
// the test suite, and by nothing else.
//
// WHY THIS EXISTS. Raising N to 2^16 made one hash cost ~430ms, which is right
// for a login a person waits on once — and wrong for a test suite that creates
// users constantly. `localAuth.test.js` went from seconds to three minutes, and
// one test began TIMING OUT: six real hashes no longer fit in the 20-second
// per-test budget on a loaded machine. Left alone this gets worse with every
// test that touches auth, and the pressure to "just raise the timeout" ends
// with a suite nobody runs.
//
// Lowering the cost in tests is safe for the same reason the format exists:
// hashes are SELF-DESCRIBING, so one minted cheaply still verifies at the cost
// it was minted with. What must not happen is the lower cost silently shipping —
// so the default is asserted by its own test, and this setter is the only way to
// change it.
let activeScryptParams = SCRYPT_PARAMS

/**
 * TEST ONLY. Pass nothing to restore the production parameters.
 * Never call this from application code — `localAuth.test.js` pins that the
 * default is the real cost, which is the guard that makes this safe.
 */
export function setScryptParamsForTests(params) {
  activeScryptParams = params ? { ...SCRYPT_PARAMS, ...params } : SCRYPT_PARAMS
}

// THE SUITE-WIDE LOWERING, read from the environment rather than set by an
// import — and the difference is not stylistic, it is 6.5 minutes.
//
// The first attempt called setScryptParamsForTests from `vitest.setup.js`.
// That file runs in EVERY test file's environment, so the import pulled this
// module's graph into all ~340 of them, including the jsdom renderer tests that
// have no business loading auth code: total setup time went from 174s to 561s.
// An env var costs one string read, in the one process that already imports
// this file for a real reason.
//
// vite.config.js sets it for `npm test`. Nothing else sets it, and production
// never sees it.
if (process.env.SHORESH_TEST_SCRYPT_N) {
  const n = Number(process.env.SHORESH_TEST_SCRYPT_N)
  if (Number.isInteger(n) && n >= 2 && n <= SCRYPT_PARAMS.N) {
    activeScryptParams = { ...SCRYPT_PARAMS, N: n, maxmem: 32 * 1024 * 1024 }
  }
}

// Hashes produced before T150 are bare hex at Node's DEFAULT scrypt cost, with
// nothing recorded about the parameters used. New ones are self-describing, so
// the cost can be raised again later without a second flag day: the parameters
// travel with the hash.
const SCRYPT_PREFIX = 'scrypt'

// The ceiling on parameters read back OUT of a stored hash. Comfortably above
// SCRYPT_PARAMS so a future raise (or a hash written by a slightly newer build)
// still verifies, and far below anything that could exhaust this process.
// 128 * r * N at the maximum is 2MB * 128 = 256MB, which MAX_SCRYPT_MAXMEM
// covers. See parseStoredHash for why this is a clamp and not a convenience.
const MAX_ACCEPTED_SCRYPT = { N: 1 << 21, r: 16, p: 4 }
const MAX_SCRYPT_MAXMEM = 512 * 1024 * 1024

function formatHash(params, hex) {
  return `${SCRYPT_PREFIX}$N=${params.N},r=${params.r},p=${params.p}$${hex}`
}

// Returns {params, hex} for either format. A stored value with no prefix is a
// legacy hash and must be verified at the OLD (Node default) cost, or every
// existing login breaks.
function parseStoredHash(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    return { params: null, hex: stored }
  }
  const [, paramPart, hex] = stored.split('$')
  const params = {}
  for (const pair of paramPart.split(',')) {
    const [k, v] = pair.split('=')
    params[k] = Number(v)
  }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return null
  }
  // THE STORED HASH IS ATTACKER-INFLUENCED INPUT, and that is easy to forget
  // because it looks like our own data. `users.pin_hash` is a MODELED DOCUMENT
  // FIELD: it replicates, so any peer admitted to the camp can set it to
  // anything. An earlier draft of this function sized `maxmem` from the stored
  // N (`256 * r * N`) so that a legitimately raised cost would still fit —
  // which handed a peer a one-line memory bomb: store N=2^30 and every login
  // attempt on every device tries to allocate hundreds of gigabytes.
  //
  // So the parameters are CLAMPED, not trusted. Anything above what this build
  // would ever produce is refused outright, which reads as a failed login (the
  // only honest outcome: we cannot verify a hash we refuse to compute), never
  // as a crash and never as a successful one.
  if (params.N > MAX_ACCEPTED_SCRYPT.N || params.r > MAX_ACCEPTED_SCRYPT.r || params.p > MAX_ACCEPTED_SCRYPT.p) {
    return null
  }
  if (params.N < 2 || params.r < 1 || params.p < 1) return null
  // maxmem is not stored: it is a ceiling on this process, not part of the
  // hash. It is a FIXED ceiling covering every parameter set this build
  // accepts, never derived from the stored value.
  return { params: { ...params, maxmem: MAX_SCRYPT_MAXMEM }, hex }
}

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000

// Session token lifetime for both 'camp' and 'local' token types — a
// concrete number per docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md
// ("Suggested token lifetime... 24h"). Renewal (sub-task 3) is out of scope
// here; a token past this window simply stops verifying.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// Exported for promoteToAdmin (T163), which mints a fresh hash as part of the
// atomic role change. Reads `activeScryptParams`, not SCRYPT_PARAMS directly
// (T160) — otherwise every promotion in the test suite would pay the full
// production cost that T160 exists to avoid, and the two changes would quietly
// undo each other.
export function hashPin(pin, salt) {
  return formatHash(activeScryptParams, scryptSync(pin, salt, SCRYPT_KEYLEN, activeScryptParams).toString('hex'))
}

const PIN_MAX_LENGTH = 32

// T163 (owner decision 2026-09-14, SECURITY.md T150): a DIRECTOR (role
// 'admin') PIN must be at least 6 digits; staff keep 4. `users.pin_hash`/
// `pin_salt` are modeled document fields that replicate in plaintext to
// every approved device, and a 4-digit PIN is only 10,000 offline guesses —
// the login lockout (attemptLogin's LOGIN_MAX_ATTEMPTS/LOGIN_LOCKOUT_MS)
// does not apply to an attacker working offline against the replicated
// file. ONE constant, not two copies of "6", so the floor can only drift by
// an explicit edit here.
const PIN_MIN_LENGTH = { admin: 6, staff: 4 }

// The chokepoint (T163): called from createUser, before any hashing.
// Renderer validation (CampBootstrapScreen etc.) is a UX affordance only —
// this is the control. Digits-only is a genuine widening of the original
// ask (today any non-empty string up to 32 chars passes, so a staff PIN of
// "a" is currently legal despite the UI promising a numeric keypad); closing
// that costs nothing extra here and removes a UI/server disagreement.
export function assertValidPin(pin, role) {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > PIN_MAX_LENGTH) {
    throw new Error('PIN must be a non-empty string of at most 32 characters')
  }
  if (!/^\d+$/.test(pin)) {
    throw new Error('PIN must contain only digits')
  }
  const min = PIN_MIN_LENGTH[role] ?? PIN_MIN_LENGTH.staff
  if (pin.length < min) {
    throw new Error(`PIN must be at least ${min} digits for this role`)
  }
}

// The login-time shape check used by verifyPin — deliberately NOT
// assertValidPin. Per the owner's decision (T163, no grandfather path, no
// login-time refusal — there is no live camp data and the standing
// preference is a clean cutover, not a migration), an EXISTING admin's
// already-stored 4-digit PIN must keep logging in; enforcing the new
// digit/length rule here would refuse it. This stays only a basic sanity
// check so a garbage argument fails fast instead of reaching scryptSync.
// (Were there live camps, the right compromise would be a flagged-not-
// blocked login nudge rather than a refusal — that answer does not apply
// yet, but a future maintainer re-adding grandfathering should know this is
// why.)
function assertPinShape(pin) {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > PIN_MAX_LENGTH) {
    throw new Error('PIN must be a non-empty string of at most 32 characters')
  }
}

export async function createUser(db, { camp_id, name, pin, role }, write) {
  assertValidPin(pin, role)

  const existing = db.prepare('SELECT id FROM users WHERE camp_id = ? AND name = ?').get(camp_id, name)
  if (existing) {
    throw new Error(`A user named "${name}" already exists in this camp`)
  }

  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = hashPin(pin, salt)
  // Q1 fix (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md): the credential
  // fields carry a Host signature so other devices trust them when they replicate. signAuthFields
  // requires the Host key, so creating a user is a Host-device operation — a Client that tried would
  // produce credentials every device (correctly) refuses. Fail loudly here rather than write an
  // unsigned row that surfaces later as a phantom verification failure.
  // cred_version starts at 1 for a new user and is bound into the signature (T165 replay defense).
  const cred_version = 1
  const auth_sig = signAuthFields(db, { id, role, pin_hash, pin_salt: salt, cred_version })
  const fields = { camp_id, name, pin_hash, pin_salt: salt, role, auth_sig, cred_version }

  try {
    for (const [field, value] of Object.entries(fields)) {
      const result = await write({ entity: 'users', entity_id: id, field, value })
      const status = result && result.status
      if (status !== 'applied') {
        throw new Error(
          `User creation requires an active connection to the camp's sync host (write status: ${status})`
        )
      }
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`A user named "${name}" already exists in this camp`)
    }
    throw err
  }

  return { id, name, role }
}

export function verifyPin(db, userId, pin) {
  assertPinShape(pin)
  const row = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').get(userId)
  if (!row) return false
  // Verify at whatever cost this hash was PRODUCED at, not the current one —
  // a legacy hash carries no parameters and means Node's defaults.
  const parsed = parseStoredHash(row.pin_hash)
  if (!parsed) return false
  const candidateHex = parsed.params
    ? scryptSync(pin, row.pin_salt, SCRYPT_KEYLEN, parsed.params).toString('hex')
    : scryptSync(pin, row.pin_salt, SCRYPT_KEYLEN).toString('hex')
  const candidate = Buffer.from(candidateHex, 'hex')
  const stored = Buffer.from(parsed.hex, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

// --- Host Ed25519 signing key (docs/adr/2026-07-25-device-trust-revocation.md) ---
//
// Host-only, singleton, generated exactly once at bootstrapCamp() on the
// device that becomes Host. Encoding: hex-encoded DER (SPKI for the public
// key, PKCS8 for the private key) — chosen for round-trippability through
// Node's createPublicKey/createPrivateKey({format:'der', ...}) without any
// extra parsing; hex (not base64) purely for consistency with every other
// hex-encoded secret already in this file (signing_secret,
// device_secret_identifier).
export function ensureHostSigningKey(db) {
  const existing = db.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get()
  if (existing) {
    // Ensure camps.signing_public_key is populated even if this key was
    // created before the camps column sync was introduced.
    const camp = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()
    if (camp && !camp.signing_public_key) {
      db.prepare('UPDATE camps SET signing_public_key = ?').run(existing.public_key)
    }
    return existing
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const row = {
    public_key: publicKey.toString('hex'),
    private_key: privateKey.toString('hex'),
    created_at: new Date().toISOString(),
  }
  db.prepare(
    'INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)'
  ).run(row.public_key, row.private_key, row.created_at)
  // Mirror public key into camps.signing_public_key so verifySessionToken
  // (and Client devices, which only receive camps via full-sync) can verify
  // camp tokens without needing access to host_signing_key.
  db.prepare('UPDATE camps SET signing_public_key = ?').run(row.public_key)
  return row
}

// Whether THIS device is the Host — i.e. holds the private key locally.
// Never true on a Client, which only ever receives the public half via
// full-sync (camps.signing_public_key).
function getHostSigningKey(db) {
  return db.prepare('SELECT public_key, private_key FROM host_signing_key WHERE id = 1').get() || null
}

function campIdFor(db) {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  return camp ? camp.id : null
}

// --- Token issuance ---
//
// Split from the old single issueSessionToken per the ADR: minting a 'camp'
// token requires holding the Host's private key (this device IS the Host);
// minting a 'local' token only requires this device's own
// device_secret_identifier (set at pairing) and never grants network trust
// — see verifySessionToken's type dispatch and syncServer.js's
// handleAuthenticate, which rejects a 'local' token outright.
export function issueCampToken(db, userId, deviceId) {
  const hostKey = getHostSigningKey(db)
  if (!hostKey) {
    throw new Error('issueCampToken: this device has no host_signing_key row — it is not the Host')
  }

  const iat = Date.now()
  const payload = {
    type: 'camp',
    userId,
    deviceId,
    campId: campIdFor(db),
    iat,
    exp: iat + TOKEN_TTL_MS,
    jti: randomUUID(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(hostKey.private_key, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = edSign(null, Buffer.from(payloadB64), privateKeyObj).toString('base64url')
  return `${payloadB64}.${signature}`
}

// Stage 5d-2b fix round (Finding 2): a distinct DEVICE-LEVEL admission token
// — Host-signed exactly like issueCampToken, but carrying deviceId and no
// userId at all. Exists because the Host itself needs to authenticate
// OUTWARD (over libp2p, to a Client it dials) with no logged-in user in the
// picture — issueCampToken(db, null, deviceId) used to be called for this,
// but verifySessionToken's `typeof userId !== 'string'` check ALWAYS rejects
// a null userId, so that call produced a token that could never verify: the
// Host could mint it but no peer (including a re-check on the Host itself)
// could ever admit it. That failure was silent — the app kept running,
// nothing crashed, the Host's own authenticate attempts just always failed
// closed. See docs/adr/2026-09-06-libp2p-membership-mapping.md §6.
//
// Deliberately NOT reused for anything but connection ADMISSION
// (evaluateAuthenticate/authGate's `authenticate` message): authorize()
// explicitly denies `type: 'device'` (see authorize.js) because this token
// has no user and therefore no role to authorize — collapsing "may this peer
// connect" and "may this actor perform this action" into one token would
// undo the ADR's deliberate separation of those two layers.
export function issueDeviceToken(db, deviceId) {
  const hostKey = getHostSigningKey(db)
  if (!hostKey) {
    throw new Error('issueDeviceToken: this device has no host_signing_key row — it is not the Host')
  }

  const iat = Date.now()
  const payload = {
    type: 'device',
    deviceId,
    campId: campIdFor(db),
    iat,
    exp: iat + TOKEN_TTL_MS,
    jti: randomUUID(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(hostKey.private_key, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = edSign(null, Buffer.from(payloadB64), privateKeyObj).toString('base64url')
  return `${payloadB64}.${signature}`
}

export function issueLocalToken(db, userId, deviceId) {
  const device = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
  if (!device || !device.device_secret_identifier) {
    throw new Error('issueLocalToken: this device has no device_secret_identifier — pair it first')
  }

  const iat = Date.now()
  const payload = {
    type: 'local',
    userId,
    deviceId,
    campId: campIdFor(db),
    iat,
    exp: iat + TOKEN_TTL_MS,
    jti: randomUUID(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const secret = Buffer.from(device.device_secret_identifier, 'hex')
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  return `${payloadB64}.${signature}`
}

// Picks issueCampToken vs. issueLocalToken for the device attempting the
// login, per the design doc: "Host device (or Host process handling a
// remote WS login) -> issueCampToken; Client device doing its own local IPC
// login while offline -> issueLocalToken." Whether "this device is the
// Host" is re-derived from host_signing_key's presence, not passed in, so
// callers can't get it wrong.
function issueTokenForThisDevice(db, userId, deviceId) {
  if (getHostSigningKey(db)) return issueCampToken(db, userId, deviceId)
  return issueLocalToken(db, userId, deviceId)
}

// --- Token verification ---
//
// The `type` claim is parsed from the payload but NOT trusted to select
// behavior beyond "which verification method to attempt" until AFTER the
// signature check passes — a tampered/re-typed payload fails signature
// verification (wrong key material for its real origin), it never merely
// misroutes. Malformed/missing type, malformed structure, or a
// device_secret_identifier lookup miss all fail closed (return null),
// mirroring the "validate before touching properties" pattern already used
// for this function's `.` split. `exp` is enforced here — new behavior, see
// docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md.
export function verifySessionToken(db, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, signature] = parts
  if (!payloadB64 || !signature) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const { type, userId, deviceId, campId, exp, jti } = payload
  if (type !== 'camp' && type !== 'local' && type !== 'device') return null
  // A 'device' token deliberately carries no userId (issueDeviceToken) — see
  // that function's doc comment. 'camp' and 'local' both require one.
  if (type !== 'device' && (typeof userId !== 'string' || userId.length === 0)) return null
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null

  let providedSig
  try {
    providedSig = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }

  let sigOk = false
  if (type === 'camp' || type === 'device') {
    const camp = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()
    if (!camp || !camp.signing_public_key) return null
    try {
      const publicKeyObj = createPublicKey({
        key: Buffer.from(camp.signing_public_key, 'hex'),
        format: 'der',
        type: 'spki',
      })
      sigOk = edVerify(null, Buffer.from(payloadB64), publicKeyObj, providedSig)
    } catch {
      return null
    }
  } else {
    const device = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
    if (!device || !device.device_secret_identifier) return null
    try {
      const secret = Buffer.from(device.device_secret_identifier, 'hex')
      const expected = createHmac('sha256', secret).update(payloadB64).digest()
      sigOk = providedSig.length === expected.length && timingSafeEqual(providedSig, expected)
    } catch {
      return null
    }
  }

  if (!sigOk) return null
  if (Date.now() > exp) return null

  return {
    userId: type === 'device' ? null : userId,
    deviceId,
    campId: typeof campId === 'string' ? campId : null,
    type,
    jti: jti ?? null,
  }
}

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
/**
 * `now` is injected for ONE reason, and it is not convenience (T160 follow-up).
 *
 * The lockout is a wall-clock window, and verifying a PIN now costs a real
 * scrypt hash at T150's raised parameters. A test that drives five failed
 * attempts to prove the lockout works therefore spends several seconds of real
 * time doing so — and on a loaded machine it spent more than the 30-second
 * window, so the lockout expired before the test could observe it and the test
 * reported "the lockout does not work" when what happened was "this machine was
 * too slow". That is the worst kind of failing test: it blames the security
 * property for the harness's problem, and it trains people to re-run it.
 *
 * Production always passes the real clock. Nothing about the behaviour changes.
 */
export function attemptLogin(db, { name, pin, deviceId }, { now = () => Date.now() } = {}) {
  const attempt = attemptsRow(db, name)
  const lockedUntil = attempt && attempt.locked_until ? Number(attempt.locked_until) : 0
  if (lockedUntil && lockedUntil > now()) {
    recordAuditEvent(db, {
      actorUserId: null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: 'locked_out',
    })
    return { locked: true, retryAfterMs: lockedUntil - now() }
  }

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) {
    recordAuditEvent(db, {
      actorUserId: null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: 'no_camp',
    })
    return null
  }
  const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
  if (!user || !verifyPin(db, user.id, pin)) {
    let count = (attempt ? attempt.count : 0) + 1
    let newLockedUntil = null
    if (count >= LOGIN_MAX_ATTEMPTS) {
      newLockedUntil = now() + LOGIN_LOCKOUT_MS
      count = 0
    }
    saveAttempts(db, name, count, newLockedUntil)
    recordAuditEvent(db, {
      campId: camp.id,
      actorUserId: user ? user.id : null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: user ? 'invalid_pin' : 'user_not_found',
    })
    return null
  }

  clearAttempts(db, name)

  // Host device (or Host process handling a remote WS login) -> camp token;
  // Client device doing its own local/offline login -> local token. Which
  // one applies is re-derived from host_signing_key's presence on THIS
  // device, never passed in — see issueTokenForThisDevice.
  const token = issueTokenForThisDevice(db, user.id, deviceId)
  recordAuditEvent(db, {
    campId: camp.id,
    actorUserId: user.id,
    deviceId,
    action: 'auth.login',
    outcome: 'allow',
  })
  return { token, userId: user.id, role: user.role }
}
