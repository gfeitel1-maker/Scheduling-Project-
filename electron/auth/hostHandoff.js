// The planned host handoff state machine (docs/adr/2026-10-09-host-succession-simple.md).
//
// DB-only and transport-agnostic: `handle(msg, { peerDeviceId })` takes one message from an
// authenticated peer and returns `{ ok: true, reply, relaunch? }` or `{ ok: false, reason }`. The
// wire (electron/sync/automerge/hostHandoffWire.js) carries messages; nothing here knows about it.
//
// Safety property: at most one live host_signing_key exists at any instant. The giver (H) deletes
// its key in the same transaction that records `committed` (step 5); the taker (S) only moves its
// PENDING key live on a COMMIT from H (step 6). Once S has stored the key it never discards it on
// its own: only H answering NOT_COMMITTED to a STATUS lets it go, and H answering NOT_COMMITTED also
// clears its own row, so H can never commit that handoff afterwards.
//
// Error shape is `{ ok: false, reason }`. Every message is idempotent on `handoff_id`. A denied or
// malformed message writes nothing but an audit event.
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { isHostDevice } from './localAuth.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { generateEphemeral, buildAad, signEphemeral, verifyEphemeral, seal, open } from './hostHandoffSeal.js'

// The tables marked host-only in schema.sql: never synced, so they travel with hosting. Guarded by
// hostHandoff.hostOnlyTables.guard.test.js — a new host-only table that is not listed here fails it.
export const HANDOFF_TABLES = [
  'source_aliases',
  'compound_cell_decisions',
  'location_word_decisions',
  'declined_two_row_splits',
  'import_decisions',
  'import_evidence',
  'open_reconciliation_decisions',
]

export const OFFER_TTL_MS = 5 * 60 * 1000
export const IN_FLIGHT_TTL_MS = 60 * 1000

const GIVER_PRE_DECISION = new Set(['offered', 'sent'])

export function isAdminDevice(db, deviceId) {
  if (db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status !== 'admin') return false
  const device = db.prepare('SELECT authorized_at, revoked_at FROM devices WHERE id = ?').get(deviceId)
  return Boolean(device?.authorized_at && !device.revoked_at)
}

