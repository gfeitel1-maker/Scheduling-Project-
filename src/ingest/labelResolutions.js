// HOW A DIRECTOR SETTLES A LABEL THE CATALOG COULD NOT RESOLVE (T298).
//
// Slice 1 shipped one resolution — mint the activity — and said in
// `ParseSummary.jsx` why the other was absent: "Map it to an existing activity
// is a real decision and is NOT here — it needs a picker and a proposal rule,
// and half of it rendered as a disabled affordance would look finished while
// doing nothing." This is the picker's proposal rule, and the vocabulary both
// resolutions share.
//
// THREE RESOLUTIONS, and they are exhaustive over what a director can mean:
//
//   ADD_ACTIVITY    the camp should have this activity. Mints it, and the
//                   sheet's rows for it become readable. Slice 1's action,
//                   named here rather than spelled out at each call site.
//   MAP_TO_EXISTING the camp already has this activity under another spelling.
//                   Mints NOTHING; the label reads as the camp's own name, so
//                   the preferences land on the activity that exists.
//   SPLIT_PACKED    the cell packed several choices into one. Reads it as its
//                   parts, each of which the catalog already knows.
//
// There is deliberately no fourth for "leave it alone": that is already what
// happens to an unresolved label, so a control for it would be inert and the
// standing rule forbids that. And there is no separate "read this packed cell as
// ONE name" either — saying so IS choosing ADD_ACTIVITY or MAP_TO_EXISTING for
// the whole cell, which is why those two take precedence over packed detection
// in the resolver rather than needing a state of their own.
import { findConnectorVariant, findNameVariantCandidates } from './nearDuplicateNames.js'

export const RESOLUTION = Object.freeze({
  ADD_ACTIVITY: 'add_activity',
  MAP_TO_EXISTING: 'map_to_existing',
  SPLIT_PACKED: 'split_packed',
})

/**
 * THE PROPOSAL, and the whole design constraint on it is that it PROPOSES.
 *
 * `nearDuplicateNames.js` is the right module to reach for and says why in its
 * own header: it is the only one in this directory whose bias is PRECISION
 * rather than recall, because a wrong proposal here costs a director a judgement
 * call about two names that were never related. Edit distance is explicitly
 * rejected there and stays rejected here.
 *
 * Two rules, strongest first, and a null third answer that is not a failure: the
 * picker opens either way and lists every activity the camp has. A proposal is a
 * shortcut past scrolling, never the only way through.
 *
 * @param {string} label             the spelling the FILE used.
 * @param {string[]} existingNames   the camp's own activity names.
 * @returns {{name: string, rule: 'connector'|'word-form'}|null}
 */
export function proposeActivityMatch(label, existingNames = []) {
  const raw = typeof label === 'string' ? label.trim() : ''
  if (!raw) return null
  const names = existingNames.filter((n) => typeof n === 'string' && n.trim())

  // "Arts and Crafts" against "Arts & Crafts". Equality once the connector is
  // folded, so it asserts nothing about spelling — the strongest of the two.
  const connector = findConnectorVariant(raw, names)
  if (connector) return { name: connector, rule: 'connector' }

  // "Swim Return" against "Swim Returning". Stem plus a grammatical suffix.
  // Counts are 0/0 on purpose: `findNameVariantCandidates` uses frequency to
  // elect which spelling SURVIVES a merge, and that question is not live here —
  // the camp's own name survives by construction, because it is the one that
  // exists. So the pair is read only for whether it pairs at all.
  const pairs = findNameVariantCandidates([{ name: raw, count: 0 }, ...names.map((name) => ({ name, count: 0 }))])
  for (const pair of pairs) {
    if (pair.canonical === raw && names.includes(pair.variant)) return { name: pair.variant, rule: 'word-form' }
    if (pair.variant === raw && names.includes(pair.canonical)) return { name: pair.canonical, rule: 'word-form' }
  }
  return null
}

/**
 * The director's settled resolutions, in the shape `parsePreferenceSheet` reads.
 *
 * Keyed on the RAW label the file wrote, because that is what the resolver has
 * in hand when it needs the answer. One entry per label, not per cell: forty
 * rows naming "Arts and Crafts" are one decision, and this is the data structure
 * that makes that true rather than a claim the UI makes on its own.
 *
 * @param {Array<{label: string, action: string, activityName?: string}>} list
 * @returns {Record<string, {action: string, activityName: string|null}>}
 */
export function resolutionMap(list = []) {
  const out = {}
  for (const item of list) {
    if (!item?.label || !item?.action) continue
    // A mapping with no target is not a resolution, it is an unfinished one.
    // Dropping it here means the resolver never has to ask whether its own
    // inputs make sense.
    if (item.action === RESOLUTION.MAP_TO_EXISTING && !item.activityName) continue
    out[item.label] = { action: item.action, activityName: item.activityName ?? null }
  }
  return out
}
