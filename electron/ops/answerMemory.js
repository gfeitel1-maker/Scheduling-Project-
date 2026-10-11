// Import answer memory, the store, recall and writers
// (docs/adr/2026-10-11-import-answer-memory.md).
//
// Every answer a director gives to an import question is one record in `camp_seedlings`, replicated
// through the camp document like any other camp fact. Nothing in the document is trusted until it
// is validated at READ, so `liveRecords()` below is the ONLY reader of these kinds: recall, patterns,
// explanations and the view all go through it, and a guard test fails if another file names them.
import { createHash, randomUUID } from 'node:crypto'
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
import { deriveCampSeedlingId } from './electiveDerivedIds.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { normalizeName } from '../../src/ingest/preview.js'
import {
  signatureOf, signatureOfOther, isAutoApplyEligible, toRecordAnswer, toUiAnswer, roleFor, validateAnswer, isExplicit, QKINDS, VERDICTS, ANSWER_V,
} from '../../src/ingest/answerMemory.js'
import {
  recallPattern, patternGroups, evaluateGroup, progressForDecision, patternKeysFor, answerLabel,
} from '../../src/ingest/answerPatterns.js'

export const ANSWER_KIND = 'import_answer'
export const VETO_KIND = 'import_rule_veto'
// The two kinds a generic entity read must never return: liveRecords is their only reader.
export const ANSWER_RECORD_KINDS = Object.freeze([ANSWER_KIND, VETO_KIND])
export const RECORD_CAP = 5000
export const MAX_PAYLOAD_BYTES = 4096
const MAX_SEQ = 2 ** 31 - 1
const RETENTION_DAYS = 180
const RETENTION_KEEP = 2
const SEEDLING_FIELDS = ['camp_id', 'kind', 'match_key', 'payload', 'status', 'confirmed_by', 'confirmed_at']

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

// A part over 64 characters is replaced by its full SHA-256, never truncated. Idempotent: a value
// that is already such a hash is returned as is, so the writer's output and a recall-time
// recomputation always meet at the same string.
const FITTED = /^h:[0-9a-f]{64}$/
const fitPart = (p) => {
  const t = String(p)
  return t.length > 64 && !FITTED.test(t) ? `h:${sha256(t)}` : t
}

// What the reader's limits (128 per feature, 600 per baseline value) would reject is shortened the
// same way on BOTH sides, the write and the recall, so equality still holds.
const fitValues = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'string' ? fitPart(v) : v]))
const fitSignature = (sig) => ({ ...sig, baseline: fitValues(sig.baseline), features: fitValues(sig.features) })
// A veto names the answers it covers by this digest of their id (a derived seedling id is ~170
// characters; a digest lets one record cover ~200 of them inside the 4 KiB payload).
const coverDigest = (id) => sha256(String(id)).slice(0, 12)
const COVERS_PER_VETO = 200
const WRITE_BYTES = 4000

export function canonicalKey(sig) {
  const parts = sig.parts.map(fitPart)
  return { parts, keyHash: sha256(JSON.stringify([sig.qkind, parts])) }
}

// ---------------------------------------------------------------- validation at read

const ALLOWED_KEYS = new Set([
  'v', 'qkind', 'role', 'seq', 'import_id', 'parts', 'baseline', 'refs', 'camp_shape', 'features',
  'answer', 'supersedes', 'overrode', 'covers', 'bulk',
])
const MATCH_KEY = /^([0-9a-f]{64})-([0-9a-f-]{36})$/
const TEMPLATES = new Set(['T1', 'T2', 'T3'])
// A Forget of an answer is an append-only marker record (a veto-kind record whose parts[0] is this),
// authored like any record, so two people forgetting one answer write two records and never conflict.
const RETIRE = 'RETIRE'

const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)
const isStr = (s, max) => typeof s === 'string' && s.length <= max
// A derived seedling id is ~170 characters (length-prefixed camp id, kind and a 101-character match_key).
const isIdList = (a, max = 64) => Array.isArray(a) && a.length <= max && a.every((x) => isStr(x, 256))
const isScalarMap = (o, maxKeys, maxLen) => isPlainObject(o)
  && Object.keys(o).length <= maxKeys
  && Object.values(o).every((v) => v === null || typeof v === 'boolean' || typeof v === 'number' || isStr(v, maxLen))

