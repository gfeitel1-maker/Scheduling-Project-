import { DOMAINS } from './domainRollup.js'

// Pure — no DOM, no timers. Turns per-domain unresolved counts into the
// calm/attention verdict per row plus the one dynamic sentence that carries
// the meaning of the reveal. Split out of ReconstructionMoment.jsx so the
// grammar cases are unit-testable directly and react-refresh's
// only-export-components rule stays happy (component files may only export
// components).

const DOMAIN_LABELS = {
  Structure: 'Structure',
  Scheduling: 'Scheduling Model',
  Time: 'Time',
  Facility: 'Facility & Resources',
}

// Root-map port (docs/adr/2026-08-18-rootmap-screen-port.md §3) widened the
// shared DOMAINS vocabulary to five, adding 'Context' — which this moment
// (a rollup over INGESTED facts, not the root-map metaphor) never had a row
// or label for and always renders zero for. Excluded explicitly here rather
// than growing a fifth undefined-label row.
const MOMENT_DOMAINS = DOMAINS.filter((domain) => domain !== 'Context')

export function buildDomainRows(domainCounts) {
  return MOMENT_DOMAINS.map((domain) => ({
    key: domain,
    label: DOMAIN_LABELS[domain],
    state: (domainCounts?.[domain] ?? 0) > 0 ? 'attention' : 'understood',
  }))
}

function joinWithAnd(labels) {
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

export function buildSummarySentence(rows) {
  const understood = rows.filter((r) => r.state === 'understood').map((r) => r.label)
  const attention = rows.filter((r) => r.state === 'attention').map((r) => r.label)

  if (attention.length === 0) {
    return 'Your whole camp came through clean.'
  }

  const attentionVerb = attention.length === 1 ? 'needs' : 'need'
  const attentionSentence = `${joinWithAnd(attention)} ${attentionVerb} a quick look.`

  if (understood.length === 0) {
    return attentionSentence
  }

  const understoodVerb = understood.length === 1 ? 'looks' : 'look'
  return `${joinWithAnd(understood)} ${understoodVerb} right. ${attentionSentence}`
}
