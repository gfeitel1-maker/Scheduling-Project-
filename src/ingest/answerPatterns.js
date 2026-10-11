// Tier 1 patterns, computed at recall time from validated records (docs/adr/2026-10-11-import-answer-memory.md 3.4).
// Nothing is stored. Pure: the caller (electron/ops/answerMemory.js liveRecords) has already validated
// every record and resolved whether its author currently qualifies.
//
// A record view is { id, qkind, role, seq, import_id, parts, features, answer, bulk, qualifies,
// confirmed_by, confirmed_at }; a veto view is { qualifies, parts: [template, key], covers: [ids] }.
import { signatureOf, LEARNING_BAR, isAutoApplyEligible, isExplicit } from './answerMemory.js'

export { LEARNING_BAR }

const SEP = '\u0000'

// A fixed menu of templates, never a search.
export function patternKeysFor(qkind, f) {
  const keys = []
  if (qkind === 'classify' && f?.proposedClass) {
    if (f.stem) keys.push({ template: 'T1', key: `${f.proposedClass}|${f.stem}` })
    if (f.isMeal) keys.push({ template: 'T2', key: `${f.proposedClass}|meal` })
  }
  if (qkind === 'exclusion' && f?.excludedSet) keys.push({ template: 'T3', key: f.excludedSet })
  return keys
}

const newestFirst = (a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1)
const shapeOf = (f) => `${f?.dayShape ?? ''}|${f?.scopeShape ?? ''}|${f?.blockLenClass ?? ''}`

// One group per (template, key): the distinct instances (newest answer per normalized name),
// newest first. Bulk, evidence-from-bulk, non-qualifying and veto-covered records are excluded.
export function patternGroups(records, vetoes, fit = (k) => k) {
  const vetoed = (veto) => `${veto.parts?.[0]}${SEP}${veto.parts?.[1]}`
  const coverByGroup = new Map()
  for (const v of vetoes ?? []) {
    if (!v.qualifies) continue
    const set = coverByGroup.get(vetoed(v)) ?? new Set()
    for (const id of v.covers ?? []) set.add(id)
    coverByGroup.set(vetoed(v), set)
  }
  const byGroup = new Map()
  for (const r of records ?? []) {
    if (!r.qualifies || r.bulk) continue
    for (const { template, key } of patternKeysFor(r.qkind, r.features)) {
      const gk = `${template}${SEP}${key}`
      if (coverByGroup.get(`${template}${SEP}${fit(key)}`)?.has(r.id)) continue
      if (!byGroup.has(gk)) byGroup.set(gk, { template, key, qkind: r.qkind, byName: new Map() })
      const g = byGroup.get(gk)
      const name = r.parts?.[0] ?? ''
      const cur = g.byName.get(name)
      if (!cur || newestFirst(r, cur) < 0) g.byName.set(name, r)
    }
  }
  const out = new Map()
  for (const [gk, g] of byGroup) {
    out.set(gk, { template: g.template, key: g.key, qkind: g.qkind, instances: [...g.byName.values()].sort(newestFirst) })
  }
  return out
}

function runLength(instances) {
  const v = instances[0].answer.verdict
  let n = 0
  while (n < instances.length && instances[n].answer.verdict === v) n += 1
  return n
}

export function evaluateGroup(group) {
  const { instances } = group
  const newest = instances[0]
  const verdict = newest.answer.verdict
  const run = runLength(instances)
  const supporters = instances.slice(0, run)
  const imports = new Set(supporters.slice(0, LEARNING_BAR.instances).map((r) => r.import_id).filter(Boolean)).size
  const explicit = supporters.slice(0, LEARNING_BAR.instances).filter(isExplicit).length
  const agreeing = Math.min(run, instances.length)
  let band = 'ask'
  if (instances.length >= 2 && run >= 2) {
    band = run >= LEARNING_BAR.instances && imports >= LEARNING_BAR.imports && explicit >= LEARNING_BAR.explicit ? 'established' : 'suggest'
  }
  const f = newest.features ?? {}
  const kindEligible = isAutoApplyEligible({ kind: f.dk, entity: f.entity }, { verdict: 'accept' })
  const neverReason = !kindEligible ? 'kind' : (verdict === 'accept' ? null : 'rejection')
  const missing = []
  if (run < LEARNING_BAR.instances) missing.push('more_answers')
  if (imports < LEARNING_BAR.imports) missing.push('another_import')
  if (explicit < LEARNING_BAR.explicit) missing.push('explicit')
  const shapes = new Set(supporters.slice(0, LEARNING_BAR.instances).map((r) => shapeOf(r.features)))
  if (shapes.size > 1) missing.push('consistent_shape')
  const progress = {
    agreeing, needed: LEARNING_BAR.instances,
    imports, importsNeeded: LEARNING_BAR.imports,
    explicit, explicitNeeded: LEARNING_BAR.explicit,
    missing: neverReason ? [] : missing,
    neverAutoApply: Boolean(neverReason), neverReason, band,
  }
  const agree = instances.filter((r) => r.answer.verdict === verdict).length
  return { band, verdict, run, agree, disagree: instances.length - agree, progress, supporters, newest, shapes: shapes.size === 1 ? [...shapes][0] : null }
}

