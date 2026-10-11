// The pure words behind "What Shoresh has learned" and the review-card labels
// (docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md). The view and the cards only render
// what these return: nothing here recounts anything the store already counted, and no percentage
// ever reaches the director (confidence is words plus counts).

export const NEVER_APPLY_LINE = 'Always asks you: this kind only pre-selects.'
const NEVER_APPLY_FLAG = 'Always asks you'
const NEVER_KIND_REASON = 'Only you know whether this group had a trip, so Shoresh never decides it for you.'
const NEVER_REJECTION_REASON = 'Shoresh only ever applies answers that say yes. It never decides to leave something out.'
const SUGGEST_AGAIN_ANSWERS = 2

const GROUPS = [
  { key: 'classify', label: 'Classification', qkinds: ['classify'] },
  { key: 'exclusion', label: 'All camp except...', qkinds: ['exclusion'] },
  { key: 'value', label: 'Values', qkinds: ['value', 'drift_ack'] },
  { key: 'split', label: 'Splits and merges', qkinds: ['split', 'merge'] },
]
const OTHER_GROUP = { key: 'other', label: 'Other' }
export const GROUP_LABELS = [...GROUPS, OTHER_GROUP].map((g) => ({ key: g.key, label: g.label }))

const VERDICT_TEXT = {
  value: { accept: 'Used the file’s value', keep: 'Kept the current value', edited: 'Edited by hand' },
  drift_ack: { ack: 'Acknowledged the change' },
  split: { accept: 'Split into two', decline: 'Kept as one' },
  merge: { accept: 'Merged', decline: 'Kept separate' },
  residue: { added: 'Added as new', mapped: 'Mapped to an existing one', ignored: 'Ignored' },
}

// What a director can pick when changing an answer. Mirrors VERDICTS in answerMemory.js with
// the words the cards use; the writer re-validates the verdict, so this only drives the buttons.
export const CHANGE_CHOICES = {
  classify: [['accept', 'Fixed event'], ['reject', 'Not a fixed event']],
  exclusion: [['all_camp', 'All camp'], ['as_written', 'Leave as written']],
  value: [['accept', 'Used the file’s value'], ['keep', 'Kept the current value'], ['edited', 'Edited by hand']],
  drift_ack: [['ack', 'Acknowledged the change']],
  split: [['accept', 'Split into two'], ['decline', 'Kept as one']],
  merge: [['accept', 'Merged'], ['decline', 'Kept separate']],
  residue: [['added', 'Added as new'], ['mapped', 'Mapped to an existing one'], ['ignored', 'Ignored']],
}

export function shortDate(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function formerAnswersSentence(n) {
  if (!n || n < 1) return null
  return n === 1 ? '1 answer is from a person who no longer imports.' : `${n} answers are from people who no longer import.`
}

const MISSING_TEXT = { another_import: 'needs one more import', explicit: 'needs one answer you edited or declined' }

export function progressLine(progress, { disagree = 0 } = {}) {
  const needed = progress.needed ?? 3
  const count = `${progress.agreeing} of ${needed} answers`
  if (progress.neverAutoApply) return `${count} agree - once established it pre-selects the answer, and you still confirm.`
  if (progress.band === 'ask' && disagree > 0) {
    return `Your latest answer disagrees - ${SUGGEST_AGAIN_ANSWERS} more agreeing answers to suggest again`
  }
  if (progress.band === 'established' && (progress.missing ?? []).length === 0) {
    return `${count} - Shoresh applies this on its own, and tells you each time`
  }
  const missing = (progress.missing ?? []).map((m) => MISSING_TEXT[m]).filter(Boolean)
  return missing.length > 0 ? `${count} - ${missing.join(', ')}` : count
}

export function patternFlag(pattern) {
  const band = pattern.progress?.band ?? pattern.band
  const never = Boolean(pattern.progress?.neverAutoApply)
  if (band === 'established') return never ? { text: 'Pre-selects for you', tone: 'primary' } : { text: 'Applies automatically', tone: 'success' }
  if (band === 'suggest') return { text: 'Suggested', tone: 'primary' }
  return { text: 'Still asks', tone: 'neutral' }
}

function joinNames(names, total) {
  const shown = names.slice(0, 3)
  const more = Math.max(0, (total ?? names.length) - shown.length)
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '')
}

function answerText(a) {
  if (a.qkind === 'classify' || a.qkind === 'exclusion') return a.label
  return VERDICT_TEXT[a.qkind]?.[a.verdict] ?? a.label ?? a.verdict
}