// Returns the parsed payload, or null when the record must be discarded whole.
function parsePayload(row) {
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > MAX_PAYLOAD_BYTES) return null
  let p
  try { p = JSON.parse(row.payload) } catch { return null }
  if (!isPlainObject(p)) return null
  for (const k of Object.keys(p)) if (!ALLOWED_KEYS.has(k)) return null
  if (p.v !== ANSWER_V) return null
  if (!QKINDS.includes(p.qkind)) return null
  if (p.role !== 'instance' && p.role !== 'evidence') return null
  if (!Number.isInteger(p.seq) || p.seq < 1 || p.seq > MAX_SEQ) return null
  if (p.import_id != null && !isStr(p.import_id, 64)) return null
  if (!Array.isArray(p.parts) || p.parts.length < 1 || p.parts.length > 16 || !p.parts.every((x) => isStr(x, 128))) return null
  if (p.baseline != null && !isScalarMap(p.baseline, 12, 600)) return null
  if (p.refs != null && !isIdList(p.refs)) return null
  if (p.camp_shape != null && !isScalarMap(p.camp_shape, 8, 64)) return null
  if (p.features != null && !isScalarMap(p.features, 12, 128)) return null
  for (const k of ['supersedes', 'overrode']) if (p[k] != null && !isIdList(p[k])) return null
  if (p.covers != null && !isIdList(p.covers, COVERS_PER_VETO)) return null
  if (p.bulk != null && typeof p.bulk !== 'boolean') return null
  if (row.kind === ANSWER_KIND) {
    if (!validateAnswer(p.qkind, p.answer)) return null
  } else {
    if (p.answer != null || !Array.isArray(p.covers) || p.parts.length !== 2 || !(TEMPLATES.has(p.parts[0]) || p.parts[0] === RETIRE)) return null
  }
  const m = String(row.match_key ?? '').match(MATCH_KEY)
  if (!m || m[1] !== sha256(JSON.stringify([p.qkind, p.parts]))) return null
  return { p, keyHash: m[1] }
}

function permissionCheck(permissions) {
  return (role) => {
    const allowed = permissions[role]
    return Boolean(allowed && (allowed.includes('*') || allowed.includes('groups.import')))
  }
}

function authorLookup(db, permissions) {
  const holds = permissionCheck(permissions)
  const cache = new Map()
  return (userId) => {
    if (!userId) return { exists: false, qualifies: false, name: null }
    if (!cache.has(userId)) {
      const u = db.prepare('SELECT role, name FROM users WHERE id = ?').get(userId)
      cache.set(userId, { exists: Boolean(u), qualifies: Boolean(u && holds(u.role)), name: u?.name ?? null })
    }
    return cache.get(userId)
  }
}

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',')

function tombstonedIds(db, ids) {
  const out = new Set()
  const list = [...ids]
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500)
    for (const r of db.prepare(`SELECT id FROM tombstones WHERE id IN (${placeholders(chunk.length)})`).all(...chunk)) out.add(r.id)
  }
  return out
}

// Refs hold entity ids; an `alias:<id>` ref points at a source_aliases row whose entity_id may be tombstoned.
function tombstonedRefSet(db, refLists) {
  const plain = new Set()
  const aliasIds = new Set()
  for (const refs of refLists) {
    for (const r of refs) {
      if (r.startsWith('alias:')) aliasIds.add(r.slice(6))
      else plain.add(r)
    }
  }
  const aliasTargets = new Map()
  const aliasList = [...aliasIds]
  for (let i = 0; i < aliasList.length; i += 500) {
    const chunk = aliasList.slice(i, i + 500)
    for (const r of db.prepare(`SELECT id, entity_id FROM source_aliases WHERE id IN (${placeholders(chunk.length)})`).all(...chunk)) aliasTargets.set(r.id, r.entity_id)
  }
  const dead = tombstonedIds(db, new Set([...plain, ...aliasTargets.values()]))
  return (refs) => refs.some((r) => (r.startsWith('alias:') ? dead.has(aliasTargets.get(r.slice(6))) : dead.has(r)))
}

