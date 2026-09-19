// T202 follow-up (ABI gap closer): run purgeCamperRecord end-to-end UNDER ELECTRON.
//
// WHY THIS EXISTS. purgeSupportCommand.js's key-preservation path is covered exhaustively by
// purgeSupportCommand.test.js — but that suite runs under Vitest, which loads better-sqlite3's NODE
// ABI. hostKeyPreservation.js's restorePreservableKeys() opens its OWN better-sqlite3 connection
// (via openLocalDb) to a database that rebuildProjectionFromDocumentAtPath just deleted+recreated in
// the same process, and the real app runs that under Electron's DIFFERENT native ABI (CLAUDE.md's
// native-module note). Nothing exercised the whole purge — three sequential connection opens and a
// delete+recreate cycle — under the Electron binary until this script. The logic is already proven;
// this only proves the native module loads on every connection open under the runtime that ships.
//
// It seeds a throwaway dev database (its own temp userData dir — it NEVER touches shoresh or
// shoresh-dev), plants a camper plus the three preservable artifacts (host_signing_key,
// device_identity_key, camps.signing_public_key), purges the camper, and asserts all three survive
// byte-identical. A native-module load error on the second/third connection open surfaces as a throw
// out of openLocalDb, which fails the run — the exact ABI failure this closes.
//
// Run it (ensures the Electron ABI build first, same as electron:dev):
//   npm run smoke:purge-abi
// or directly, if the Electron better-sqlite3 build is already current:
//   electron electron/automerge/purgeAbiSmoke.js
//
// It is deliberately NOT part of `npm run verify`: verify runs under Node (Vitest ABI) with no
// Electron/display, so it cannot host this. This is an on-demand runtime smoke check, run on a
// machine with Electron, exactly like the app.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import { seedAllFromSqlite } from './seed.js'
import { saveDoc } from '../sync/automerge/docStore.js'
import { purgeCamperRecord } from './purgeSupportCommand.js'

// Byte-identical fixed values so "byte-identical survival" is a literal equality, not a re-derivation.
const HOST_PUB = 'a'.repeat(64)
const HOST_PRIV = 'b'.repeat(64)
const DEV_PEER_ID = '12D3KooWFakePeerIdForAbiSmoke'
const DEV_PRIV = 'c'.repeat(72)

// The whole smoke run, as a pure-ish function over a scratch directory so the Electron entry glue at
// the bottom stays thin. Returns a summary; throws on any assertion failure or native load error.
export function runPurgeAbiSmoke(scratchDir) {
  const dbPath = path.join(scratchDir, 'smoke.sqlite')
  const userDataDir = path.join(scratchDir, 'userData')
  fs.mkdirSync(userDataDir, { recursive: true })

  const campId = randomUUID()
  const camperId = randomUUID()
  const deviceId = 'device-abi-smoke'
  const hostCreated = new Date().toISOString()
  const devCreated = new Date().toISOString()

  // ---- seed: a camp with one camper + the three preservable artifacts ----
  // First connection open under the Electron ABI. If the native module were the wrong ABI, this
  // throws here and the run fails before any purge — which is itself a valid negative result.
  const db = openLocalDb(dbPath)
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'ABI Smoke Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device One')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)

  appendOp(db, { entity: 'campers', entity_id: camperId, field: 'camp_id', value: campId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'campers', entity_id: camperId, field: 'display_name', value: 'Sara K', device_id: deviceId, author_user_id: 'u1' })

  db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(HOST_PUB, HOST_PRIV, hostCreated)
  db.prepare('UPDATE camps SET signing_public_key = ?').run(HOST_PUB)
  db.prepare('INSERT INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(DEV_PEER_ID, DEV_PRIV, devCreated)

  const doc = seedAllFromSqlite(db)
  saveDoc(userDataDir, campId, doc)
  db.close()

  // ---- the actual thing under test: purge end-to-end under Electron ----
  // Internally opens oldDb, then rebuildProjectionFromDocumentAtPath deletes+recreates the file and
  // opens it, then restorePreservableKeys opens it a THIRD time — the exact second-connection-open
  // path the ABI gap was about. Any ABI mismatch surfaces as a throw out of openLocalDb here.
  const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

  const failures = []
  const eq = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }

  eq('result.campId', result.campId, campId)
  eq('keysRestored.hostSigningKey', result.keysRestored?.hostSigningKey, true)
  eq('keysRestored.deviceIdentityKey', result.keysRestored?.deviceIdentityKey, true)
  eq('keysRestored.campsSigningPublicKey', result.keysRestored?.campsSigningPublicKey, true)

  // ---- verify: re-open (a FOURTH connection under Electron) and check byte-identical survival ----
  const verifyDb = openLocalDb(dbPath)
  const host = verifyDb.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get()
  const dev = verifyDb.prepare('SELECT peer_id, private_key, created_at FROM device_identity_key WHERE id = 1').get()
  const campsPub = verifyDb.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()?.signing_public_key
  const camperGone = verifyDb.prepare('SELECT 1 FROM campers WHERE id = ?').get(camperId) === undefined
  verifyDb.close()

  eq('host_signing_key.public_key', host?.public_key, HOST_PUB)
  eq('host_signing_key.private_key', host?.private_key, HOST_PRIV)
  eq('host_signing_key.created_at', host?.created_at, hostCreated)
  eq('device_identity_key.peer_id', dev?.peer_id, DEV_PEER_ID)
  eq('device_identity_key.private_key', dev?.private_key, DEV_PRIV)
  eq('device_identity_key.created_at', dev?.created_at, devCreated)
  eq('camps.signing_public_key', campsPub, HOST_PUB)
  eq('camper purged', camperGone, true)

  if (failures.length > 0) {
    throw new Error('purge ABI smoke FAILED:\n  - ' + failures.join('\n  - '))
  }
  return { campId, camperId, keysRestored: result.keysRestored }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('electron/automerge/purgeAbiSmoke.js')
if (invokedDirectly) {
  // Under Electron, wait for app-ready then run in a temp dir and exit with the result. better-sqlite3
  // loads at require time regardless of app state, but going through app.exit keeps the (windowless)
  // Electron process from lingering.
  const { app } = await import('electron')
  app.whenReady().then(() => {
    let scratchDir
    try {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-purge-abi-smoke-'))
      const summary = runPurgeAbiSmoke(scratchDir)
      process.stdout.write(
        `✅ purge ABI smoke PASSED under Electron — better-sqlite3 loaded on every connection open; ` +
          `all three keys survived byte-identical (camp ${summary.campId}).\n`
      )
      app.exit(0)
    } catch (err) {
      process.stderr.write(`❌ ${err?.stack ?? err?.message ?? err}\n`)
      app.exit(1)
    } finally {
      if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true })
    }
  })
}
