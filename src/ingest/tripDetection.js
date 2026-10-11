// Field-trip and special-day detection for a weekly text grid (slice 1 of
// docs/adr/2026-10-11-import-special-days-and-field-trips.md). PURE and NOT
// WIRED: it proposes, nothing consumes it yet (slice 2 does).
//
// Rules (each is the ADR's, "Weekly import" 1-3):
//   * Cells are read exactly as span inference reads them (groupDaySequences
//     from textSpans.js), and a "blank"-form span's continuation cells carry its
//     name, so the detector and F5 agree on what a span is.
//   * A RUN is the same name in >= 2 consecutive blocks of one (group, day). Any
//     block where the group prints something else (a printed Lunch) or nothing
//     ends the run, so a detection never claims a block the file filled with
//     something else.
//   * Runs are grouped per (day, name, exact blocks): the group-set is the groups
//     sharing that printed run. Same name, disjoint group-sets on different
//     blocks are separate detections.
//   * One day only: a name WITHOUT a lexical cue that the file prints on any
//     other day (any group, any form) is a rotation / catalogue activity and is
//     not a detection. With a cue, each (day, group-set) run is its own trip.
//   * kind:  'all-camp-day' — every group operating that day prints the name in
//              >= 80% of that day's blocks;
//            'subset-day'   — every group in the set does, but not every group
//              (near-whole, e.g. 23 of 24, lands here and names the missing);
//            'trip'         — otherwise.
//   * defaultAnswer: 'event' only with evidence (lexical cue or whole-day
//     coverage); 'activity' with neither; null (no default) for all-camp-day
//     (explicit answer only) and for a rain/alternate/backup name or a run that
//     shares (day, group-set, blocks) with another detection.
//   * claims: the (group, day, block) cells the detection would take, so slice 2
//     can remove them from fixed-event and activity inference (no min_per_week
//     inflation when a trip's name equals a catalogue activity).
//
// `groupIds` holds the proposal's group keys (the canonical group NAMES the
// import plan keys groups by); the commit resolves them to row ids.

import { normalizeName } from './preview.js'
import { groupDaySequences, inferTextSpans } from './textSpans.js'

export const LEXICAL_CUES = Object.freeze(['trip', 'field', 'outing', 'excursion', 'day'])
const ALTERNATE_TOKENS = ['rain', 'rainy', 'alternate', 'alt', 'backup']
export const WHOLE_DAY_COVERAGE = 0.8

function words(name) {
  return normalizeName(name).split(/[^a-z0-9]+/).filter(Boolean)
}
export function lexicalCueOf(name) {
  const w = words(name)
  return LEXICAL_CUES.find((c) => w.includes(c)) ?? null
}
function isAlternateName(name) {
  const w = words(name)
  return ALTERNATE_TOKENS.some((t) => w.includes(t))
}

/**
 * @returns {Array<{ kind: 'trip'|'subset-day'|'all-camp-day', day: string, name: string,
 *   groupIds: string[], blocks: string[], lexicalCue: string|null, wholeDay: boolean,
 *   confidence: 'high'|'medium'|'low', defaultAnswer: 'event'|'activity'|null,
 *   missingGroups: string[], alternate: boolean,
 *   claims: Array<{ groupName: string, dayName: string, blockLabel: string }> }>}
 */