export function liveRecords(db, campId, { permissions = PERMISSIONS } = {}) {
  const rows = db.prepare(
    `SELECT id, kind, match_key, payload, status, confirmed_by, confirmed_at FROM camp_seedlings
      WHERE camp_id = ? AND kind IN ('import_answer', 'import_rule_veto') AND status IN ('active', 'superseded')`
  ).all(campId)
  const author = authorLookup(db, permissions)
  const diagnostics = { discarded: 0, tombstoned: 0 }
  const parsed = []
  for (const row of rows) {
    const got = parsePayload(row)
    if (!got) { if (row.status === 'active') diagnostics.discarded += 1; continue }
    const a = author(row.confirmed_by)
    const { p } = got
    // `status` is never trusted: a status flip is only a hint for retention. A record is dead only
    // when a qualifying author's record supersedes it or forgets it (below).
    parsed.push({
      id: row.id, coverId: coverDigest(row.id), kind: row.kind, keyHash: got.keyHash, qkind: p.qkind, role: p.role, seq: p.seq, import_id: p.import_id ?? null,
      parts: p.parts, baseline: p.baseline ?? {}, refs: p.refs ?? [], camp_shape: p.camp_shape ?? {}, features: p.features ?? {},
      answer: p.answer ?? null, supersedes: p.supersedes ?? [], overrode: p.overrode ?? [], covers: p.covers ?? [], bulk: p.bulk === true,
      confirmed_by: row.confirmed_by, confirmed_at: row.confirmed_at, qualifies: a.qualifies, former: !a.exists, authorName: a.name,
    })
  }
  const isTombstoned = tombstonedRefSet(db, parsed.map((r) => r.refs))
  const kept = parsed.filter((r) => {
    if (!isTombstoned(r.refs)) return true
    diagnostics.tombstoned += 1
    return false
  })
  const isMarker = (r) => r.kind === VETO_KIND && r.parts[0] === RETIRE
  const dead = new Set(kept.filter((r) => r.qualifies).flatMap((r) => r.supersedes))
  const forgotten = new Set(kept.filter((r) => r.qualifies && isMarker(r)).flatMap((r) => r.covers))
  const isDead = (r) => dead.has(r.id) || (!isMarker(r) && forgotten.has(r.coverId))
  const alive = kept.filter((r) => !isDead(r))
  const order = (a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1)
  return {
    answers: alive.filter((r) => r.kind === ANSWER_KIND).sort(order),
    vetoes: alive.filter((r) => r.kind === VETO_KIND && !isMarker(r)).sort(order),
    markers: alive.filter(isMarker),
    retired: kept.filter(isDead),
    diagnostics,
  }
}

export function logUnreadablePayloads(db, campId, log = console.warn) {
  const { diagnostics } = liveRecords(db, campId)
  if (diagnostics.discarded > 0) log(`camp_seedlings: ${diagnostics.discarded} records this build cannot read`)
}

// Used by the projector's erasure gate: does this payload name a tombstoned id?
export function answerPayloadTombstoned(db, kind, payload) {
  if (kind !== ANSWER_KIND && kind !== VETO_KIND) return false
  let p
  try {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return false
    p = JSON.parse(payload)
  } catch { return false }
  const refs = Array.isArray(p?.refs) ? p.refs.filter((r) => typeof r === 'string').slice(0, 64) : []
  return refs.length > 0 && tombstonedRefSet(db, [refs])(refs)
}

// T233: after a tombstone is applied, drop any answer record that names it. Defense in depth: the
// read path already excludes these, and the projector refuses to re-project them.
export function sweepTombstonedAnswerRecords(db) {
  const rows = db.prepare("SELECT id, kind, payload FROM camp_seedlings WHERE kind IN ('import_answer', 'import_rule_veto')").all()
  let removed = 0
  for (const r of rows) {
    if (answerPayloadTombstoned(db, r.kind, r.payload)) {
      db.prepare('DELETE FROM camp_seedlings WHERE id = ?').run(r.id)
      removed += 1
    }
  }
  return removed
}

// ---------------------------------------------------------------- recall

const valuesEqual = (a, b) => stable(a ?? {}) === stable(b ?? {})

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
}

