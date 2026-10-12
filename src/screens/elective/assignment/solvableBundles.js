// T219: an imported double-period elective links each of its choices with a bundle, and the
// import's choices are POTENTIAL until the director confirms them. The solve sees a bundle only
// when its choice is a confirmed offering of its set, by the same rule buildOfferings uses for
// the offerings themselves, so a linked choice never reaches campers before the director has
// vouched for it. The bundle editor still shows every bundle.
import { isConfirmed } from './buildOfferings.js'

export function solvableBundles({ bundles = [], bundlePeriods = [], bundleTiers = [], offerings = [] }) {
  const confirmed = new Set(offerings.filter(isConfirmed).map((o) => `${o.elective_set_id}\u0000${o.activity_id}`))
  const kept = bundles.filter((b) => confirmed.has(`${b.elective_set_id}\u0000${b.activity_id}`))
  const ids = new Set(kept.map((b) => b.id))
  return {
    bundles: kept,
    bundlePeriods: bundlePeriods.filter((p) => ids.has(p.bundle_id)),
    bundleTiers: bundleTiers.filter((t) => ids.has(t.bundle_id)),
  }
}
