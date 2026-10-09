// Shared fixture for the host-handoff tests: two real databases for one camp, H (holds the host
// key, mints it for real) and S (an admin device, no key), each knowing the other as an
// authorized admin device with a bound libp2p identity, plus host-only rows on H and a different
// set on S so a replace is distinguishable from a merge.
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from '../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../db/localDb.js'
import { ensureDeviceIdentity } from './deviceIdentity.js'
import { ensureHostSigningKey } from './localAuth.js'
import { HANDOFF_TABLES } from './hostHandoff.js'

const NOW = '2026-10-09T12:00:00.000Z'

function seedHostOnlyRows(db, campId, tag) {
  db.prepare('INSERT INTO source_aliases (id, camp_id, entity_type, source_label, entity_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`alias-${tag}`, campId, 'activities', `Label ${tag}`, `e-${tag}`, NOW)
  db.prepare('INSERT INTO compound_cell_decisions (id, camp_id, pattern, interpretation, confirmed_at) VALUES (?, ?, ?, ?, ?)')
    .run(`ccd-${tag}`, campId, `Lunch + ${tag}`, 'as_written', NOW)
  db.prepare('INSERT INTO location_word_decisions (id, camp_id, word_key, raw_word, decision, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`lwd-${tag}`, campId, `word-${tag}`, `Word ${tag}`, 'not_a_place', NOW)
  db.prepare('INSERT INTO declined_two_row_splits (id, camp_id, activity_name_normalized, declined_at) VALUES (?, ?, ?, ?)')
    .run(`dts-${tag}`, campId, `act-${tag}`, NOW)
  db.prepare('INSERT INTO import_decisions (id, camp_id, import_id, kind, outcome, decided_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`imd-${tag}`, campId, 'imp-1', 'confirm_value', 'accepted', NOW)
  db.prepare('INSERT INTO import_evidence (id, camp_id, entity_type, entity_id, field, tag, confidence, support, import_run_id, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`ive-${tag}`, campId, 'activities', `e-${tag}`, 'days', 'observed', 'high', '{}', 'run-1', NOW)
  db.prepare('INSERT INTO open_reconciliation_decisions (id, camp_id, entity_type, identity_key, kind, domain_key, child_key, import_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`ord-${tag}`, campId, 'activities', `idk-${tag}`, 'confirm_value', 'dk', 'ck', 'run-1', NOW)
}

export function hostOnlyRowCounts(db) {
  return Object.fromEntries(HANDOFF_TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]))
}

export function hostOnlyRowIds(db) {
  return HANDOFF_TABLES.flatMap((t) => db.prepare(`SELECT id FROM ${t} ORDER BY id`).all().map((r) => r.id))
}

export async function makeHandoffPair() {
  const campId = `camp-${randomUUID()}`
  const H = openTemplatedDb().db
  const S = openTemplatedDb().db
  const hId = getOrCreateDeviceId(H)
  const sId = getOrCreateDeviceId(S)
  const hIdentity = await ensureDeviceIdentity(H)
  const sIdentity = await ensureDeviceIdentity(S)
  H.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  const key = ensureHostSigningKey(H)
  S.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run(campId, 'Test Camp', key.public_key)

  for (const [db, selfId, selfPeer, otherId, otherPeer] of [
    [H, hId, hIdentity.peerId, sId, sIdentity.peerId],
    [S, sId, sIdentity.peerId, hId, hIdentity.peerId],
  ]) {
    for (const [id, peer, name] of [[selfId, selfPeer, 'self'], [otherId, otherPeer, 'other']]) {
      db.prepare(
        "INSERT OR REPLACE INTO devices (id, name, authorized_at, pairing_status, libp2p_peer_id) VALUES (?, ?, ?, 'authorized', ?)"
      ).run(id, `${name}-${id.slice(0, 4)}`, NOW, peer)
      db.prepare("INSERT OR REPLACE INTO authority_cache (device_id, status, updated_at) VALUES (?, 'admin', ?)").run(id, NOW)
    }
  }

  seedHostOnlyRows(H, campId, 'h')
  seedHostOnlyRows(S, campId, 's')
  return {
    campId,
    key,
    H: { db: H, deviceId: hId, identity: hIdentity },
    S: { db: S, deviceId: sId, identity: sIdentity },
  }
}
