// A camp's remembered column mapping — the match key, the stored payload, and
// the drift rule. T312, slice of T281 (umbrella T278; ADR §6, §6.0, §6.3).
//
// PURE. No db, no IPC, no file reading. The persistence half is an ordinary
// synced entity written through the normal write path; this module decides only
// WHAT is remembered and WHETHER a remembered thing applies to the file in hand.
//
// THE PRIVACY CONSTRAINT IS A PROPERTY OF THE SIGNATURE, NOT OF CARE. ADR §6.0
// rules — as a privacy matter rather than a design preference — that the
// match/drift key be derived from header text and geometry ONLY, never from cell
// contents: a fingerprint over cells would cache children's names into a table
// this design REPLICATES, turning a layout memo into a covert roster. Every
// function here takes header strings and a mapping of roles. None takes rows.
// That is deliberate: the constraint cannot be violated by a later edit without
// changing a signature, which is a thing a reviewer sees.
import { normalizeName } from './preview.js'
import { mappingWithDirectorOverride, describeMappingReadiness } from './preferenceSheet.js'

// The one `kind` this slice writes and reads. T281's day/period axis half will
// add its own to the same table rather than a second one.
export const COLUMN_ROLES_KIND = 'preference_column_roles'

// The canonical spelling of a header, for both the key and the lookup. ONE
// definition, because a key that normalises differently from the lookup would
// match a binding it then could not resolve. `normalizeName` is imported rather
// than re-spelled for the same reason `electiveChoiceLabelKey` imports
// `whitespaceInsensitiveName`: a duplicated normalisation rule is a rule that
// drifts.
const headerKey = (h) => normalizeName(h)

/**
 * A stable token for the SET of headers a binding names.
 *
 * Sorted, so a reordered sheet is the same sheet. Over the ROLED headers only —
 * not the whole header row — which is what delivers ADR §0 premise 4: a file
 * that gains an unrelated `Notes` column still matches, because every column the
 * binding actually names is still present.
 *
 * The same multi-base FNV-1a construction `submissionKeyFromRows` uses, for the
 * same reason: it needs no `node:crypto`, so this runs unchanged in the renderer
 * where the import panel lives. The output is `[A-Za-z0-9-]`, which matters
 * because this token is an id COMPONENT and `opaque()` in electiveDerivedIds
 * rejects whitespace, punctuation and non-ASCII — see `headerMatchKey` in
 * `deriveCampSeedlingId`.
 */
export function headerMatchKey(headers = []) {
  const text = headers
    .map(headerKey)
    .filter((h) => h !== '')
    .sort()
    .join('\u0000')
  const BASES = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9]
  const words = BASES.map((base) => {
    let h = base
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  })
  return `hdr-${words.join('')}`
}

// The roles a binding remembers, as (payload field, mapping field) pairs. The
// rank columns are handled separately because they are a list rather than a
// single index.
const SINGLE_ROLES = [
  ['name', 'nameIndex'],
  ['externalId', 'externalIdIndex'],
  ['division', 'divisionIndex'],
]

/**
 * What to remember from a mapping the director just confirmed.
 *
 * Returns `{ matchKey, payload }`, or null when there is nothing worth keeping.
 *
 * THE PAYLOAD IS KEYED BY HEADER TEXT, NEVER BY COLUMN INDEX, and that is the
 * whole mechanism rather than a storage preference. A binding holding
 * `nameIndex: 0` breaks the moment anyone inserts a column, which is precisely
 * the case §0 premise 4 promises to survive. Storing the header means the index
 * is looked up fresh against whatever file arrives next.
 */
export function bindingFromMapping(mapping, header = []) {
  // A mapping with no camper-name column is not a reading of a preference sheet,
  // so there is nothing to remember about it.
  if (!mapping || mapping.nameIndex == null) return null

  const at = (i) => (i == null ? null : String(header[i] ?? '').trim() || null)

  const payload = { name: at(mapping.nameIndex), externalId: null, division: null, ranks: [] }
  if (payload.name == null) return null

  for (const [field, index] of SINGLE_ROLES.slice(1)) {
    payload[field] = at(mapping[index])
  }

  for (const r of mapping.rankColumns ?? []) {
    const h = at(r.index)
    // A rank whose column has no header text cannot be remembered by text, and
    // remembering it by index is the failure this design exists to avoid. The
    // whole binding is dropped rather than kept with a hole in it — a partial
    // binding is the narrowing P38 punishes.
    if (h == null) return null
    payload.ranks.push({ rank: r.rank, header: h })
  }
  if (payload.ranks.length === 0) return null

  const named = [payload.name, payload.externalId, payload.division, ...payload.ranks.map((r) => r.header)]
  return { matchKey: headerMatchKey(named.filter(Boolean)), payload }
}