export function progressOf(group) {
  return evaluateGroup(group).progress
}

const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase())
const fmtDate = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function answerLabel(features, verdict) {
  const cls = features?.proposedClass
  if (features?.dk === 'all_camp_override') return verdict === 'all_camp' ? 'All camp' : 'Leave as written'
  if (cls === 'name_kind') return verdict === 'accept' ? 'A fixed time' : 'An activity Generate can schedule'
  if (cls === 'fixed_event') return verdict === 'accept' ? 'Fixed event' : 'Not a fixed event'
  if (cls === 'elective_set') return verdict === 'accept' ? 'Elective set' : 'Not electives'
  return verdict
}

function joinNames(names) {
  const shown = names.slice(0, 3).map(titleCase)
  const more = names.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0]
}

function whyFor(decision, ev) {
  const names = ev.supporters.map((r) => r.parts[0])
  const dates = [...new Set(ev.supporters.slice(0, 3).map((r) => fmtDate(r.confirmed_at)).filter(Boolean))].join(', ')
  const label = answerLabel(ev.newest.features, ev.verdict)
  const band = ev.band === 'established' ? 'Established' : 'Suggested'
  const counts = `${ev.agree} agree${ev.disagree > 0 ? `, ${ev.disagree} earlier disagreed` : ''}`
  return `You answered ${label} for ${joinNames(names)}${dates ? ` (${dates})` : ''}. ${titleCase(decision.entityName ?? 'This')} is the same kind of thing. ${band}: ${counts}.`
}

export function recallPattern(decision, records, vetoes, fit) {
  const sig = signatureOf(decision)
  if (!sig) return null
  const groups = patternGroups(records, vetoes, fit)
  let best = null
  for (const { template, key } of patternKeysFor(sig.qkind, sig.features)) {
    const group = groups.get(`${template}${SEP}${key}`)
    if (!group) continue
    const ev = evaluateGroup(group)
    if (ev.band === 'ask') continue
    const rank = ev.band === 'established' ? 2 : 1
    if (!best || rank > best.rank || (rank === best.rank && ev.newest.seq > best.ev.newest.seq)) best = { rank, template, key, ev }
  }
  if (!best) return null
  const { ev, template, key } = best
  const baselineOk = ev.shapes != null && ev.shapes === shapeOf(sig.features)
  const band = ev.band === 'established' && !baselineOk ? 'suggest' : ev.band
  const answer = { verdict: ev.verdict }
  const autoApply = band === 'established' && isAutoApplyEligible(decision, answer)
  return {
    template, key, band, answer, autoApply, baselineOk,
    agree: ev.agree, disagree: ev.disagree,
    examples: ev.supporters.slice(0, 3).map((r) => ({ id: r.id, name: r.parts[0], confirmed_by: r.confirmed_by, confirmed_at: r.confirmed_at, qualifies: r.qualifies })),
    memoryId: ev.newest.id,
    progress: { ...ev.progress, band },
    why: whyFor(decision, { ...ev, band }),
  }
}

// How close a decision's pattern is to applying on its own, whatever the band: the view's
// "2 of 3" and what is still missing, from the same evaluation recallPattern uses.
export function progressForDecision(decision, records, vetoes, fit) {
  const sig = signatureOf(decision)
  if (!sig) return null
  const groups = patternGroups(records, vetoes, fit)
  let best = null
  for (const { template, key } of patternKeysFor(sig.qkind, sig.features)) {
    const group = groups.get(`${template}${SEP}${key}`)
    if (!group) continue
    const ev = evaluateGroup(group)
    if (!best || ev.progress.agreeing > best.progress.agreeing) best = { template, key, progress: ev.progress }
  }
  return best ? { ...best.progress, template: best.template, key: best.key } : null
}
