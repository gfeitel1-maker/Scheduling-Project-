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

  // UNATTRIBUTED SUBJECTS (T285). A camper whose NAME this app does not know, from
  // a planner grid that carries no name column because the identity comes from the
  // SUBMISSION rather than the page.
  //
  // OWNER RULING on where this goes: the existing attention surface, not a bespoke
  // screen and not a banner (standing rule — banners are "SaaS nonsense"; state that
  // needs surfacing goes in the vocabulary that already exists). A camper whose name
  // we do not know is exactly the shape of thing this list already carries. That
  // also settles agent access: the same list, not a special-case query.
  //
  // This is the only READER of `campers.is_unattributed`. Before it the column had
  // one writer and no reader at all, so the import's own residue — "name the camper
  // when you know them, and nothing needs re-importing" — was a false promise: there
  // was no surface on which to know.
  // T299 — HOW MANY UNNAMED SHEETS CARRY THESE EXACT ANSWERS. `external_id` on an
  // unattributed subject is the SUBMISSION key (a hash of the sheet's own rows), so
  // two subjects sharing it answered identically. That is the one thing a director
  // needs to know here, and the one thing the file itself cannot tell them: two
  // children who agreed, one child's sheet sent twice, and a copy-paste error in the
  // source all produce the same bytes. Both sheets have already LANDED as their own
  // subject (T299) — this is only the telling.
  //
  // Counted over UNNAMED sheets only. Once a subject is named it is an ordinary
  // camper rather than a sheet awaiting a decision, so counting it would keep a
  // question on screen that the director has already answered.
  //
  // A NULL KEY IS NOT A MATCH. Two subjects with no submission key are two unknowns,
  // and reading them as identical would invent a collision out of missing data.
  //
  // "A sheet awaiting a name" is spelled ONCE, and the counting and the emitting both
  // read that one list. Spelling it twice is how the two could come to disagree — a
  // row claiming a twin that is not in the list, or a pair where only one side is
  // flagged — which is the same defect class as the STRUCTURE_ENTITIES omission this
  // ticket fixed one file over, at twelve lines' distance instead of two files'.
  const subjects = (collections.campers ?? []).filter((c) => c.is_unattributed === 1)
  const submissionCounts = new Map()
  for (const subject of subjects) {
    if (!subject.external_id) continue
    submissionCounts.set(subject.external_id, (submissionCounts.get(subject.external_id) ?? 0) + 1)
  }

  for (const camper of subjects) {
    // ONE ROW PER SUBJECT even when two are identical, because each has to be
    // separately nameable: naming both as the same child merges them (T285's rekey
    // sends both onto one canonical id), naming each keeps them apart, and the app
    // takes no view on which is right. Collapsing the pair into one row would hide a
    // child behind the other.
    //
    // No guard on a missing key is needed here: the loop above never puts one in the
    // Map, so `get(undefined)` is undefined and `undefined > 1` is already false.
    const indistinguishable = submissionCounts.get(camper.external_id) > 1
    issues.push({
      // The camper id is IN the item id, because acting on this means attributing
      // that specific subject and the surface is the only place it is offered.
      id: `unattributed-camper:${camper.id}`,
      // The label the import kept (its filename), which is how a director recognises
      // which submission this is.
      name: camper.display_name || 'An unnamed sheet',
      why: indistinguishable
        ? 'Another unnamed sheet has exactly the same answers \u2014 is this two campers, or ' +
          'one camper\u2019s sheet imported twice? Name them to say which.'
        : 'We have this camper\u2019s choices but not their name — who is this?',
      domainTag: 'Campers',
      sourceKind: 'unattributed-camper',
    })
  }

  return issues
}
