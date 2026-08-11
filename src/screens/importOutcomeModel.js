// D4 — the post-import success banner's readiness handoff. Pure, React-free
// so it can be tested without mounting ImportScreen (mirrors
// readinessHubModel.js's split from ReadinessHub.jsx).
//
// docs/adr/2026-08-10-ingestion-phaseD-experience.md §"Setup Readiness
// integration (D4)".
//
// This does NOT re-derive readiness — it reads the same getReadiness rows
// every other surface reads (readiness.js, ReadinessHub.jsx) and only adds
// the sentence describeReadiness has no reason to say: which optional areas
// are still unconfigured, framed as absent rather than wrong. The blocking
// "Ready to build a week." / "N things still needed..." line stays
// describeReadiness's job — this helper never restates it.

/**
 * A calm sentence naming optional areas (kind 'optional' or 'forward') that
 * are in state 'optional' (present but unconfigured — never 'missing', which
 * is structurally impossible for these kinds). Returns null when there is
 * nothing to name, so a caller can omit the line entirely rather than render
 * an empty one.
 */
export function describeOptionalGaps(readiness) {
  const rows = Array.isArray(readiness) ? readiness : []
  const absent = rows.filter((r) => r.kind !== 'required' && r.state === 'optional')
  if (absent.length === 0) return null

  const names = absent.map((r) => r.label)
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  return names.length === 1
    ? `${list} isn't set up yet — optional, add it whenever you're ready.`
    : `${list} aren't set up yet — optional, add them whenever you're ready.`
}