function authorOf(a, viewerUserId) {
  if (viewerUserId && a.confirmed_by === viewerUserId) return { text: 'you', you: true }
  const first = typeof a.confirmedByName === 'string' ? a.confirmedByName.trim().split(/\s+/)[0] : ''
  return first ? { text: first, you: false } : { text: 'a former user', you: false }
}

const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1)

function answerRow(a, viewerUserId, canWrite) {
  const author = authorOf(a, viewerUserId)
  const date = shortDate(a.confirmed_at)
  const text = answerText(a)
  const evidence = a.role === 'evidence'
  return {
    rowKind: 'answer', id: a.id, qkind: a.qkind, verdict: a.verdict, names: [a.name],
    title: `${a.name}: ${text}`,
    why: `${sentenceCase(author.text)} ${evidence ? 'confirmed' : 'answered'} ${text} on ${date}.`,
    who: `Answered by ${author.text} on ${date}`,
    flag: evidence ? { text: 'You confirmed', tone: 'neutral' } : { text: 'Remembered', tone: 'success' },
    asRecorded: a.asRecorded === true,
    canKeep: a.asRecorded === true && canWrite,
    choices: CHANGE_CHOICES[a.qkind] ?? [],
    confirmed_at: a.confirmed_at, camp_shape: a.camp_shape ?? null,
  }
}

function patternRow(p, byId, viewerUserId, canWrite) {
  const supporters = p.answerIds.map((id) => byId.get(id)).filter((a) => a && a.verdict === p.verdict)
  const authors = []
  const stamps = []
  for (const a of supporters) {
    const who = authorOf(a, viewerUserId).text
    if (!authors.includes(who)) authors.push(who)
    const stamp = `${who} ${shortDate(a.confirmed_at)}`
    if (!stamps.includes(stamp)) stamps.push(stamp)
  }
  const latest = supporters.reduce((m, a) => (a.confirmed_at > m ? a.confirmed_at : m), '')
  const names = p.names.slice(0, 3)
  const total = Math.max(supporters.length, names.length)
  const namesText = joinNames(names, total)
  const neverApply = p.progress.neverAutoApply
    ? { flag: NEVER_APPLY_FLAG, line: NEVER_APPLY_LINE, reason: p.progress.neverReason === 'rejection' ? NEVER_REJECTION_REASON : NEVER_KIND_REASON }
    : null
  const asRecorded = supporters.some((a) => a.asRecorded)
  return {
    rowKind: 'pattern', id: `pattern:${p.template}:${p.key}`, template: p.template, key: p.key, qkind: p.qkind, verdict: p.verdict,
    names: [...names, ...supporters.map((a) => a.name)],
    title: `${p.label}: ${namesText}`,
    why: `You answered ${p.label} for ${namesText}${stamps.length ? ` (${stamps.slice(0, 3).join(', ')})` : ''}.`,
    who: `Answered by ${authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors[authors.length - 1]}` : (authors[0] ?? 'a former user')}, latest ${shortDate(latest)}`,
    meter: Math.min(p.progress.agreeing, p.progress.needed),
    progress: progressLine(p.progress, { disagree: p.disagree }),
    confidence: `${p.agree} agree${p.disagree > 0 ? `, ${p.disagree} earlier disagreed` : ''}.`,
    flag: patternFlag(p), neverApply, asRecorded,
    canKeep: canWrite && supporters.some((a) => a.asRecorded),
    keepIds: supporters.filter((a) => a.asRecorded).map((a) => a.id),
    supporters: supporters.map((a) => answerRow(a, viewerUserId, canWrite)),
    latestId: supporters[0]?.id ?? null, choices: CHANGE_CHOICES[p.qkind] ?? [], confirmed_at: latest, camp_shape: supporters[0]?.camp_shape ?? null,
  }
}

export function buildLearnedGroups(data) {
  const { answers = [], patterns = [], viewerUserId = null } = data
  const canWrite = data.canWrite === true
  const byId = new Map(answers.map((a) => [a.id, a]))
  const keyOf = (qkind) => (GROUPS.find((g) => g.qkinds.includes(qkind)) ?? OTHER_GROUP).key
  const out = [...GROUPS, OTHER_GROUP].map((g) => ({ key: g.key, label: g.label, patterns: [], answers: [], count: 0 }))
  const at = (qkind) => out.find((g) => g.key === keyOf(qkind))
  for (const p of patterns) at(p.qkind).patterns.push(patternRow(p, byId, viewerUserId, canWrite))
  for (const a of answers) at(a.qkind).answers.push(answerRow(a, viewerUserId, canWrite))
  for (const g of out) {
    g.answers.sort((a, b) => (a.confirmed_at < b.confirmed_at ? 1 : a.confirmed_at > b.confirmed_at ? -1 : 0))
    g.count = g.patterns.length + g.answers.length
  }
  return out.filter((g) => g.count > 0)
}

// "Your camp changed since you answered" (ADR 3.5): the answer's camp shape differs from the camp's
// now, and this viewer has not already been shown the current shape. A missing last-shown means shown.
export const LAST_SHOWN_SHAPE_KEY = 'learned.lastShownShape'
export const campShapeKey = (s) => `${s?.groups ?? '?'}|${s?.days ?? '?'}`
export function campChanged(answerShape, currentShape, lastShownKey) {
  if (!answerShape || !currentShape) return false
  const now = campShapeKey(currentShape)
  return campShapeKey(answerShape) !== now && lastShownKey !== now
}

export function matchesQuery(row, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  return [row.title, row.why, ...(row.names ?? [])].some((s) => String(s ?? '').toLowerCase().includes(q))
}

// ---------------------------------------------------------------- the review cards

const sameAnswer = (a, b) => b != null && a != null && JSON.stringify(a) === JSON.stringify(b)

// Which recalled decisions to pre-answer on a fresh review. Only an exact memory or a pattern the
// store itself marked autoApply (the allow-list is the store's, honoured as given); never a
// suggestion, a near match, something the director already answered, or something undone this session.
export function seedFromRecall(decisions, answers, suppressed) {
  const seeded = {}
  const remembered = []
  const autoApplied = []
  for (const d of decisions ?? []) {
    const r = d.recalled
    if (!r || r.autoApply !== true || !r.answer) continue
    if ((answers ?? {})[d.id] !== undefined || suppressed?.has(d.id)) continue
    if (r.source === 'instance' && r.match === 'exact') { seeded[d.id] = r.answer; remembered.push(d.id) }
    else if (r.source === 'pattern') { seeded[d.id] = r.answer; autoApplied.push(d.id) }
  }
  return { seeded, remembered, autoApplied }
}

// Is this recall pre-selected but still asking? (Everything recalled that is not seeded.)
export function isSuggestion(decision, answer) {
  const r = decision?.recalled
  if (!r || !r.answer) return false
  if (answer !== undefined && sameAnswer(answer, r.answer)) return false
  return r.autoApply !== true
}

function whoseAnswer(r) {
  if (r.answeredByYou) return 'your'
  return r.answeredByName ? `${r.answeredByName.trim().split(/\s+/)[0]}'s` : "a former user's"
}

