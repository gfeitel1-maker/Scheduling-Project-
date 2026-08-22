// buildPlan — the PURE decision layer between an import proposal and the commit.
//
// docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
// docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
//
// A ReconciliationPlan is serializable data describing what an import WOULD do.
// buildPlan decides; it never writes and holds no DB handle. commitPlan
// (electron/ops/ingest.js) is the single privileged committer that resolves the
// plan against the live DB and translates each FieldDelta 1:1 into an appendOp.
//
// S0 exercises only the `create` and `unchanged` arms; the type is cut wide
// enough (per the type doc) to hold update/clear/conflict on day one, but those
// arms are typed-only and rejected at commit until their later slices.

import { INGESTIBLE_ENTITIES } from './extractEntities.js'
import { normalizeName, recognitionKey } from './preview.js'
import { dbFieldFor } from './fieldUpdate.js'

// ADR 2026-08-17-onescreen-reconciliation-merge.md §1 — moved here (not
// duplicated) from preview.js, whose UI-only tick-state role is gone. This is
// now the ONE place the seen-once judgment lives, feeding real create
// confidence (see createConfidenceTier below) instead of a client-only tick
// default nothing downstream ever saw.
//
// Is this name just two other proposed names stuck together?
//
// "Opening Drama" appears twice; "Opening" appears 21 times and "Drama" 36. A
// name that is far rarer than every one of its own parts is where two adjacent
// cells were read as one, not a compound the camp actually uses.
//
// The frequency guard is what keeps genuine compounds: "Instructional Swim"
// (54) is not much rarer than "Instructional" (34) or "Swim" (68), so it
// survives. Without the guard this would reject the real activity along with
// the artifact.
const MERGE_RARITY = 3

export function looksLikeAMerge(name, counts) {
  const words = String(name ?? '').trim().split(/\s+/)
  if (words.length < 2) return false
  const whole = counts[name] ?? 0
  if (whole === 0) return false

  for (let split = 1; split < words.length; split++) {
    const left = words.slice(0, split).join(' ')
    const right = words.slice(split).join(' ')
    const leftCount = counts[left]
    const rightCount = counts[right]
    if (!leftCount || !rightCount) continue
    if (leftCount >= whole * MERGE_RARITY && rightCount >= whole * MERGE_RARITY) return true
  }
  return false
}

// §1 — real confidence on a CREATE. `seenCounts` is the same shape
// `proposal.seenCounts` already carries (extractEntities.js): `{ [entity]:
// countsByName, activityUnitShare: shareByNormalizedName }`. Additive-
// degradation: `seenCounts` omitted (any caller/fixture that predates this
// change, including the S4b enrichment-workbook path — Red Hat Risk 2/A4)
// degrades to today's behavior, every create tier 'new'.
//
// `locations` is the ONE unconditional exception (Q8 fold, A2/§2): it always
// classifies 'low' regardless of frequency, whatever `seenCounts` says —
// nothing is ever minted or bound to a place without an explicit
// `looks_right` resolution.
//
// A5 (Red Hat) — this is called ONLY from emitCreate below. Do not lift this
// into a helper emitRecognized also calls: an update/unchanged row must stay
// governed by identity tiers alone, never by frequency.
export function createConfidenceTier(entity, name, seenCounts) {
  if (entity === 'locations') return 'low'
  if (!seenCounts) return 'new'
  const counts = seenCounts[entity] ?? {}
  const shares = seenCounts.activityUnitShare ?? {}
  const shareOf = shares[normalizeName(name)] ?? 0
  const isHigh = !looksLikeAMerge(name, counts) && ((counts[name] ?? 2) >= 2 || shareOf >= 1)
  return isHigh ? 'new' : 'low'
}