function refsAreLive(db, tables, decision, sig) {
  if (sig.refs.length === 0) return true
  const entity = String(decision.entity ?? '')
  if (!/^[a-z_]+$/.test(entity) || !tables.has(entity)) return false
  for (const id of sig.refs) {
    let row
    try { row = db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id) } catch { return false }
    if (!row) return false
    if ('name' in row && decision.entityName != null && normalizeName(row.name) !== normalizeName(decision.entityName)) return false
  }
  return true
}

const dateLabel = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function describeAuthor(rec) {
  if (rec.former) return 'a former user'
  return rec.authorName ?? 'a former user'
}

const STATE_DEPENDENT = new Set(['value', 'drift_ack'])

export function matchImportAnswers(db, { campId, decisions = [], others = [], suppressed = [], mode = 'add', permissions } = {}) {
  const state = liveRecords(db, campId, permissions ? { permissions } : undefined)
  const tables = tableNames(db)
  const skip = new Set(suppressed)
  const out = {}
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision || typeof decision.id !== 'string') continue
    out[decision.id] = null
    const raw = signatureOf(decision)
    if (!raw) continue
    const sig = fitSignature(raw)
    if (mode === 'replace' && STATE_DEPENDENT.has(sig.qkind)) continue
    const key = canonicalKey(sig)
    const progress = progressForDecision(decision, state.answers, state.vetoes, fitPart)
    const heads = state.answers.filter((a) => a.keyHash === key.keyHash && a.qkind === sig.qkind)
    let got = null
    if (heads.length > 0) got = instanceRecall(db, tables, decision, sig, heads, progress)
    else {
      const nameKey = state.answers.filter((a) => a.qkind === sig.qkind && a.parts[0] === key.parts[0])
      if (nameKey.length > 0) got = instanceRecall(db, tables, decision, sig, nameKey, progress, 'name_key')
    }
    if (!got || got.match === 'near') {
      const pat = recallPattern(decision, state.answers, state.vetoes, fitPart)
      if (pat && !got) got = patternRecall(decision, pat)
    }
    if (got && skip.has(decision.id)) { got.autoApply = false; got.suppressed = true }
    out[decision.id] = got ?? (progress ? { tier: null, source: null, match: null, answer: null, why: null, autoApply: false, progress } : null)
  }
  // Session-state questions with no card in the report (a two-row split, a name-variant or
  // multi-block merge, an unknown label): asked of the answer memory by signature alone.
  for (const other of Array.isArray(others) ? others : []) {
    if (!other || typeof other.id !== 'string') continue
    const raw = signatureOfOther(other.qkind, other)
    out[other.id] = null
    if (!raw) continue
    const sig = fitSignature(raw)
    const key = canonicalKey(sig)
    const heads = state.answers.filter((a) => a.keyHash === key.keyHash && a.qkind === sig.qkind)
    if (heads.length > 0) out[other.id] = instanceRecall(db, tables, null, sig, heads, null)
  }
  return out
}

function instanceRecall(db, tables, decision, sig, heads, progress, nearKind = null) {
  const newest = heads[0]
  const verdicts = new Set(heads.map((h) => h.answer.verdict))
  const qualifying = heads.every((h) => h.qualifies)
  const baselineEqual = heads.every((h) => valuesEqual(h.baseline, sig.baseline))
  const contradiction = verdicts.size > 1
  const exact = !nearKind && !contradiction && qualifying && baselineEqual && (decision ? refsAreLive(db, tables, decision, sig) : true)
  const answer = decision ? toUiAnswer(decision, newest.answer) : { verdict: newest.answer.verdict }
  if (!answer) return null
  const asRecorded = !qualifying
  return {
    tier: 0, source: 'instance', match: exact ? 'exact' : 'near', nearKind, memoryId: newest.id, answer,
    answeredAt: newest.confirmed_at, answeredBy: newest.confirmed_by, answeredByName: newest.authorName ?? null,
    asRecorded, contradiction: contradiction ? verdicts.size : 0,
    autoApply: exact && isAutoApplyEligible(decision, newest.answer),
    why: `${asRecorded ? 'As recorded: ' : ''}Remembered from ${describeAuthor(newest)}'s answer on ${dateLabel(newest.confirmed_at)}`,
    progress,
  }
}

