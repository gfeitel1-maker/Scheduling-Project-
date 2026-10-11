// Import answer memory, the pure half (docs/adr/2026-10-11-import-answer-memory.md 3.4).
//
// No IO and no hashing here: signatureOf returns RAW parts. The server turns them into a key in ONE
// place (electron/ops/answerMemory.js canonicalKey), where over-long parts are hashed rather than
// truncated, so the renderer and the main process cannot disagree about a key.
import { normalizeName } from './preview.js'
import { startMinutesForOrdering } from './orderTimeBlocks.js'
import { isBackedConfirmChange } from '../screens/reconciliationResolutions.js'
import { isMealName, stemOf } from './nameShape.js'

export const ANSWER_V = 1
export const FEATURES_V = 1

export const LEARNING_BAR = Object.freeze({
  instances: 3,
  imports: 2,
  explicit: 1,
  shortBlockUnder: 30,
  longBlockFrom: 60,
})

// 'trip' and 'special_day': F3/F4 slice 2 (docs/adr/2026-10-11-import-special-days-and-field-trips.md, N3).
// A trip item's answer is remembered by (name, day); a special_day answer is recorded but never auto-applied
// (it is deliberately absent from AUTO_APPLY_ELIGIBLE), so a remembered answer pre-selects at most.
export const QKINDS = Object.freeze(['classify', 'exclusion', 'value', 'drift_ack', 'split', 'merge', 'residue', 'trip', 'special_day'])

export const VERDICTS = Object.freeze({
  classify: ['accept', 'reject', 'as_activity'],
  exclusion: ['all_camp', 'as_written'],
  value: ['accept', 'keep', 'edited'],
  drift_ack: ['ack'],
  split: ['accept', 'decline'],
  merge: ['accept', 'decline'],
  residue: ['added', 'mapped', 'ignored'],
  trip: ['event', 'activity'],
  special_day: ['special_day', 'events'],
})

// Kinds the report emits that carry nothing worth remembering here. resolve_conflict has its own
// store (source_aliases); the rest are acknowledgements or readiness facts.
export const NOT_REMEMBERED = new Set([
  'resolve_conflict', 'review_legacy_priority', 'elective_candidates_truncated', 'required_gap',
])

// Auto-apply is a frozen allow-list of (decision.kind, entity) pairs, fail closed: a new kind is
// non-eligible until someone adds it here. Never keyed by qkind.
export const AUTO_APPLY_ELIGIBLE = Object.freeze([Object.freeze({ kind: 'confirm_value', entity: 'fixed_events' })])

// Auto-apply only ever produces the ACCEPTING answer. A rejection, decline or anything that
// withholds stays a suggestion however strong the pattern.
const ACCEPTING = new Set(['accept'])