export function memoryStripText(r) {
  return `Remembered from ${whoseAnswer(r)} answer on ${shortDate(r.answeredAt)}${r.asRecorded ? ' (as recorded)' : ''}`
}

const TAIL = /\s*(Suggested|Established): \d+ agree(, \d+ earlier disagreed)?\.\s*$/

export function suggestedReason(r, { eligible = true } = {}) {
  if (r.source === 'pattern') {
    const base = String(r.why ?? '').replace(TAIL, '').trim()
    const capped = r.baselineOk === false ? " Shoresh didn't apply this on its own because this is a different shape from your earlier answers." : ''
    const confirm = r.band === 'established' && !eligible ? ' Pre-selected, but you always confirm this kind.' : ''
    return `${base}${capped}${confirm}`
  }
  const date = shortDate(r.answeredAt)
  const mine = r.answeredByYou ? 'your' : whoseAnswer(r)
  if (r.match === 'exact') return `Same as ${mine} answer on ${date}. Pre-selected, but you always confirm this kind.`
  const disagree = r.contradiction > 0 ? ' Earlier answers to this disagree.' : ''
  if (r.nearKind === 'name_key') return `Similar to ${mine} answer on ${date}, for a related question. Check it still applies.${disagree}`
  return `Similar to ${mine} answer on ${date}, but something is different. Check it still applies.${disagree}`
}

// The label a shown near recall carries when it is answered without "Also remember this".
export const NEAR_NOTED_TEXT = 'Your newer answer is noted; tap Remember this to make it the remembered one'

const SKIP_WORDS = {
  cap: 'Shoresh’s memory for this camp is full',
  unwritable: 'they couldn’t be stored',
  too_large: 'they were too large to store',
  malformed: 'they couldn’t be read',
}

// `unchanged` and the by-design skips stay silent; the rest the director is told.
export function skippedNotice(skipped) {
  const counts = {}
  for (const s of skipped ?? []) if (SKIP_WORDS[s?.reason]) counts[s.reason] = (counts[s.reason] ?? 0) + 1
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const reasons = Object.keys(counts).map((k) => SKIP_WORDS[k]).join('; ')
  return `${total} ${total === 1 ? 'answer' : 'answers'} couldn’t be remembered: ${reasons}.`
}