export function detectTripsAndSpecialDays(parsed, proposal = {}) {
  const seqs = groupDaySequences(parsed, proposal)
  const { continuations } = inferTextSpans(parsed, proposal)
  const cont = new Map(continuations.map((c) => [JSON.stringify([c.groupName, c.dayName, c.blockLabel]), c.activityName]))
  for (const seq of seqs) {
    for (const cell of seq.cells) {
      const name = cont.get(JSON.stringify([seq.groupName, seq.dayName, cell.blockLabel]))
      if (name && cell.names.length === 0) cell.names = [name]
    }
  }

  // Days on which each name appears at all (any group, any form), groups operating per day.
  const daysOfName = new Map()
  const groupsOnDay = new Map()
  for (const seq of seqs) {
    if (seq.cells.some((c) => c.names.length)) {
      if (!groupsOnDay.has(seq.dayName)) groupsOnDay.set(seq.dayName, new Set())
      groupsOnDay.get(seq.dayName).add(seq.groupName)
    }
    for (const c of seq.cells) {
      for (const n of c.names) {
        const k = normalizeName(n)
        if (!daysOfName.has(k)) daysOfName.set(k, new Set())
        daysOfName.get(k).add(seq.dayName)
      }
    }
  }

  // Runs, grouped by (day, name, blocks).
  const byKey = new Map()
  const coverage = new Map() // [group, day, norm] -> fraction of that (group, day)'s blocks
  for (const seq of seqs) {
    const { cells } = seq
    const has = (i, norm) => cells[i]?.names.some((n) => normalizeName(n) === norm)
    const counted = new Set()
    cells.forEach((cell, i) => {
      for (const name of cell.names) {
        const norm = normalizeName(name)
        if (!counted.has(norm)) {
          counted.add(norm)
          const n = cells.filter((_, j) => has(j, norm)).length
          coverage.set(JSON.stringify([seq.groupName, seq.dayName, norm]), n / cells.length)
        }
        if (i > 0 && has(i - 1, norm)) continue // mid-run
        let run = 1
        while (has(i + run, norm)) run += 1
        if (run < 2) continue
        const blocks = cells.slice(i, i + run).map((c) => c.blockLabel)
        const key = JSON.stringify([seq.dayName, norm, blocks])
        if (!byKey.has(key)) byKey.set(key, { day: seq.dayName, name, norm, blocks, groups: [] })
        byKey.get(key).groups.push(seq.groupName)
      }
    })
  }

  const out = []
  for (const r of byKey.values()) {
    const cue = lexicalCueOf(r.name)
    if (!cue && (daysOfName.get(r.norm)?.size ?? 0) > 1) continue // rotation / catalogue
    const wholeDay = r.groups.every((g) => (coverage.get(JSON.stringify([g, r.day, r.norm])) ?? 0) >= WHOLE_DAY_COVERAGE)
    const operating = [...(groupsOnDay.get(r.day) ?? [])]
    const missingGroups = operating.filter((g) => !r.groups.includes(g))
    const kind = wholeDay ? (missingGroups.length === 0 ? 'all-camp-day' : 'subset-day') : 'trip'
    const alternate = isAlternateName(r.name)
    out.push({
      kind, day: r.day, name: r.name, groupIds: [...r.groups].sort(), blocks: r.blocks,
      lexicalCue: cue, wholeDay, missingGroups: kind === 'subset-day' ? missingGroups.sort() : [],
      alternate,
      confidence: cue && wholeDay ? 'high' : cue || wholeDay ? 'medium' : 'low',
      defaultAnswer: kind === 'all-camp-day' || alternate ? null : cue || wholeDay ? 'event' : 'activity',
      claims: r.groups.flatMap((g) => r.blocks.map((b) => ({ groupName: g, dayName: r.day, blockLabel: b }))),
    })
  }

  // Rainy-day / alternate pair: two names on the same (day, group-set, blocks) get no default.
  const scope = (d) => JSON.stringify([d.day, d.groupIds, d.blocks])
  const scopeCount = new Map()
  for (const d of out) scopeCount.set(scope(d), (scopeCount.get(scope(d)) ?? 0) + 1)
  for (const d of out) {
    if (scopeCount.get(scope(d)) > 1) {
      d.alternate = true
      d.defaultAnswer = null
      d.confidence = 'low'
    }
  }
  return out.sort((a, b) => (a.day + a.name + a.blocks[0]).localeCompare(b.day + b.name + b.blocks[0]))
}