export function isAutoApplyEligible(decision, answer) {
  if (!decision || !answer || !ACCEPTING.has(answer.verdict)) return false
  return AUTO_APPLY_ELIGIBLE.some((e) => e.kind === decision.kind && e.entity === decision.entity)
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export function normalizeDay(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (t.length >= 3) {
    const day = DAYS.find((d) => d.startsWith(t))
    if (day) return day
  }
  return normalizeName(t)
}

const RANGE = /(\d{1,2})[:.](\d{2})\s*([ap])?\.?m?\.?\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*([ap])?\.?m?\.?/i

function toMinutes(h, m, meridiem) {
  if (meridiem) return (Number(h) % 12) * 60 + Number(m) + (meridiem.toLowerCase() === 'p' ? 720 : 0)
  return startMinutesForOrdering(`${h}:${m}`)
}

function blockRange(text) {
  const m = String(text ?? '').match(RANGE)
  if (!m) return null
  const endMer = m[6] ?? null
  const start = toMinutes(m[1], m[2], m[3] ?? endMer)
  const end = toMinutes(m[4], m[5], endMer)
  return start == null || end == null ? null : { start, end }
}

// "2:25-3:15 PM" and "02:25-03:15" are one block; a named period ("Block 2") is its normalized text.
export function blockKey(text) {
  const r = blockRange(text)
  return r ? `${r.start}-${r.end}` : normalizeName(text)
}

function blockLenClass(text) {
  const r = blockRange(text)
  if (!r || r.end <= r.start) return null
  const len = r.end - r.start
  if (len < LEARNING_BAR.shortBlockUnder) return 'short'
  return len < LEARNING_BAR.longBlockFrom ? 'standard' : 'long'
}

const dayRank = (d) => { const i = DAYS.indexOf(d); return i < 0 ? 99 : i }
const daySet = (days) => JSON.stringify([...new Set((Array.isArray(days) ? days : []).map(normalizeDay))].sort((a, b) => dayRank(a) - dayRank(b) || (a < b ? -1 : 1)))
const nameSet = (names) => JSON.stringify([...new Set((Array.isArray(names) ? names : []).map(normalizeName))].sort())
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

// Which question family a decision belongs to, or null when it is not remembered.
export function classifyDecision(d) {
  if (!d || NOT_REMEMBERED.has(d.kind)) return null
  switch (d.kind) {
    case 'confirm_value': return d.entity === 'fixed_events' ? 'classify' : 'value'
    case 'confirm_change': return isBackedConfirmChange(d) ? 'value' : 'drift_ack'
    case 'elective_candidate': return 'classify'
    case 'name_kind': return 'classify'
    case 'all_camp_override': return 'exclusion'
    case 'resolve_unknown_label':
    case 'resolve_packed_cell': return 'residue'
    default: return null
  }
}

// name_kind (#889) asks "fixed time, or an activity Generate can schedule?" about a name that
// recurs; the days and times live on its candidate events rather than on the decision.
const candidateDays = (d) => [...new Set((d.candidateEvents ?? []).flatMap((e) => e.days ?? []))]
const candidateBlock = (d) => d.candidateEvents?.[0]?.time_block

function dayShapeOf(d) {
  const basis = d.evidence?.basis
  if (basis === 'daily' || basis === 'weekly') return basis
  const n = Array.isArray(d.days) ? d.days.length : 0
  if (n === 1) return 'single'
  return n >= 4 ? 'daily' : 'weekly'
}

function proposedClassOf(d, qkind) {
  if (qkind === 'exclusion') return 'all_camp'
  if (d.kind === 'elective_candidate') return 'elective_set'
  if (d.kind === 'name_kind') return 'name_kind'
  return d.entity === 'fixed_events' ? 'fixed_event' : String(d.entity ?? '')
}

export function featuresOf(d, qkind = classifyDecision(d)) {
  const name = d.entityName ?? ''
  const isEx = qkind === 'exclusion'
  const block = isEx ? d.evidence?.block : d.kind === 'name_kind' ? candidateBlock(d) : d.timeBlock
  return {
    dk: d.kind,
    entity: d.entity ?? null,
    proposedClass: proposedClassOf(d, qkind),
    stem: stemOf(name),
    isMeal: isMealName(name),
    dayShape: isEx ? 'single' : dayShapeOf(d.kind === 'name_kind' ? { ...d, days: candidateDays(d) } : d),
    scopeShape: d.evidence?.scope === 'subset' ? 'subset' : 'all',
    blockLenClass: blockLenClass(block),
    excludedSet: isEx ? nameSet(d.evidence?.missingGroups) : null,
  }
}

export function signatureOf(d) {
  const qkind = classifyDecision(d)
  if (!qkind) return null
  const name = normalizeName(d.entityName)
  const features = featuresOf(d, qkind)
  let parts, baseline, refs = []
  if (qkind === 'classify') {
    parts = d.kind === 'elective_candidate'
      ? [name, 'elective_set']
      : d.kind === 'name_kind'
        ? [name, 'name_kind', daySet(candidateDays(d)), nameSet((d.candidateEvents ?? []).map((e) => blockKey(e.time_block))), nameSet(d.excludedGroups)]
        : [name, 'fixed_event', daySet(d.days), blockKey(d.timeBlock), nameSet(d.groupScope)]
    baseline = { loc: d.locationId ?? null, groups: d.groupCount ?? null }
  } else if (qkind === 'exclusion') {
    const ev = d.evidence ?? {}
    parts = [name, nameSet(ev.missingGroups), normalizeDay(ev.day), blockKey(ev.block)]
    baseline = {
      attending: ev.attendingCount ?? null,
      occ: ev.occurrences ?? null,
      instead: stable(Object.fromEntries(Object.entries(ev.insteadByGroup ?? {}).map(([g, xs]) => [normalizeName(g), [...(xs ?? [])].map(normalizeName).sort()]))),
    }
  } else if (qkind === 'value') {
    parts = [String(d.entity ?? ''), String(d.entityId ?? ''), JSON.stringify([].concat(d.field ?? []).sort()), stable(d.proposedValue ?? null), name]
    baseline = { stored: stable(d.currentValue ?? null) }
    if (d.entityId) refs = [d.entityId]
  } else if (qkind === 'drift_ack') {
    parts = [name, stable(d.from ?? null), stable(d.to ?? null)]
    baseline = { block: blockKey(d.timeBlock), days: daySet(d.days) }
  } else {
    parts = [name]
    baseline = {}
  }
  return { qkind, parts, baseline, refs, features }
}

// split / merge / residue are session-state questions with no card in the report; they take explicit input.
export function signatureOfOther(qkind, { name, variants, patterns, target, candidates, day }) {
  const features = { dk: qkind, entity: null, proposedClass: qkind, stem: null, isMeal: false, dayShape: null, scopeShape: 'all', blockLenClass: null, excludedSet: null }
  if (qkind === 'split') return { qkind, parts: [normalizeName(name)], baseline: { patterns: stable(patterns ?? null) }, refs: [], features }
  if (qkind === 'merge') return { qkind, parts: [nameSet(variants)], baseline: { target: target ?? null }, refs: target ? [target] : [], features }
  if (qkind === 'residue') return { qkind, parts: [normalizeName(name)], baseline: { candidates: JSON.stringify([...(candidates ?? [])].sort()) }, refs: [], features }
  // Recall rule (trip / special_day): the same printed name on the same weekday recalls the answer; the
  // groups and blocks are deliberately not in the key, so a trip that moved by a period or gained a group
  // is still the director's known trip.
  if (qkind === 'trip' || qkind === 'special_day') return { qkind, parts: [normalizeName(name), normalizeDay(day)], baseline: {}, refs: [], features }
  return null
}

// UI answer -> stored answer (null when the director has not answered, or the shape is unknown).
export function toRecordAnswer(d, ui) {
  if (!ui) return null
  switch (d.kind) {
    case 'confirm_value':
      if (ui.action === 'looks_right') return { verdict: 'accept' }
      if (ui.action === 'edited') {
        if (d.entity !== 'fixed_events') return { verdict: 'edited' }
        return { verdict: ui.notAnEvent === true ? 'as_activity' : 'reject' }
      }
      return null
    case 'confirm_change':
      if (isBackedConfirmChange(d)) {
        if (ui.choice === 'accept') return { verdict: 'accept' }
        if (ui.choice === 'keep') return { verdict: 'keep' }
        return null
      }
      return ui.ack === true ? { verdict: 'ack' } : null
    case 'name_kind':
      // "It is a fixed time" accepts the proposal that it is an event; "an activity" rejects it.
      if (ui.choice === 'fixed') return { verdict: 'accept' }
      if (ui.choice === 'activity') return { verdict: 'reject' }
      return null
    case 'elective_candidate':
      if (ui.choice === 'confirm') return { verdict: 'accept' }
      if (ui.choice === 'decline') return { verdict: 'reject' }
      return null
    case 'all_camp_override':
      return ui.choice === 'all_camp' || ui.choice === 'as_written' ? { verdict: ui.choice } : null
    case 'resolve_unknown_label':
    case 'resolve_packed_cell':
      if (ui.action === 'added_activity') return { verdict: 'added' }
      if (ui.action === 'mapped_to_existing') return { verdict: 'mapped' }
      return null
    default: return null
  }
}

// Stored answer -> the UI answer a click would have produced.
export function toUiAnswer(d, rec) {
  const v = rec?.verdict
  switch (d.kind) {
    case 'confirm_value':
      if (v === 'accept') return { action: 'looks_right' }
      if (v === 'as_activity') return { action: 'edited', notAnEvent: true }
      if (v === 'reject' || v === 'edited') return { action: 'edited' }
      return null
    case 'confirm_change':
      if (isBackedConfirmChange(d)) return v === 'accept' ? { choice: 'accept' } : v === 'keep' ? { choice: 'keep' } : null
      return v === 'ack' ? { ack: true } : null
    case 'name_kind':
      return v === 'accept' ? { choice: 'fixed' } : v === 'reject' || v === 'as_activity' ? { choice: 'activity' } : null
    case 'elective_candidate':
      return v === 'accept' ? { choice: 'confirm' } : v === 'reject' ? { choice: 'decline' } : null
    case 'all_camp_override':
      return v === 'all_camp' || v === 'as_written' ? { choice: v } : null
    default: return null
  }
}

// A positive answer that leaves the entity in the database is state-derived (the next plan says
// "unchanged"), so it is not instance memory. Only classify gets looks_right as EVIDENCE.
export function roleFor(qkind, answer) {
  const v = answer.verdict
  if (answer.tap === true) return 'instance'
  if (qkind === 'classify' && v === 'accept') return 'evidence'
  if (qkind === 'merge' && v === 'accept') return 'evidence'
  if (qkind === 'residue' && v === 'mapped') return 'evidence'
  if (qkind === 'value' && v === 'accept') return null
  return 'instance'
}

const EXPLICIT_VERDICTS = new Set(['reject', 'as_written', 'keep', 'edited', 'decline', 'as_activity', 'activity', 'events'])

// An edit or a decline on a card that was NOT recalled, or a "Remember as a pattern" tap on one.
export function isExplicit(record) {
  if (record.role !== 'instance' || record.answer?.recalled) return false
  return EXPLICIT_VERDICTS.has(record.answer?.verdict) || record.answer?.tap === true
}

export function validateAnswer(qkind, a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false
  const verdicts = VERDICTS[qkind]
  if (!verdicts || !verdicts.includes(a.verdict)) return false
  for (const k of Object.keys(a)) {
    if (k !== 'verdict' && k !== 'tap' && k !== 'recalled') return false
    if (k !== 'verdict' && typeof a[k] !== 'boolean') return false
  }
  return true
}