/**
 * Apply a remembered binding to the header row of the file in hand.
 *
 * Returns the role assignments to pre-fill, or **null** when the binding does
 * not describe this file.
 *
 * NULL IS THE IMPORTANT RETURN. A binding that applies its surviving half is
 * exactly P38: renaming one rank header `#3` → `Third Choice` between two
 * imports dropped rank 3 for thirteen campers with `ok=true` and nothing said.
 * So every header the binding names must be present and unambiguous, or the
 * whole thing is void and the director is asked. There is no partial recall.
 */
export function mappingFromBinding(payload, header = []) {
  if (!payload) return null

  // Built once, and it records AMBIGUITY rather than last-wins: two columns
  // sharing a remembered header cannot be resolved to one index without guessing
  // which the director meant, and guessing is what this module does not do.
  const byHeader = new Map()
  header.forEach((h, index) => {
    const k = headerKey(h)
    if (k === '') return
    byHeader.set(k, byHeader.has(k) ? 'ambiguous' : index)
  })
  const find = (text) => {
    const hit = byHeader.get(headerKey(text))
    return hit === undefined || hit === 'ambiguous' ? null : hit
  }

  const out = { nameIndex: null, externalIdIndex: null, divisionIndex: null, rankColumns: [] }

  for (const [field, index] of SINGLE_ROLES) {
    const text = payload[field]
    // A role the binding did not name stays unset; a role it DID name and cannot
    // find is drift. The director said that column was the division, so a file
    // without it is not the file they described.
    if (text == null) continue
    const i = find(text)
    if (i == null) return null
    out[index] = i
  }
  if (out.nameIndex == null) return null

  for (const r of payload.ranks ?? []) {
    const i = find(r.header)
    if (i == null) return null
    out.rankColumns.push({ rank: r.rank, index: i })
  }
  if (out.rankColumns.length === 0) return null

  out.rankColumns.sort((a, b) => a.rank - b.rank)
  return out
}

/**
 * The mapping to pre-fill, from what this camp has confirmed before — or null.
 *
 * NULL MEANS "ASK THE DIRECTOR", and every path to it is deliberate: no
 * seedling, a superseded one, another `kind`, a payload that will not parse, a
 * drifted sheet, or a recall that does not survive the readability gate.
 *
 * THE RECALL IS RUN THROUGH THE SAME GATES A FRESH CORRECTION IS
 * (`mappingWithDirectorOverride` then `describeMappingReadiness`), which T281's
 * archive_when requires in those words: a binding that no longer fits re-asks
 * rather than silently narrowing. Two distinct things could otherwise reach the
 * screen — a mapping the transform cannot read, and one carrying two roles on
 * one column — and a pre-filled screen that still cannot be confirmed is worse
 * than an empty one, because the director cannot tell what to change.
 *
 * `inferred` supplies the shape fields (`headerIndex`, `splitName`,
 * `longFormat`, `invertedMatrix`) the binding does not remember. Those are
 * properties of the FILE in hand, re-derived every time; only the ROLES come
 * from memory. Anything the gates then drop — an inverted matrix, once the
 * remembered rank columns are supplied — is dropped for the same reason it would
 * be on a hand correction.
 */
export function recallColumnMapping(seedlings = [], header = [], inferred = null) {
  for (const s of seedlings) {
    if (!s || s.kind !== COLUMN_ROLES_KIND || s.status !== 'active') continue

    let payload
    try {
      payload = typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload
    } catch {
      // A payload that will not parse is not a reason to fail the import; it is
      // a reason not to offer a recall. The director maps by hand, exactly as
      // they would have without it.
      continue
    }

    const roles = mappingFromBinding(payload, header)
    if (!roles) continue

    // The header is placed AT its own index, not at row 0. `mappingWithDirectorOverride`
    // reads `rows[headerIndex]` to recompute `unrecognisedColumns`, so handing it a
    // one-element array would look correct on a sheet whose table starts at row 1 and
    // silently report NOTHING as unread on one with a title line above it — the same
    // row-0 assumption T285 slice A removed from the locator and T307 removed from the
    // corrector's own options list.
    const rows = []
    rows[inferred?.headerIndex ?? 0] = header
    const candidate = mappingWithDirectorOverride({ ...(inferred ?? {}), ...roles }, rows)
    if (!candidate) continue
    const { unmapped, collision } = describeMappingReadiness(candidate)
    if (unmapped.length > 0 || collision) continue

    return { ...candidate, recalledFromId: s.id ?? null }
  }
  return null
}