// The tri-state CLEAR sentinel (type doc §3): a field present in the map with
// `to: CLEAR` means "remove", distinct from absent (leave untouched) and from
// `to: null` (a genuine null value). Unused by S0's create/unchanged arms; kept
// here so the `clear` arm has a real sentinel to key on in its later slice.
export const CLEAR = Symbol('clear')

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// S2c §3. A record field whose proposed value is a foreign-key LABEL is diffed
// against a DIFFERENT snapshot key that carries the live label form: the source
// speaks `eligible_groups` (group-name labels) / `unit` (a unit-name label), the
// snapshot exposes `eligible_group_names` / `unit_name`. buildPlan stays pure —
// it compares label-vs-label, never a resolved id (that happens at commit, §4).
const SNAPSHOT_KEY = Object.freeze({
  eligible_groups: 'eligible_group_names',
  unit: 'unit_name',
  location: 'location_name',
})

// S2c §3. eligible_groups diffs as an order-independent, normalized-name SET:
// same members in a different order is NOT a change. `proposed` is a list of
// group-name labels the source carries; `live` is the snapshot's set of live
// group names.
function sameNameSet(proposed, live) {
  const norm = (arr) => (Array.isArray(arr) ? arr : [])
    .map((n) => normalizeName(String(n)))
    .sort()
  const a = norm(proposed)
  const b = norm(live)
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// "08:40–09:00" / "9:15-9:40" -> { start_time, end_time }. Returns nulls when
// the label is not a range, which is normal — a period may be named "Block 2".
function parseTimeRange(label) {
  const match = String(label ?? '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/)
  if (!match) return { start_time: null, end_time: null }
  const pad = (h, m) => `${String(h).padStart(2, '0')}:${m}`
  return { start_time: pad(match[1], match[2]), end_time: pad(match[3], match[4]) }
}

// The fields each entity needs beyond its name, derived rather than guessed.
// PURE: it takes only the campId, the row's index (for sort_order / a
// day-of-week fallback), and the Program the director is importing into. A null
// `cohortId` yields a null cohort_id field, which the committer skips — exactly
// the pre-T33 behaviour. Moved verbatim out of ingest.js so buildPlan (renderer
// side, no DB) can shape the field-delta; ingest.test.js's behaviour is pinned
// by the golden-ops characterization test.
export function fieldsFor(entity, name, campId, index, cohortId) {
  switch (entity) {
    case 'cohorts':
      return { camp_id: campId, name }
    case 'tiers':
      return { camp_id: campId, name, sort_order: index, cohort_id: cohortId }
    case 'groups':
      return { camp_id: campId, name, availability: 'all' }
    case 'days_of_operation': {
      const dow = DAY_INDEX[String(name).trim().toLowerCase()]
      return {
        camp_id: campId,
        label: name,
        day_of_week: dow ?? index,
        sort_order: dow ?? index,
      }
    }
    case 'time_blocks': {
      const { start_time, end_time } = parseTimeRange(name)
      return { camp_id: campId, name, start_time, end_time, sort_order: index, cohort_id: cohortId }
    }
    case 'activities':
      return { camp_id: campId, name }
    // M4 §D1a: capacity/notes/sort_order/map_geometry are left to the schema's
    // own defaults, matching every other bare-minimum entity create (cohorts).
    // The id itself is NOT derived here — buildPlan is pure/DB-agnostic and
    // deriveLocationId lives in electron/ops/locationId.js; commitCreate mints
    // it at commit time (§D1a).
    case 'locations':
      return { camp_id: campId, name }
    default:
      throw new Error(`ingest: ${entity} is not an ingestible entity`)
  }
}

/**
 * PURE. No DB handle, no writes. Turns a normalized import source plus a
 * read-only snapshot of what the camp already has into a ReconciliationPlan.
 *
 * S0 source shape (the importer's own inputs): the director-confirmed create
 * set plus the auxiliary payloads the committer resolves against the live DB.
 *
 *   @param {Object} source
 *     - approved:       { [entity]: string[] }  the confirmed names to create
 *     - links:          { groups: { [groupName]: unitName } }
 *     - activityRules:  { [activityName]: rule }
 *     - fixedEvents:    FixedEvent[]  (resolved by name at commit)
 *     - camp_id, cohort_id, mode
 *   @param {Object|null} existing  { [entity]: [{ id, name }] } — names already
 *     in the camp become `unchanged` items (zero ops). Null/absent => every
 *     approved name is a `create`, which preserves the importer's blind-create
 *     path (a same-name collision surfaces at the UNIQUE constraint at commit,
 *     exactly as today).
 *   @param {Array} resolutions  T73 — a director's per-conflict decisions from a
 *     prior held commit. Only `ambiguous_identity` decisions are consumed here
 *     (they change which identity a label binds to, the pure-diff's concern);
 *     `stale` decisions are a commit-gate concern and are honored in commitPlan.
 *     Each is `{ entity, name, reason:'ambiguous_identity', choice:'existing',
 *     entity_id }` or `{ ..., choice:'create' }`. Indexed by the SAME
 *     normalizeName the rest of the path uses, so the key cannot disagree about
 *     "the same name" (ADR §2).
 *   @returns {ReconciliationPlan}
 */
// Slice 3a content-shape detector (docs/adr/2026-08-22-nested-schedules-
// electives-and-events.md §4 addendum; docs/work/specs/2026-08-22-electives-
// nested-schedule-slices.md). Create-shaped: no `{from,to}` field diff — no
// elective_set exists yet — so this is a distinct branch from emitCreate/
// fieldsFor above, not an extension of either. PURE: takes the header
// findings + per-activity period flags extractEntities.js already computed
// (both plain data, no DB), plus the live `activities` snapshot buildPlan
// already receives as `existing.activities` for every other entity's
// recognition.
//
// A candidate fires for an activity name that:
//   - survived isActivityLike (it is already in proposal entities.activities
//     — extractEntities only ever tallies names that passed that gate), AND
//   - matches NO live activities row via recognitionKey (the false-positive
//     guard: a name that resolves 1:1 to an existing catalog activity is
//     exempt by construction, no separate blocklist), AND
//   - every occurrence of it sat in a period/column the header detector did
//     NOT already flag (an occurrence already explained by a header finding
//     would otherwise double-nudge for the same period).
//
// Recorded as ONE opaque finding per name (the raw text), never split into
// fake offerings — ingest never invents an elective's roster of offerings.
export function buildElectiveCandidates(source, existing) {
  const headerFindings = Array.isArray(source?.electiveHeaderFindings) ? source.electiveHeaderFindings : []
  const activityPeriods = source?.activityPeriods && typeof source.activityPeriods === 'object' ? source.activityPeriods : {}
  // S2c: `approved.activities` is a list of records `{ name, fields?, clears? }`
  // (a bare string back-compat-normalizes to `{ name }`) — the SAME shape the
  // main buildPlan loop below reads, not the raw extractEntities `entities.
  // activities` tally (this function is called with the S2c-folded `source`,
  // never the raw proposal).
  const rawActivities = Array.isArray(source?.approved?.activities) ? source.approved.activities : []
  const proposedActivityNames = rawActivities
    .map((r) => String((r && typeof r === 'object' ? r.name : r) ?? '').trim())
    .filter(Boolean)

  const liveActivityKeys = new Set(
    (Array.isArray(existing?.activities) ? existing.activities : [])
      .filter((r) => r?.name)
      .map((r) => recognitionKey('activities', r.name))
  )

  // fix, panel round 2 (Red Hat + Code Reviewer) — the SAME false-positive
  // guard the shape detector below already applies, extended to the header
  // detector's cell-VALUE findings (extractEntities.js's `source: 'cell'`
  // tag): a cell value equal to an existing catalog activity's name (e.g. a
  // camp with a real, plain activity actually named "Electives") must never
  // nudge just because the text also matches ELECTIVE_HEADER_TERMS. A
  // row/column-LABEL finding (`source: 'label'`) never names an activity and
  // is exempt from this filter by construction — it always passes through.
  const headerFindingsFiltered = headerFindings.filter((f) => {
    if (f.source !== 'cell') return true
    return !liveActivityKeys.has(recognitionKey('activities', f.sourceExcerpt))
  })

  const shapeFindings = []
  for (const name of proposedActivityNames) {
    const key = normalizeName(name)
    const flags = activityPeriods[key]
    if (!Array.isArray(flags) || flags.length === 0) continue
    // Header-flagged in EVERY occurrence -> already fully explained by a
    // header finding; a name that shows up under an electives period AND
    // elsewhere still deserves its own shape finding for the unexplained rest.
    if (flags.every(Boolean)) continue
    if (liveActivityKeys.has(recognitionKey('activities', name))) continue // false-positive guard
    shapeFindings.push({ detector: 'shape', band: 'inferred', sourceExcerpt: name, row: null, column: null })
  }

  // Dedup the decision id by column-signature (ADR §4 addendum) so a prior
  // decline doesn't re-surface across a re-import of the same file: the
  // signature is the detector + the exact text the file printed, which is
  // stable across re-imports of an unchanged source and distinct for two
  // different periods/columns.
  // fix, panel round 2 (Red Hat) — dedup CASE-INSENSITIVELY: "Chugim" and
  // "CHUGIM" are the same period spelled two ways, not two candidates (and,
  // downstream, must not become two elective_sets — see
  // commitElectiveCandidates' matching normalization). The signature key is
  // normalized for comparison only; the id itself, and the stored
  // sourceExcerpt, keep the FIRST-seen raw casing (a decline/re-import
  // dedup id must still stay stable across an unchanged file).
  const all = [...headerFindingsFiltered, ...shapeFindings]
  const seenKeys = new Set()
  const candidates = []
  for (const finding of all) {
    const key = `${finding.detector}:${normalizeName(finding.column ?? '')}:${normalizeName(finding.sourceExcerpt)}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const id = `${finding.detector}:${finding.column ?? ''}:${finding.sourceExcerpt}`
    candidates.push({ id, ...finding })
  }

  // fix, panel round 2 (Red Hat, "unbounded nudges") — a pathological file
  // can produce hundreds of shape-detector hits (every unrecognized activity
  // name is a candidate). Cap at a sane limit rather than silently truncating
  // (house rule: never silent): the excess is dropped, but `.truncated` on
  // the returned array says so — reconciliationReport.js turns it into one
  // acknowledgeable decision, never a phantom elective-candidate card (a cap
  // note is not itself a period to create a set for).
  const ELECTIVE_CANDIDATE_CAP = 25
  if (candidates.length > ELECTIVE_CANDIDATE_CAP) {
    const kept = candidates.slice(0, ELECTIVE_CANDIDATE_CAP)
    kept.truncated = { total: candidates.length, shown: ELECTIVE_CANDIDATE_CAP }
    return kept
  }
  return candidates
}

export function buildPlan(source, existing = null, resolutions = []) {
  const approved = source?.approved ?? {}
  const links = source?.links ?? {}
  const activityRules = source?.activityRules ?? {}
  const groupUnits = links?.groups ?? {}
  const campId = source?.camp_id ?? null
  const cohortId = source?.cohort_id ?? null
  const have = existing ?? {}
  // §1 — real create confidence input (OQ1: named seenCounts, reusing
  // proposal.seenCounts's own shape verbatim rather than a separate
  // pre-classified verdict).
  const seenCounts = source?.seenCounts ?? null
  // A3 (HARD BLOCKER, Red Hat) — the pin-only/dual-use guard's buildPlan-side
  // carry. ImportScreen.jsx's dualUseActivityNames/pinOnlyActivityNames used
  // to gate this at the deleted tick step (ADR 2026-08-09 Decision 1): a
  // fixed-event name that is NOT also a free activity choice must never
  // silently mint into the activity catalog. A name in this set forces
  // tier:'low' regardless of frequency, so it always requires an explicit
  // director resolution instead of reaching tier:'new'.
  const pinOnlyActivityNames = new Set(
    Array.isArray(source?.pinOnlyActivityNames) ? source.pinOnlyActivityNames.map((n) => normalizeName(n)) : []
  )
  // ADR 2026-08-09 Decision 2 — which fields on which items are director-
  // authored (not the file's), so commitCreate/commitUpdate stamp
  // source:'human' instead of 'import' on just those. Normalized to STORED
  // column names once here (dbFieldFor), so every downstream comparison
  // (both the clear path and the set path) uses one consistent name.
  const humanEditedFields = source?.humanEditedFields ?? {}
  const humanFieldsFor = (entity, name) =>
    (humanEditedFields?.[entity]?.[name] ?? []).map((f) => dbFieldFor(f))

  // T73: index the ambiguous-identity resolutions by entity|recognitionKey(name).
  // M4 §D3: keyed by recognitionKey (entity-aware), not bare normalizeName — a
  // no-op for every entity but locations, where ambiguous_identity is
  // structurally unreachable anyway (UNIQUE(camp_id, name) exact-match), kept
  // consistent for the same reason every other recognition-map site is.
  const ambiguousRes = new Map()
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    if (!r || r.reason !== 'ambiguous_identity') continue
    ambiguousRes.set(`${r.entity}|${recognitionKey(r.entity, r.name)}`, r)
  }
  const resolutionFor = (entity, name) => ambiguousRes.get(`${entity}|${recognitionKey(entity, name)}`)

  const items = []

  for (const entity of INGESTIBLE_ENTITIES) {
    const names = Array.isArray(approved[entity]) ? approved[entity] : []
    // A LIST of rows per normalized key, not a single row (S1a §3). Two live
    // rows whose raw names differ but normalize to the same string ("Art" /
    // "art ") both legally exist under UNIQUE(camp_id, name); the old single-
    // valued Map let the last one silently overwrite the first, auto-picking an
    // identity no human saw. Keeping every colliding row makes the ambiguity a
    // detectable conflict instead.
    const already = new Map()
    // S4b §2: a live-row index by id, for the top-of-hierarchy uuid match. A
    // workbook row carrying a `shoresh_id` matches its entity directly here and
    // never re-runs name ambiguity — the round-trip guarantee.
    const byId = new Map()
    for (const r of Array.isArray(have[entity]) ? have[entity] : []) {
      if (!r) continue
      if (r.id != null) byId.set(String(r.id), r)
      if (!r.name) continue
      const key = recognitionKey(entity, r.name)
      if (!already.has(key)) already.set(key, [])
      already.get(key).push(r)
    }

    // `index` is the raw position in the approved array — blanks consume an
    // index but produce no item, matching commitIngest's forEach (sort_order
    // is derived from this index, so it must be the raw one).
    names.forEach((rawEl, index) => {
      // S2c §1. A row is a RECORD `{ id?, name, fields?, clears? }`. For
      // back-compat a bare string is normalized to `{ name }` (the schedule /
      // clipboard callers, and every existing direct buildPlan test, pass
      // strings). buildPlan sees only records from here down.
      const record = rawEl && typeof rawEl === 'object' ? rawEl : { name: rawEl }
      const name = String(record?.name ?? '').trim()
      if (!name) return
      // Only the values the source EXPLICITLY carries. A field absent from
      // `fields` is "preserve" (never diffed, never cleared) — the load-bearing
      // blank-vs-clear default is now structural (S2c §1).
      const recFields = record.fields && typeof record.fields === 'object' ? record.fields : {}

      // S2c §2: a recognized entity's diff is built from `record.fields` ONLY —
      // the values the source explicitly supplies. It NO LONGER calls fieldsFor,
      // so no index-derived field (sort_order) can enter a recognized diff: a
      // re-order produces no delta (RISK E). An entity whose supplied fields all
      // equal live stays `unchanged` (zero ops), preserving F4.
      // S4b §3: explicit `<clear>` tokens the workbook adapter recorded on this
      // record. Each names an editable field to remove (to: CLEAR). A never-set
      // field is no-op'd at commit (it has no live value to remove) — buildPlan
      // still emits the delta; commitPlan decides the no-op against the op-log.
      const recClears = Array.isArray(record.clears) ? record.clears : []

      // `tier` is 'exact_name' for a name-matched row and 'uuid' for an
      // id-matched (round-trip) row — the evidence tag the plan carries.
      const emitRecognized = (match, tier = 'exact_name') => {
        const nameCol = entity === 'days_of_operation' ? 'label' : 'name'
        const fields = {}
        for (const [field, proposed] of Object.entries(recFields)) {
          // Blank/absent in the source → preserve, never diff and never clear
          // (MATCH_AND_MERGE_SEMANTICS §3). An empty eligibility set is likewise
          // "I don't carry this" here, not "restrict to nothing" (S4b clears).
          if (proposed === null || proposed === undefined || proposed === '') continue
          if (Array.isArray(proposed) && proposed.length === 0) continue
          // FK-label fields diff against their snapshot label form (§3); scalars
          // against a same-named snapshot column. A key the snapshot doesn't
          // carry can't be diffed, so it is preserved.
          const snapKey = SNAPSHOT_KEY[field] ?? field
          if (!(snapKey in match)) continue
          const live = match[snapKey]
          let same
          if (field === 'eligible_groups') {
            same = sameNameSet(proposed, live)
          } else if (field === 'unit') {
            same = normalizeName(String(live ?? '')) === normalizeName(String(proposed))
          } else if (field === nameCol) {
            // The identity matched via recognitionKey, so a raw-form difference
            // ('art ' vs 'Art') is the SAME entity, not an update — UNLESS the
            // entity is locations, where recognitionKey is itself exact/
            // case-sensitive, so this degrades to a plain string compare there
            // (a genuine rename, not a spelling variant, is still an update).
            same = recognitionKey(entity, live) === recognitionKey(entity, proposed)
          } else {
            same = live === proposed
          }
          if (same) continue
          fields[field] = { from: live ?? null, to: proposed, source: 'import' }
        }

        // S4b §3: fold the `<clear>` tokens into CLEAR deltas. The delta's `from`
        // is the live value (FK fields diff against their snapshot label form).
        // The commit gate decides per field: a never-set field no-ops, a
        // human-authored field holds (a clear is gated ≥ an update).
        for (const cf of recClears) {
          const snapKey = SNAPSHOT_KEY[cf] ?? cf
          const live = snapKey in match ? match[snapKey] : null
          fields[cf] = { from: live ?? null, to: CLEAR, source: 'import' }
        }

        const hasRegular = Object.values(fields).some((d) => d.to !== CLEAR)
        const hasClear = Object.values(fields).some((d) => d.to === CLEAR)

        if (hasRegular) {
          items.push({
            op: 'update',
            entity,
            entity_id: match.id,
            fields,
            evidence: { tier, matched_name: match.name },
            _name: name,
            _humanFields: humanFieldsFor(entity, name),
            // B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): the
            // SAME inferred-rule support emitCreate attaches, so a recognized
            // (re-imported) activity's evidence stays current too. Unused by
            // any field-diff logic above — evidence-only.
            ...(entity === 'activities' ? { _rule: activityRules?.[name] } : {}),
          })
          return
        }

        // A row whose ONLY deltas are clears is op:'clear' (ADR §3); commitPlan
        // routes it through the same per-field gate as update.
        if (hasClear) {
          items.push({
            op: 'clear',
            entity,
            entity_id: match.id,
            fields,
            evidence: { tier, matched_name: match.name },
            _name: name,
            _humanFields: humanFieldsFor(entity, name),
            // B4: same evidence-only carry as the 'update' arm above — a
            // clear-only re-import must still upsert evidence (Grader round-1
            // HIGH finding: this arm was silently exempt). Never read by any
            // value-write path.
            ...(entity === 'activities' ? { _rule: activityRules?.[name] } : {}),
          })
          return
        }

        // Resolved to a live entity, nothing differs. Zero-op arm (type doc b).
        items.push({
          op: 'unchanged',
          entity,
          entity_id: match.id,
          fields: {},
          evidence: { tier, matched_name: match.name },
          // Carried so the committer can re-resolve this identity against the
          // live DB (the review window may have deleted match.id).
          _name: name,
          // B4: see the 'update' arm above — same evidence-only carry, so a
          // re-import that recognizes an activity as unchanged still upserts
          // its evidence (the source's observation may differ even when the
          // confirmed value didn't move).
          ...(entity === 'activities' ? { _rule: activityRules?.[name] } : {}),
        })
      }

      const emitCreate = () => {
        const raw = fieldsFor(entity, name, campId, index, cohortId)
        const fields = {}
        for (const [field, value] of Object.entries(raw)) {
          fields[field] = { from: null, to: value, source: 'import' }
        }
        const tier = entity === 'activities' && pinOnlyActivityNames.has(normalizeName(name))
          ? 'low'
          : createConfidenceTier(entity, name, seenCounts)
        const item = {
          op: 'create',
          entity,
          entity_id: null,
          fields,
          evidence: { tier },
          // Commit-resolution inputs — pure data the committer binds against the
          // live name->id maps (ADR §4). buildPlan cannot resolve them (no DB).
          _name: name,
          // ADR 2026-08-09 Decision 2 — honored on CREATE too: a director's
          // hand-picked unit on a brand-new group must be 'human' from its
          // very first write, or a later re-import's differing file-inferred
          // value would freely overwrite it (no prior 'human' op to protect).
          _humanFields: humanFieldsFor(entity, name),
        }
        // Commit-resolution inputs. S2c: the record carries these in `fields`
        // (the adapter folded the side-channels there); a direct caller passing
        // bare strings still relies on the source-level side-channels, so fall
        // back to them. Reconstructed into the exact `_rule`/`_link_unit` shape
        // commitCreate already consumes, so the create op sequence is unchanged.
        if (entity === 'groups') {
          item._link_unit = recFields.unit ?? groupUnits[name]
        }
        if (entity === 'activities') {
          if ('min_per_week' in recFields || 'max_per_week' in recFields
              || 'priority' in recFields || 'eligible_groups' in recFields
              // M4 §D1c: a create's location, like unit on a group, travels via
              // the _rule side-channel (never `fields` directly) — foldApprovedToRecords
              // already merges activityRules[name].location into recFields.location
              // when the source didn't carry its own; the S4 workbook path sets
              // recFields.location directly. Either way it lands here.
              || 'location' in recFields) {
            item._rule = {
              min_per_week: recFields.min_per_week,
              max_per_week: recFields.max_per_week,
              priority: recFields.priority,
              eligible_group_names: recFields.eligible_groups,
              location: recFields.location,
              // B4: the side-channel's own support/eligibility-known survive
              // the fold too (evidence-only — nothing above this key changes).
              eligibility_known: activityRules?.[name]?.eligibility_known,
              support: activityRules?.[name]?.support,
            }
          } else {
            item._rule = activityRules?.[name]
          }
        }
        items.push(item)
      }

      // S4b §2: workbook-detected id hazards the adapter flagged (duplicate
      // shoresh_id / a blank-id row whose name was an exported entity). Held,
      // never matched or created — the accepted-reason set in commitPlan routes
      // them to conflicts (no throw).
      if (record._workbookConflict) {
        items.push({
          op: 'conflict',
          entity,
          entity_id: null,
          reason: record._workbookConflict.reason,
          fields: {},
          evidence: { tier: 'uuid' },
          _name: name,
        })
        return
      }

      // S4b §2: the uuid match tier, AHEAD of the name hierarchy. A row carrying
      // a `shoresh_id`:
      //   - present in the snapshot  → matched directly (field diff → unchanged/
      //     update/clear), evidence.tier 'uuid'. No name-ambiguity is ever run.
      //   - NOT in the snapshot      → op:'conflict' reason 'missing_target'
      //     (surfaced, never silently downgraded to a create — that would
      //     duplicate an entity the director meant to edit).
      const recId = record.id != null && String(record.id).trim() !== ''
        ? String(record.id).trim() : null
      if (recId) {
        const match = byId.get(recId)
        if (match) { emitRecognized(match, 'uuid'); return }
        items.push({
          op: 'conflict',
          entity,
          entity_id: recId,
          reason: 'missing_target',
          fields: {},
          evidence: { tier: 'uuid' },
          _name: name,
        })
        return
      }

      // S1b §4: the confirmed-alias tier, ranked above exact-name, below uuid.
      // `have.aliases` is the host-local read buildExistingSnapshot attaches
      // to the snapshot (electron/ops/ingest.js's listAliasMap) — buildPlan
      // stays pure, it only reads the map out of the object it was handed.
      // Absent (mode 'replace', or a caller with no alias support) leaves
      // this branch inert.
      const aliasEntityId = have.aliases?.[entity]?.get(normalizeName(name)) ?? null
      if (aliasEntityId) {
        const aliasMatch = byId.get(aliasEntityId)
        // listAliasMap already filters to live targets, so this should always
        // resolve; a stale/foreign id (defense-in-depth) simply falls through
        // to the ordinary name hierarchy below.
        if (aliasMatch) {
          const exactMatches = already.get(recognitionKey(entity, name)) ?? []
          if (exactMatches.length === 0) {
            emitRecognized(aliasMatch, 'confirmed_alias')
            return
          }
          // The alias target IS the (sole) exact-name match too — consistent,
          // no divergence. Fall through to the ordinary hierarchy below, which
          // resolves this identically (tier 'exact_name').
          const diverges = exactMatches.some((m) => m.id !== aliasEntityId)
          if (diverges) {
            // The world disagrees with the alias: label->A (the alias) but a
            // live, different-entity exact-name match B also exists. Never
            // silently pick either side — surface both (ADR §4).
            items.push({
              op: 'conflict',
              entity,
              entity_id: null,
              reason: 'alias_divergence',
              fields: {},
              evidence: {
                tier: 'confirmed_alias',
                candidates: [
                  { id: aliasEntityId, name: aliasMatch.name, source: 'alias' },
                  ...exactMatches.map((m) => ({ id: m.id, name: m.name, source: 'exact_name' })),
                ],
              },
              _name: name,
            })
            return
          }
        }
      }

      const matches = already.get(recognitionKey(entity, name)) ?? []
      if (matches.length > 1) {
        // One incoming label, more than one live row normalize-matching it.
        // T73: if the director already resolved this ambiguity, honor the pick
        // through the SAME pure diff (pin to the chosen row) or the create arm,
        // so no re-ambiguation. Otherwise never auto-pick (§3); surface every
        // candidate for review.
        const res = resolutionFor(entity, name)
        if (res?.choice === 'existing' && res.entity_id) {
          const pinned = matches.find((m) => m.id === res.entity_id)
          if (pinned) { emitRecognized(pinned); return }
          // The pinned candidate is gone from the live snapshot (peer deleted
          // it in the window) — fall through to re-hold as a fresh conflict.
        } else if (res?.choice === 'create') {
          emitCreate()
          return
        }
        items.push({
          op: 'conflict',
          entity,
          entity_id: null,
          reason: 'ambiguous_identity',
          fields: {},
          evidence: {
            tier: 'exact_name',
            candidates: matches.map((m) => ({ id: m.id, name: m.name })),
          },
          _name: name,
        })
        return
      }
      if (matches.length === 1) { emitRecognized(matches[0]); return }
      emitCreate()
    })
  }

  return {
    plan_version: 1,
    camp_id: campId,
    cohort_id: cohortId,
    // S4b §4: the workbook's exported base_generation (op-log seq at export) so
    // commitPlan can gate import-over-import staleness. 0 for a raw schedule
    // source, which keeps the clock gate inert exactly as before.
    base_generation: source?.base_generation ?? 0,
    sources: [{ source: 'import', family: 'schedule' }],
    items,
    unresolved: [],
    // S0 commit directives carried as data (the plan is the whole commit input).
    mode: source?.mode ?? 'add',
    fixedEvents: Array.isArray(source?.fixedEvents) ? source.fixedEvents : [],
    // Slice 3a — create-shaped elective nudges, never entity `items` (no
    // elective_set exists yet to diff fields against).
    electiveCandidates: buildElectiveCandidates(source, existing),
  }
}
