// Audit E6 (2026-10-10) — how many RANKED CHOICES on the sheet named an activity
// this elective set does not offer. The parse summary's "2 choices, 105
// preferences" counted only what landed; this is the other half, stated so the
// director does not have to infer it from the gap.
//
// Two sources, both facts the parse already produced:
//   - a preference whose label is a CAMP activity, but not one offered in this set
//     (compared by `electiveChoiceLabelKey`, the key preferences and offerings
//     already share);
//   - an UNRESOLVED_CHOICE_LABEL residue item: a cell naming an activity the camp
//     does not have at all, which therefore is not offered here either.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

export function countRankedNotOffered(parsed, offeredNames = []) {
  if (!parsed) return 0
  const offered = new Set(offeredNames.filter(Boolean).map((n) => electiveChoiceLabelKey(n)))
  const outside = (parsed.preferences ?? []).filter((p) => {
    const key = p.labelKey ?? (p.label != null ? electiveChoiceLabelKey(p.label) : null)
    return key != null && !offered.has(key)
  }).length
  const unknown = (parsed.residue ?? []).filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL').length
  return outside + unknown
}