function patternRecall(decision, pat) {
  const answer = toUiAnswer(decision, pat.answer)
  if (!answer) return null
  return {
    tier: 1, source: 'pattern', match: 'pattern', band: pat.band, baselineOk: pat.baselineOk, template: pat.template, memoryId: pat.memoryId, answer,
    examples: pat.examples, why: pat.why, progress: pat.progress, agree: pat.agree, disagree: pat.disagree,
    autoApply: pat.autoApply, asRecorded: false,
  }
}

// ---------------------------------------------------------------- writers

function loadCamperNames(db, campId) {
  const names = new Set()
  for (const r of db.prepare('SELECT display_name, external_id FROM campers WHERE camp_id = ?').all(campId)) {
    if (r.display_name) names.add(normalizeName(r.display_name))
    if (r.external_id) names.add(normalizeName(r.external_id))
  }
  return names
}

function campShape(db, campId) {
  const count = (table) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE camp_id = ?`).get(campId).c } catch { return null } }
  return { groups: count('groups'), days: count('days_of_operation') }
}

function writeRecord(db, { campId, kind, matchKey, payload, authorUserId, deviceId, confirmedAt }) {
  const id = deriveCampSeedlingId(campId, kind, matchKey)
  const values = {
    camp_id: campId, kind, match_key: matchKey, payload: JSON.stringify(payload), status: 'active',
    confirmed_by: authorUserId ?? null, confirmed_at: confirmedAt,
  }
  for (const field of SEEDLING_FIELDS) {
    appendOp(db, { entity: 'camp_seedlings', entity_id: id, field, value: values[field], author_user_id: authorUserId ?? null, device_id: deviceId, client_write_id: randomUUID() })
  }
  return { id, payload: values.payload, matchKey, confirmedAt }
}

// The status flip is a retention hint, not authority (liveRecords never reads it). It carries NO
// author: two people retiring one record at once write the same value, which is not a conflict, but
// the document's per-field author map would record two different authors for it and raise a
// conflicts row. Who retired a record is a record of its own: the successor's `supersedes`, or a
// Forget marker (forgetAnswer), both authored and both checked at read.
function retire(db, ids, { deviceId }) {
  for (const id of ids) {
    appendOp(db, { entity: 'camp_seedlings', entity_id: id, field: 'status', value: 'superseded', author_user_id: null, device_id: deviceId, client_write_id: randomUUID() })
  }
}

// Only records whose author currently qualifies count: a forged huge seq must not move the writer.
function nextSeq(records, qkind) {
  const top = records.filter((a) => a.qkind === qkind && a.qualifies).reduce((m, a) => Math.max(m, a.seq), 0)
  return Math.min(top + 1, MAX_SEQ)
}

// Never writes what parsePayload would reject: the record is checked with the reader before anything
// is appended, and a refusal is returned as { error }, never reported as written.
function insertAnswer(db, state, { campId, authorUserId, deviceId, confirmedAt, qkind, role, key, baseline, refs, features, shape, answer, importId, supersedes, overrode, bulk }) {
  const payload = {
    v: ANSWER_V, qkind, role, seq: nextSeq(state.answers, qkind), import_id: importId ?? null, parts: key.parts, baseline,
    refs, camp_shape: shape, features, answer, supersedes, overrode,
    ...(bulk ? { bulk: true } : {}),
  }
  const json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') > WRITE_BYTES) return { error: 'too_large' }
  const matchKey = `${key.keyHash}-${randomUUID()}`
  const view = parsePayload({ kind: ANSWER_KIND, payload: json, match_key: matchKey })
  if (!view) return { error: 'unwritable' }
  retire(db, supersedes, { authorUserId, deviceId })
  const written = writeRecord(db, { campId, kind: ANSWER_KIND, matchKey, payload, authorUserId, deviceId, confirmedAt })
  const dropped = new Set(supersedes)
  state.answers = state.answers.filter((a) => !dropped.has(a.id))
  state.answers.push({
    id: written.id, coverId: coverDigest(written.id), kind: ANSWER_KIND, keyHash: key.keyHash, qkind, role, seq: view.p.seq, import_id: view.p.import_id ?? null,
    parts: key.parts, baseline, refs, camp_shape: shape, features, answer, supersedes, overrode, covers: [], bulk: Boolean(bulk),
    confirmed_by: authorUserId ?? null, confirmed_at: confirmedAt, qualifies: true, former: false, authorName: null,
  })
  return { id: written.id }
}

// Everything that can throw or refuse happens here, before a single op is appended, so one
// malformed entry can skip itself without touching the rest of the batch.
function planEntry(entry, ctx) {
  const { state, camperNames, cap, importId } = ctx
  const decision = entry?.decision
  const other = entry?.other
  const rawSig = other ? signatureOfOther(other.qkind, other) : decision ? signatureOf(decision) : null
  if (!rawSig) return { skip: 'not_remembered' }
  const sig = fitSignature(rawSig)
  const answer = other
    ? (typeof entry.answer?.verdict === 'string' ? { verdict: entry.answer.verdict } : null)
    : toRecordAnswer(decision, entry.answer)
  if (answer && other && !validateAnswer(sig.qkind, answer)) return { skip: 'unanswered' }
  if (!answer) return { skip: 'unanswered' }
  if (entry.recalled) answer.recalled = true
  else if (entry.tap === true) answer.tap = true
  let role = roleFor(sig.qkind, answer)
  if (!role) return { skip: 'state_derived' }
  if (sig.parts.some((p) => camperNames.has(p))) return { skip: 'camper_name' }
  const key = canonicalKey(sig)
  const heads = state.answers.filter((a) => a.keyHash === key.keyHash && a.qkind === sig.qkind)
  // A card the director SAW pre-filled with a near memory is remembered only through an explicit
  // "Remember this" (ADR 3.5). Without it the answer is still kept, as evidence that retires nothing.
  const evidenceOnly = entry.recalled?.match === 'near' && entry.rememberNear !== true
  if (evidenceOnly) role = 'evidence'
  const matches = (h) => h.qualifies && h.answer.verdict === answer.verdict && valuesEqual(h.baseline, sig.baseline)
  const same = heads.length > 0 && (evidenceOnly ? heads.some(matches) : heads.every(matches))
  if (same) return { skip: 'unchanged' }
  const supersedes = evidenceOnly ? [] : heads.map((h) => h.id)
  if (state.answers.length - supersedes.length + 1 > cap) return { skip: 'cap' }
  const rawImport = entry.importId ?? importId
  const entryImport = typeof rawImport === 'string' && rawImport.length > 64 ? sha256(rawImport).slice(0, 32) : rawImport
  return {
    insert: {
      qkind: sig.qkind, role, key, baseline: sig.baseline, refs: sig.refs, features: sig.features, answer, importId: entryImport,
      supersedes, overrode: entry.recalled && !evidenceOnly ? supersedes : [], bulk: entry.bulk === true,
    },
  }
}

export function rememberImportAnswers(db, { campId, authorUserId, deviceId, importId = null, entries = [], now = () => new Date(), cap = RECORD_CAP } = {}) {
  const written = []
  const skipped = []
  if (!campId || !Array.isArray(entries)) return { written, skipped }
  const camperNames = loadCamperNames(db, campId)
  const shape = campShape(db, campId)
  runAtomic(db, () => {
    const state = liveRecords(db, campId)
    const ctx = { state, camperNames, cap, importId }
    for (const entry of entries) {
      let plan
      try { plan = planEntry(entry, ctx) } catch { skipped.push({ reason: 'malformed' }); continue }
      if (plan.skip) { skipped.push({ reason: plan.skip }); continue }
      const res = insertAnswer(db, state, { campId, authorUserId, deviceId, confirmedAt: now().toISOString(), shape, ...plan.insert })
      if (res.id) written.push(res.id)
      else skipped.push({ reason: res.error })
    }
  })
  runRetention(db, { campId, deviceId, authorUserId, now })
  return { written, skipped }
}

function findAnswer(db, campId, memoryId) {
  const state = liveRecords(db, campId)
  // A just-forgotten answer is still findable, so the view's Undo can write it back through Change.
  const found = state.answers.find((a) => a.id === memoryId) ?? state.retired.find((a) => a.id === memoryId && a.kind === ANSWER_KIND)
  return { state, found }
}

export function changeAnswer(db, { campId, authorUserId, deviceId, memoryId, verdict, now = () => new Date() } = {}) {
  const { state, found } = findAnswer(db, campId, memoryId)
  if (!found) return { ok: false, error: 'NOT_FOUND' }
  if (!VERDICTS[found.qkind].includes(verdict)) return { ok: false, error: 'BAD_VERDICT' }
  const heads = state.answers.filter((a) => a.keyHash === found.keyHash && a.qkind === found.qkind)
  let res = null
  runAtomic(db, () => {
    res = insertAnswer(db, state, {
      campId, authorUserId, deviceId, confirmedAt: now().toISOString(), qkind: found.qkind, role: 'instance',
      key: { parts: found.parts, keyHash: found.keyHash }, baseline: found.baseline, refs: found.refs, features: found.features,
      shape: campShape(db, campId), answer: { verdict }, importId: found.import_id, supersedes: heads.map((h) => h.id), overrode: heads.map((h) => h.id), bulk: false,
    })
  })
  return res.id ? { ok: true, id: res.id } : { ok: false, error: res.error === 'too_large' ? 'TOO_LARGE' : 'UNWRITABLE' }
}

export function forgetAnswer(db, { campId, authorUserId, deviceId, memoryId, now = () => new Date() } = {}) {
  const { state, found } = findAnswer(db, campId, memoryId)
  if (!found) return { ok: false, error: 'NOT_FOUND' }
  const heads = state.answers.filter((a) => a.keyHash === found.keyHash && a.qkind === found.qkind)
  const parts = [RETIRE, found.keyHash]
  const markers = []
  for (let i = 0; i < heads.length; i += COVERS_PER_VETO) {
    const payload = { v: ANSWER_V, qkind: found.qkind, role: 'instance', seq: nextSeq(state.vetoes, found.qkind), parts, covers: heads.slice(i, i + COVERS_PER_VETO).map((h) => h.coverId) }
    const matchKey = `${sha256(JSON.stringify([found.qkind, parts]))}-${randomUUID()}`
    if (!parsePayload({ kind: VETO_KIND, payload: JSON.stringify(payload), match_key: matchKey })) return { ok: false, error: 'UNWRITABLE' }
    markers.push({ payload, matchKey })
  }
  runAtomic(db, () => {
    for (const { payload, matchKey } of markers) {
      writeRecord(db, { campId, kind: VETO_KIND, matchKey, payload, authorUserId, deviceId, confirmedAt: now().toISOString() })
    }
    retire(db, heads.map((h) => h.id), { deviceId })
  })
  return { ok: true, retired: heads.map((h) => h.id) }
}

export function keepAnswer(db, { campId, authorUserId, deviceId, memoryId, now = () => new Date() } = {}) {
  const { state, found } = findAnswer(db, campId, memoryId)
  if (!found) return { ok: false, error: 'NOT_FOUND' }
  if (found.qualifies) return { ok: true, unchanged: true, id: found.id }
  let res = null
  runAtomic(db, () => {
    res = insertAnswer(db, state, {
      campId, authorUserId, deviceId, confirmedAt: now().toISOString(), qkind: found.qkind, role: found.role,
      key: { parts: found.parts, keyHash: found.keyHash }, baseline: found.baseline, refs: found.refs, features: found.features,
      shape: found.camp_shape, answer: found.answer, importId: found.import_id, supersedes: [found.id], overrode: [], bulk: found.bulk,
    })
  })
  return res.id ? { ok: true, id: res.id } : { ok: false, error: res.error === 'too_large' ? 'TOO_LARGE' : 'UNWRITABLE' }
}

export function forgetPattern(db, { campId, authorUserId, deviceId, template, key, now = () => new Date() } = {}) {
  if (!TEMPLATES.has(template) || typeof key !== 'string') return { ok: false, error: 'BAD_PATTERN' }
  const state = liveRecords(db, campId)
  const covered = state.answers
    .filter((a) => a.qualifies && !a.bulk && patternKeysFor(a.qkind, a.features, fitPart).some((k) => k.template === template && k.key === key))
  if (covered.length === 0) return { ok: false, error: 'NOT_FOUND' }
  const qkind = template === 'T3' ? 'exclusion' : 'classify'
  const parts = [template, fitPart(key)]
  const seq = nextSeq(state.vetoes, qkind)
  const records = []
  for (let i = 0; i < covered.length; i += COVERS_PER_VETO) {
    const payload = { v: ANSWER_V, qkind, role: 'instance', seq, parts, covers: covered.slice(i, i + COVERS_PER_VETO).map((a) => a.coverId) }
    const matchKey = `${sha256(JSON.stringify([qkind, parts]))}-${randomUUID()}`
    if (!parsePayload({ kind: VETO_KIND, payload: JSON.stringify(payload), match_key: matchKey })) return { ok: false, error: 'UNWRITABLE' }
    records.push({ payload, matchKey })
  }
  const ids = []
  runAtomic(db, () => {
    for (const { payload, matchKey } of records) {
      ids.push(writeRecord(db, { campId, kind: VETO_KIND, matchKey, payload, authorUserId, deviceId, confirmedAt: now().toISOString() }).id)
    }
  })
  return { ok: true, id: ids[0], ids, covers: covered.map((a) => a.id) }
}

// ---------------------------------------------------------------- retention

export function runRetention(db, { campId, deviceId, authorUserId, now = () => new Date() } = {}) {
  const cutoff = now().getTime() - RETENTION_DAYS * 86_400_000
  const old = (r) => new Date(r.confirmed_at).getTime() < cutoff
  const state = liveRecords(db, campId)
  const byKey = new Map()
  for (const r of state.retired) {
    if (!byKey.has(r.keyHash)) byKey.set(r.keyHash, [])
    byKey.get(r.keyHash).push(r)
  }
  const doomed = []
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.confirmed_at < b.confirmed_at ? 1 : a.confirmed_at > b.confirmed_at ? -1 : 0))
    for (const r of list.slice(RETENTION_KEEP)) if (old(r)) doomed.push(r.id)
  }
  const present = new Set([...state.answers, ...state.vetoes, ...state.retired].map((r) => r.coverId))
  for (const m of state.markers) if (old(m) && !m.covers.some((c) => present.has(c))) doomed.push(m.id)
  if (doomed.length === 0) return 0
  runAtomic(db, () => {
    for (const id of doomed) {
      appendOp(db, { entity: 'camp_seedlings', entity_id: id, field: DELETE_FIELD, value: 1, author_user_id: authorUserId ?? null, device_id: deviceId, client_write_id: randomUUID() })
    }
  })
  return doomed.length
}

// ---------------------------------------------------------------- the view's data

const titleCase = (s) => String(s ?? '').replace(/\b\w/g, (c) => c.toUpperCase())

export function listLearned(db, { campId, viewerUserId, permissions } = {}) {
  const opts = permissions ? { permissions } : undefined
  const state = liveRecords(db, campId, opts)
  const viewer = authorLookup(db, permissions ?? PERMISSIONS)(viewerUserId)
  const names = authorLookup(db, permissions ?? PERMISSIONS)
  const answers = state.answers.map((a) => ({
    id: a.id, qkind: a.qkind, role: a.role, name: titleCase(a.parts[0]), verdict: a.answer.verdict,
    label: answerLabel(a.features, a.answer.verdict), features: a.features, explicit: isExplicit(a), bulk: a.bulk,
    confirmed_at: a.confirmed_at, confirmed_by: a.confirmed_by, confirmedByName: names(a.confirmed_by).name,
    asRecorded: !a.qualifies, former: a.former, camp_shape: a.camp_shape,
  }))
  const patterns = []
  for (const g of patternGroups(state.answers, state.vetoes, fitPart).values()) {
    if (g.instances.length < 2) continue
    const ev = evaluateGroup(g)
    patterns.push({
      template: g.template, key: g.key, qkind: g.qkind, band: ev.band, verdict: ev.verdict,
      label: answerLabel(ev.newest.features, ev.verdict), agree: ev.agree, disagree: ev.disagree,
      names: ev.supporters.slice(0, 3).map((r) => titleCase(r.parts[0])), progress: ev.progress,
      answerIds: g.instances.map((r) => r.id),
    })
  }
  patterns.sort((a, b) => b.progress.agreeing - a.progress.agreeing)
  return {
    answers, patterns,
    vetoes: state.vetoes.length,
    formerUserAnswers: state.answers.filter((a) => !a.qualifies).length,
    canWrite: viewer.qualifies,
    diagnostics: state.diagnostics,
  }
}
