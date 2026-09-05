// buildAttentionList — ADR docs/adr/2026-08-28-roots-home-is-a-distinct-
// screen.md §3. PURE. No IO. Unions two normalized halves into one ranked,
// undifferentiated {id,name,why,domainTag,sourceKind}[] list for the Roots
// home's "Needs your attention" section:
//
//   1. Reconciliation half — read directly from buildRootMapModel's own
//      per-child roster state (the same 'attention'/'changed' classification
//      RootMapPanel's decisionsForTileState already surfaces for the
//      attention tile), never recomputed here.
//   2. Structure-issues half — see buildStructureIssues below.
//
// The getReadiness-vs-buildRootMapModel divergence (ADR §3) is sidestepped,
// not fixed: this module reads buildRootMapModel exclusively and never calls
// getReadiness.

import { isActivityEligibleForGroup } from '../engine/eligibility.js'

function reconciliationRows(model, decisionsById) {
  const rows = []
  for (const domain of model.domains) {
    for (const child of domain.children) {
      for (const entry of child.roster ?? []) {
        if (entry.state !== 'attention' && entry.state !== 'changed') continue
        const decision = entry.decisionId ? decisionsById.get(entry.decisionId) : null
        rows.push({
          id: entry.decisionId ?? `${child.key}:${entry.entityId ?? entry.name}`,
          name: entry.name,
          why: decision?.reason ?? 'Needs your review.',
          domainTag: domain.label,
          sourceKind: 'reconciliation',
        })
      }
    }
  }
  return rows
}

export function buildAttentionList({ model, decisionsById = new Map(), structureIssues = [] }) {
  return [...reconciliationRows(model, decisionsById), ...structureIssues]
}

// buildStructureIssues — the minimal, extensible set of live current-state
// completeness checks (ADR §3, owner decision 2026-08-28). Pure reads over
// localClient.list()-shaped collections, NO dependency on the schedule
// engine (buildSchedule.js) — isActivityEligibleForGroup is a small,
// standalone pure predicate (engine/eligibility.js), not the engine itself.
const REQUIRED_EMPTY_AREAS = [
  { key: 'tiers', label: 'Age divisions', domainTag: 'Structure' },
  { key: 'groups', label: 'Groups', domainTag: 'Structure' },
  { key: 'days_of_operation', label: 'Days', domainTag: 'Time' },
  { key: 'time_blocks', label: 'Time blocks', domainTag: 'Time' },
  { key: 'activities', label: 'Activities', domainTag: 'Scheduling' },
]

export function buildStructureIssues(collections) {
  if (!collections) return []
  const issues = []

  for (const area of REQUIRED_EMPTY_AREAS) {
    if ((collections[area.key] ?? []).length === 0) {
      issues.push({
        id: `empty:${area.key}`,
        name: area.label,
        why: `No ${area.label.toLowerCase()} set up yet.`,
        domainTag: area.domainTag,
        sourceKind: 'structure',
      })
    }
  }

  const groups = collections.groups ?? []
  const activities = collections.activities ?? []
  if (activities.length > 0) {
    for (const group of groups) {
      const hasEligible = activities.some((a) => isActivityEligibleForGroup(a, group))
      if (!hasEligible) {
        issues.push({
          id: `group-no-activities:${group.id}`,
          name: group.name,
          why: 'No activities are eligible for this group.',
          domainTag: 'Structure',
          sourceKind: 'structure',
        })
      }
    }
  }

  return issues
}
