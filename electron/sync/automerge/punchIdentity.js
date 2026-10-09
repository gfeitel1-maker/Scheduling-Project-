// T348 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md, Rung 1): this device's STABLE punch
// identity - the DTLS cert/key, ICE ufrag/pwd and pinned UDP port that make a remembered session
// redialable with zero signaling. Stored in the `punch_identity` singleton, in the same
// SQLCipher-covered database as device_identity_key (SECURITY.md "At-rest encryption"), so the key
// inherits the existing key custody and is never a standing file. node-datachannel only accepts PEM
// FILE paths, so materializePunchIdentity writes them to a 0700 temp dir for the life of one
// transport and removes them on cleanup().
//
// Never synced: same exclusion class as device_identity_key (schema.sql v93).
import { createHash, generateKeyPairSync, randomBytes, randomInt, sign, X509Certificate } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetPeerAddress, rememberPunchMemory } from './peerAddressBook.js'

const SRFLX_RE = /^candidate:\S+ \d+ UDP \d+ \S+ \d{1,5} typ srflx(?: |$)/i
const MAX_REFLEXIVE = 8

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  const len = body.length < 128 ? Buffer.from([body.length]) : body.length < 256 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, body])
}
const OID_ECDSA_SHA256 = Buffer.from('06082a8648ce3d040302', 'hex')
const OID_CN = Buffer.from('0603550403', 'hex')