export function createHostHandoff({ db, deviceId, getDeviceIdentity, now = Date.now, relaunch = () => {} }) {
  // Ephemeral X25519 private keys live in memory only: a restart in `accepted` discards the handoff.
  const ephemerals = new Map()
  let lastResult = null

  const iso = () => new Date(now()).toISOString()
  const campRow = () => db.prepare('SELECT id, signing_public_key FROM camps LIMIT 1').get()
  const getRow = () => db.prepare('SELECT * FROM host_handoff WHERE id = 1').get()
  const setRow = (handoffId, role, peerDeviceId, state) =>
    db.prepare(
      'INSERT OR REPLACE INTO host_handoff (id, handoff_id, role, peer_device_id, state, updated_at) VALUES (1, ?, ?, ?, ?, ?)'
    ).run(handoffId, role, peerDeviceId, state, iso())
  const setState = (state) => db.prepare('UPDATE host_handoff SET state = ?, updated_at = ? WHERE id = 1').run(state, iso())
  const clearRow = () => db.prepare('DELETE FROM host_handoff WHERE id = 1').run()

  function deny(reason, peerDeviceId, handoffId) {
    try {
      recordAuditEvent(db, {
        action: 'host.handoff', outcome: 'deny', reason, deviceId: peerDeviceId ?? null,
        targetType: 'host_handoff', targetId: handoffId ?? null,
      })
    } catch { /* an audit failure must not turn a refusal into a crash */ }
    return { ok: false, reason }
  }

  function allow(action, peerDeviceId, handoffId) {
    try {
      recordAuditEvent(db, { action, outcome: 'allow', deviceId: peerDeviceId, targetType: 'host_handoff', targetId: handoffId })
    } catch { /* best effort */ }
  }

  function fail(row, reason) {
    lastResult = { ok: false, reason, peerDeviceId: row.peer_device_id, handoffId: row.handoff_id, at: iso() }
  }

  function expireStale() {
    const row = getRow()
    if (!row) return
    const age = now() - Date.parse(row.updated_at)
    if (row.role === 'giver') {
      const ttl = row.state === 'offered' ? OFFER_TTL_MS : IN_FLIGHT_TTL_MS
      if (GIVER_PRE_DECISION.has(row.state) && age > ttl) {
        fail(row, 'timed_out')
        clearRow()
      }
    } else if (row.state === 'offered' && age > 2 * OFFER_TTL_MS) {
      clearRow()
    } else if (row.state === 'accepted' && age > IN_FLIGHT_TTL_MS) {
      ephemerals.delete(row.handoff_id)
      clearRow()
    }
  }

  function readTables(campId) {
    const tables = {}
    for (const t of HANDOFF_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t} WHERE camp_id = ?`).all(campId)
    return tables
  }

  function replaceTables(campId, tables) {
    for (const t of HANDOFF_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE camp_id = ?`).run(campId)
      for (const r of tables[t]) {
        const cols = Object.keys(r)
        db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => r[c]))
      }
    }
  }

  function validateTables(campId, tables, counts) {
    if (!tables || typeof tables !== 'object' || !counts || typeof counts !== 'object') return 'malformed_payload'
    for (const t of HANDOFF_TABLES) {
      const rows = tables[t]
      if (!Array.isArray(rows)) return 'malformed_payload'
      if (counts[t] !== rows.length) return 'row_count_mismatch'
      const columns = new Set(db.pragma(`table_info(${t})`).map((c) => c.name))
      for (const r of rows) {
        if (!r || typeof r !== 'object' || r.camp_id !== campId) return 'malformed_payload'
        if (!Object.keys(r).every((c) => columns.has(c))) return 'malformed_payload'
      }
    }
    return null
  }

  function peerChecks(row, msg, peerDeviceId, role) {
    if (!isAdminDevice(db, peerDeviceId)) return deny('peer_not_admin', peerDeviceId, msg.handoff_id)
    if (!row || row.role !== role || row.handoff_id !== msg.handoff_id) return deny('stale_handoff', peerDeviceId, msg.handoff_id)
    if (row.peer_device_id !== peerDeviceId) return deny('wrong_peer', peerDeviceId, msg.handoff_id)
    return null
  }

  // --- giver side -------------------------------------------------------------------------

  function offer(peerDeviceId) {
    expireStale()
    if (!isHostDevice(db)) return { ok: false, reason: 'not_host' }
    if (peerDeviceId === deviceId || !isAdminDevice(db, peerDeviceId)) return { ok: false, reason: 'peer_not_admin' }
    if (getRow()) return { ok: false, reason: 'handoff_in_progress' }
    const handoffId = randomUUID()
    setRow(handoffId, 'giver', peerDeviceId, 'offered')
    lastResult = null
    return { ok: true, msg: { type: 'OFFER', handoff_id: handoffId, camp_id: campRow().id } }
  }

  function noteFailure(peerDeviceId, reason) {
    lastResult = { ok: false, reason, peerDeviceId, handoffId: null, at: iso() }
  }

  function abandon(handoffId, reason) {
    const row = getRow()
    if (!row || row.handoff_id !== handoffId) return
    if (row.role === 'giver' && GIVER_PRE_DECISION.has(row.state)) {
      fail(row, reason)
      clearRow()
    } else if (row.role === 'taker' && (row.state === 'offered' || row.state === 'accepted')) {
      ephemerals.delete(handoffId)
      clearRow()
    }
  }

  async function onAccept(msg, peerDeviceId) {
    const row = getRow()
    const bad = peerChecks(row, msg, peerDeviceId, 'giver')
    if (bad) return bad
    if (row.state !== 'offered' && row.state !== 'sent') return deny('bad_state', peerDeviceId, msg.handoff_id)
    if (!isHostDevice(db)) return deny('not_host', peerDeviceId, msg.handoff_id)
    if (typeof msg.ephemeral_public !== 'string' || typeof msg.signature !== 'string') return deny('malformed', peerDeviceId, msg.handoff_id)

    const camp = campRow()
    const takerPeerId = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(peerDeviceId)?.libp2p_peer_id
    const ids = { handoffId: msg.handoff_id, campId: camp.id, giverDeviceId: deviceId, takerDeviceId: peerDeviceId }
    if (!takerPeerId || !(await verifyEphemeral(takerPeerId, { ...ids, ephemeralPublic: msg.ephemeral_public }, msg.signature))) {
      return deny('bad_signature', peerDeviceId, msg.handoff_id)
    }

    const key = db.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get()
    const tables = readTables(camp.id)
    const counts = Object.fromEntries(HANDOFF_TABLES.map((t) => [t, tables[t].length]))
    const sealed = seal({
      takerEphemeralPublic: msg.ephemeral_public,
      plaintext: Buffer.from(JSON.stringify({ public_key: key.public_key, private_key: key.private_key, created_at: key.created_at, tables, counts })),
      aad: buildAad(ids),
    })
    setState('sent')
    return { ok: true, reply: { type: 'KEY', handoff_id: msg.handoff_id, sealed } }
  }

  // Step 5, the decision point: one transaction deletes the live key and the host-only rows and
  // records `committed`.
  function onStored(msg, peerDeviceId) {
    const row = getRow()
    const bad = peerChecks(row, msg, peerDeviceId, 'giver')
    if (bad) return bad
    if (row.state === 'committed') return { ok: true, reply: { type: 'COMMIT', handoff_id: msg.handoff_id }, relaunch: true }
    if (row.state !== 'sent') return deny('bad_state', peerDeviceId, msg.handoff_id)
    if (!isHostDevice(db)) return deny('not_host', peerDeviceId, msg.handoff_id)
    const camp = campRow()
    db.transaction(() => {
      db.prepare('DELETE FROM host_signing_key').run()
      for (const t of HANDOFF_TABLES) db.prepare(`DELETE FROM ${t} WHERE camp_id = ?`).run(camp.id)
      setState('committed')
    })()
    allow('host.handoff.committed', peerDeviceId, msg.handoff_id)
    return { ok: true, reply: { type: 'COMMIT', handoff_id: msg.handoff_id }, relaunch: true }
  }

  function onStatus(msg, peerDeviceId) {
    expireStale()
    const row = getRow()
    if (!isAdminDevice(db, peerDeviceId)) return deny('peer_not_admin', peerDeviceId, msg.handoff_id)
    const mine = row && row.role === 'giver' && row.handoff_id === msg.handoff_id && row.peer_device_id === peerDeviceId
    if (mine && row.state === 'committed') return { ok: true, reply: { type: 'COMMIT', handoff_id: msg.handoff_id } }
    // Answering NOT_COMMITTED is final: drop the row so a STORED delayed in the network cannot make
    // this device commit a handoff its peer has already been told did not happen.
    if (mine && GIVER_PRE_DECISION.has(row.state)) {
      fail(row, 'peer_reconnected')
      clearRow()
    }
    return { ok: true, reply: { type: 'NOT_COMMITTED', handoff_id: msg.handoff_id } }
  }

  function onDone(msg, peerDeviceId) {
    const row = getRow()
    if (row && row.role === 'giver' && row.handoff_id === msg.handoff_id && row.peer_device_id === peerDeviceId && row.state === 'committed') {
      clearRow()
    }
    return { ok: true, reply: { type: 'ACK', handoff_id: msg.handoff_id } }
  }

  // --- taker side -------------------------------------------------------------------------

  function onOffer(msg, peerDeviceId) {
    expireStale()
    if (!isAdminDevice(db, peerDeviceId)) return deny('peer_not_admin', peerDeviceId, msg.handoff_id)
    if (typeof msg.handoff_id !== 'string' || msg.handoff_id.length === 0) return deny('malformed', peerDeviceId, msg.handoff_id)
    if (isHostDevice(db)) return deny('already_host', peerDeviceId, msg.handoff_id)
    if (msg.camp_id !== campRow()?.id) return deny('wrong_camp', peerDeviceId, msg.handoff_id)
    const row = getRow()
    if (row && row.handoff_id === msg.handoff_id) return { ok: true, reply: { type: 'ACK', handoff_id: msg.handoff_id } }
    if (row && row.state !== 'done' && row.state !== 'offered' && row.state !== 'accepted') return deny('handoff_in_progress', peerDeviceId, msg.handoff_id)
    setRow(msg.handoff_id, 'taker', peerDeviceId, 'offered')
    return { ok: true, reply: { type: 'ACK', handoff_id: msg.handoff_id } }
  }

  async function accept() {
    expireStale()
    const row = getRow()
    if (!row || row.role !== 'taker' || row.state !== 'offered') return { ok: false, reason: 'no_offer' }
    if (!isAdminDevice(db, row.peer_device_id)) return { ok: false, reason: 'peer_not_admin' }
    const eph = generateEphemeral()
    const ids = { handoffId: row.handoff_id, campId: campRow().id, giverDeviceId: row.peer_device_id, takerDeviceId: deviceId }
    const identity = await getDeviceIdentity()
    const signature = await signEphemeral(identity.privateKey, { ...ids, ephemeralPublic: eph.publicKey })
    ephemerals.set(row.handoff_id, eph)
    setState('accepted')
    return { ok: true, msg: { type: 'ACCEPT', handoff_id: row.handoff_id, ephemeral_public: eph.publicKey, signature } }
  }

  function decline() {
    const row = getRow()
    if (row?.role === 'taker' && (row.state === 'offered' || row.state === 'accepted')) {
      ephemerals.delete(row.handoff_id)
      clearRow()
    }
  }

  function rejectKey(row, reason, peerDeviceId) {
    ephemerals.delete(row.handoff_id)
    clearRow()
    return deny(reason, peerDeviceId, row.handoff_id)
  }

  // Step 4: stage the key and the host-only rows as PENDING. Nothing live changes.
  function onKey(msg, peerDeviceId) {
    const row = getRow()
    const bad = peerChecks(row, msg, peerDeviceId, 'taker')
    if (bad) return bad
    if (row.state === 'stored') return { ok: true, reply: { type: 'STORED', handoff_id: msg.handoff_id } }
    if (row.state !== 'accepted') return deny('bad_state', peerDeviceId, msg.handoff_id)
    const eph = ephemerals.get(msg.handoff_id)
    if (!eph || !msg.sealed || typeof msg.sealed !== 'object') return rejectKey(row, 'no_ephemeral', peerDeviceId)

    const camp = campRow()
    let payload
    try {
      const aad = buildAad({ handoffId: msg.handoff_id, campId: camp.id, giverDeviceId: peerDeviceId, takerDeviceId: deviceId })
      payload = JSON.parse(open({ takerEphemeralPrivate: eph.privateKey, sealed: msg.sealed, aad }).toString())
    } catch {
      return rejectKey(row, 'bad_ciphertext', peerDeviceId)
    }

    if (!camp.signing_public_key || payload.public_key !== camp.signing_public_key) return rejectKey(row, 'wrong_camp_key', peerDeviceId)
    try {
      const derived = createPublicKey(createPrivateKey({ key: Buffer.from(payload.private_key, 'hex'), format: 'der', type: 'pkcs8' }))
        .export({ format: 'der', type: 'spki' }).toString('hex')
      if (derived !== camp.signing_public_key) return rejectKey(row, 'wrong_camp_key', peerDeviceId)
    } catch {
      return rejectKey(row, 'wrong_camp_key', peerDeviceId)
    }
    const invalid = validateTables(camp.id, payload.tables, payload.counts)
    if (invalid) return rejectKey(row, invalid, peerDeviceId)

    db.transaction(() => {
      db.prepare(
        'INSERT OR REPLACE INTO host_signing_key_pending (id, handoff_id, public_key, private_key, host_only_rows, created_at) VALUES (1, ?, ?, ?, ?, ?)'
      ).run(msg.handoff_id, payload.public_key, payload.private_key, JSON.stringify(payload.tables), typeof payload.created_at === 'string' ? payload.created_at : iso())
      setState('stored')
    })()
    ephemerals.delete(msg.handoff_id)
    return { ok: true, reply: { type: 'STORED', handoff_id: msg.handoff_id } }
  }

  // Step 6: only on COMMIT from H. One transaction moves the pending key and rows live.
  function onCommit(msg, peerDeviceId) {
    const row = getRow()
    const bad = peerChecks(row, msg, peerDeviceId, 'taker')
    if (bad) return bad
    if (row.state === 'done') return { ok: true, reply: { type: 'DONE', handoff_id: msg.handoff_id } }
    if (row.state !== 'stored') return deny('no_pending_key', peerDeviceId, msg.handoff_id)
    const pending = db.prepare('SELECT * FROM host_signing_key_pending WHERE id = 1 AND handoff_id = ?').get(msg.handoff_id)
    if (!pending) return deny('no_pending_key', peerDeviceId, msg.handoff_id)
    const camp = campRow()
    if (db.prepare('SELECT 1 FROM host_signing_key').get() || pending.public_key !== camp.signing_public_key) {
      return deny('two_keys', peerDeviceId, msg.handoff_id)
    }
    db.transaction(() => {
      db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
        .run(pending.public_key, pending.private_key, pending.created_at)
      replaceTables(camp.id, JSON.parse(pending.host_only_rows))
      db.prepare('DELETE FROM host_signing_key_pending').run()
      setState('done')
    })()
    allow('host.handoff.activated', peerDeviceId, msg.handoff_id)
    return { ok: true, reply: { type: 'DONE', handoff_id: msg.handoff_id }, relaunch: true }
  }

  function onNotCommitted(msg, peerDeviceId) {
    const row = getRow()
    const bad = peerChecks(row, msg, peerDeviceId, 'taker')
    if (bad) return bad
    if (row.state === 'stored' || row.state === 'accepted' || row.state === 'offered') {
      db.transaction(() => {
        db.prepare('DELETE FROM host_signing_key_pending').run()
        clearRow()
      })()
      ephemerals.delete(msg.handoff_id)
    }
    return { ok: true, reply: { type: 'ACK', handoff_id: msg.handoff_id } }
  }

  // --- dispatch ---------------------------------------------------------------------------

  async function handle(msg, { peerDeviceId } = {}) {
    if (!msg || typeof msg.type !== 'string' || typeof peerDeviceId !== 'string') return deny('malformed', peerDeviceId)
    switch (msg.type) {
      case 'OFFER': return onOffer(msg, peerDeviceId)
      case 'ACCEPT': return onAccept(msg, peerDeviceId)
      case 'KEY': return onKey(msg, peerDeviceId)
      case 'STORED': return onStored(msg, peerDeviceId)
      case 'COMMIT': return onCommit(msg, peerDeviceId)
      case 'DONE': return onDone(msg, peerDeviceId)
      case 'STATUS': return onStatus(msg, peerDeviceId)
      case 'NOT_COMMITTED': return onNotCommitted(msg, peerDeviceId)
      case 'ACK': return { ok: true }
      case 'ERROR':
        abandon(msg.handoff_id, msg.reason ?? 'peer_refused')
        return { ok: true }
      default: return deny('unsupported_message', peerDeviceId, msg.handoff_id)
    }
  }

  // What this device should say when `peerDeviceId` becomes reachable: the taker in `stored` asks
  // STATUS; the giver in `committed` re-sends COMMIT.
  function contactMessage(peerDeviceId) {
    const row = getRow()
    if (!row || row.peer_device_id !== peerDeviceId) return null
    if (row.role === 'taker' && row.state === 'stored') return { type: 'STATUS', handoff_id: row.handoff_id }
    if (row.role === 'giver' && row.state === 'committed') return { type: 'COMMIT', handoff_id: row.handoff_id }
    return null
  }

  function recoverOnStartup() {
    const row = getRow()
    if (!row) return
    if (row.role === 'giver' && GIVER_PRE_DECISION.has(row.state)) clearRow()
    else if (row.role === 'taker' && (row.state === 'offered' || row.state === 'accepted')) clearRow()
  }

  function afterReplyFlushed(result) {
    if (result?.relaunch) relaunch()
  }

  function status() {
    expireStale()
    const row = getRow()
    return {
      handoff: row ? { handoffId: row.handoff_id, role: row.role, peerDeviceId: row.peer_device_id, state: row.state } : null,
      lastResult,
    }
  }

  return {
    offer, accept, decline, abandon, noteFailure, handle, contactMessage, recoverOnStartup, afterReplyFlushed, status,
    ephemeralForTest: (handoffId) => ephemerals.get(handoffId),
  }
}