// Minimal self-signed X.509 v3 (ECDSA P-256 / SHA-256, CN only). libdatachannel needs a PEM cert; it
// verifies nothing about it beyond the fingerprint the peer pins, so no extensions are required.
function selfSignedCert(privateKey, publicKey) {
  const name = der(0x30, der(0x31, der(0x30, OID_CN, der(0x0c, Buffer.from('shoresh-punch')))))
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    der(0x30, OID_ECDSA_SHA256),
    name,
    der(0x30, der(0x17, Buffer.from('260101000000Z')), der(0x18, Buffer.from('20991231235959Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const certDer = der(0x30, tbs, der(0x30, OID_ECDSA_SHA256), der(0x03, Buffer.from([0]), signature))
  return `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
}

const fingerprintOf = (certPem) =>
  createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex').toUpperCase().match(/../g).join(':')

function rowToIdentity(row) {
  return {
    certPem: row.cert_pem,
    keyPem: row.key_pem,
    fingerprint: row.fingerprint,
    iceUfrag: row.ice_ufrag,
    icePwd: row.ice_pwd,
    localPort: row.local_port,
    reflexiveCandidates: JSON.parse(row.reflexive_candidates),
    reflexiveLearnedAt: row.reflexive_learned_at,
  }
}

function freshCredentials() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const certPem = selfSignedCert(privateKey, publicKey)
  return {
    certPem,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fingerprint: fingerprintOf(certPem),
    iceUfrag: randomBytes(4).toString('hex'),
    icePwd: randomBytes(16).toString('hex'),
  }
}

export function ensurePunchIdentity(db) {
  const existing = db.prepare('SELECT * FROM punch_identity WHERE id = 1').get()
  if (existing) return rowToIdentity(existing)
  const c = freshCredentials()
  db.prepare(
    'INSERT INTO punch_identity (id, cert_pem, key_pem, fingerprint, ice_ufrag, ice_pwd, local_port, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
  ).run(c.certPem, c.keyPem, c.fingerprint, c.iceUfrag, c.icePwd, randomInt(49152, 65536), new Date().toISOString())
  return rowToIdentity(db.prepare('SELECT * FROM punch_identity WHERE id = 1').get())
}

// Replaces cert, key, fingerprint and ICE credentials (the pinned port is kept) and forgets our own
// learned reflexive addresses. Every peer's stored copy of our old description stops matching, so a
// revoked peer's remembered SDP can no longer reach us. A running transport keeps the identity it
// materialized until it next starts. Does nothing on a device that never minted an identity.
export function rotatePunchIdentity(db) {
  const c = freshCredentials()
  db.prepare(
    "UPDATE punch_identity SET cert_pem = ?, key_pem = ?, fingerprint = ?, ice_ufrag = ?, ice_pwd = ?, reflexive_candidates = '[]', reflexive_learned_at = NULL WHERE id = 1"
  ).run(c.certPem, c.keyPem, c.fingerprint, c.iceUfrag, c.icePwd)
}

// The single revocation hook: forget the peer's addresses and punch memory, then rotate our identity.
// The hook runs on every projection that still shows the peer revoked, so rotation is keyed on there
// having been something to forget: once per revocation, not once per pass.
export function forgetRevokedPeer(db, peerId) {
  if (forgetPeerAddress(db, peerId) > 0) rotatePunchIdentity(db)
}

const PENDING_ADMISSION_MAX_AGE_MS = 60_000
const PENDING_ADMISSION_MAX = 64

// Bridges the transport's onEstablished (fires after the Noise upgrade) and syncNode's onPeerAdmitted
// (fires after authGate admits the peer): a session is remembered only once BOTH have happened for
// the same peer, and only if the admission follows the upgrade closely.
export function createPunchPersistence(db, { now = Date.now } = {}) {
  const pending = new Map()
  return {
    onEstablished(snapshot) {
      pending.delete(snapshot.peerId)
      pending.set(snapshot.peerId, { snapshot, at: now() })
      if (pending.size > PENDING_ADMISSION_MAX) pending.delete(pending.keys().next().value)
    },
    onPeerAdmitted(peerId) {
      const entry = pending.get(peerId)
      pending.delete(peerId)
      if (!entry || now() - entry.at >= PENDING_ADMISSION_MAX_AGE_MS) return
      rememberPunchMemory(db, peerId, entry.snapshot)
      rememberOwnReflexive(db, entry.snapshot.localCandidates)
    },
  }
}

// Options for punchTransport(): the cert/key as short-lived 0600 files, plus the pinned ICE settings.
// cleanup() removes the files; call it when the transport stops.
// A crash or SIGKILL skips cleanup() and leaves key.pem behind. Directories are named for their owner's
// pid, so any real directory of exactly the mkdtemp shape whose process is gone is removed before a new one is made.
const STALE_DIR_RE = /^shoresh-punch-(\d+)-[A-Za-z0-9]{6}$/

export function sweepStalePunchDirs() {
  let names
  try { names = readdirSync(tmpdir()) } catch { return }
  for (const name of names) {
    const pid = Number(STALE_DIR_RE.exec(name)?.[1])
    if (!pid) continue
    const full = join(tmpdir(), name)
    try { if (!lstatSync(full).isDirectory()) continue } catch { continue }
    try { process.kill(pid, 0); continue } catch (err) { if (err.code === 'EPERM') continue }
    try { rmSync(full, { recursive: true, force: true }) } catch (err) {
      console.warn(`punch: could not remove a stale punch key directory (${err.code ?? 'error'}); it stays in the temp directory`)
    }
  }
}

export function materializePunchIdentity(db) {
  const id = ensurePunchIdentity(db)
  sweepStalePunchDirs()
  const dir = mkdtempSync(join(tmpdir(), `shoresh-punch-${process.pid}-`))
  const certificatePemFile = join(dir, 'cert.pem')
  const keyPemFile = join(dir, 'key.pem')
  writeFileSync(certificatePemFile, id.certPem, { mode: 0o600 })
  writeFileSync(keyPemFile, id.keyPem, { mode: 0o600 })
  return {
    certificatePemFile,
    keyPemFile,
    ice: { iceUfrag: id.iceUfrag, icePwd: id.icePwd },
    portRange: { begin: id.localPort, end: id.localPort },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// Records this device's own server-reflexive candidates as learned from an established ICE session.
// Only srflx lines are kept: host addresses are not public and relay candidates are never used.
export function rememberOwnReflexive(db, candidates, now = () => new Date().toISOString()) {
  const srflx = [...new Set(candidates.filter((c) => typeof c === 'string' && SRFLX_RE.test(c)))].slice(0, MAX_REFLEXIVE)
  if (srflx.length === 0) return
  db.prepare('UPDATE punch_identity SET reflexive_candidates = ?, reflexive_learned_at = ? WHERE id = 1').run(JSON.stringify(srflx), now())
}
