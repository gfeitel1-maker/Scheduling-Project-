// T301 slice 2 — the bundle editor's period-picker cells. A camp holds up to
// two candidate schedules (manual/generated) and NEITHER is canonical
// (CLAUDE.md): a bundle's members are (day_id, time_block_id) pairs,
// template-independent (ADR D1), so the grid shows the UNION of both routes'
// placed cells, sub-labelled where the routes disagree — never a route
// switcher, which would imply a per-route authoring model that does not
// exist.
//
// ONE call to deriveOccurrences.js, not two: that function already groups its
// output by every template_id present in the slots it is given (confirmed
// against AssignmentPanel.jsx's own usage, `deriveOccurrences({slots:
// templateSlots, groups, electiveSetId})`, which reads `.templates[id]` for
// whichever template it needs afterward) — a second, template-filtered call
// would just repeat the same scan. Pure, no IPC, no db, same discipline as its
// sibling.
import { deriveOccurrences } from './deriveOccurrences.js'

// A NUL join key, matching deriveChoices.js's own bundlePeriods dedupe key —
// day_id/time_block_id are structurally unable to contain it (every current
// producer mints either a bare crypto.randomUUID() or deriveDayId's
// `day:${campId}:${dayOfWeek}` shape, both hex/dash/colon only). Built via
// String.fromCharCode rather than a NUL escape literal in source, which this
// codebase has previously seen an authoring tool silently corrupt into a raw
// control byte.
const CELL_SEP = String.fromCharCode(0)

/**
 * @param {object} input
 * @param {object[]} input.templateSlots
 * @param {{id, kind}[]} input.scheduleTemplates
 * @param {{id, tier_id}[]} input.groups
 * @param {{id}[]} input.days       camp order, for sort only
 * @param {{id}[]} input.timeBlocks camp order, for sort only
 * @param {string} input.electiveSetId
 * @returns {{day_id: string, time_block_id: string, manual: string[], generated: string[]}[]}
 *          one entry per distinct placed cell, sorted by the camp's own
 *          time-block order then day order. `manual`/`generated` are the
 *          distinct tier ids placed there on that route — an empty array
 *          means that route does not place this set in this cell at all,
 *          never fabricated agreement between the two routes.
 */
export function deriveBundlePickerCells({
  templateSlots = [],
  scheduleTemplates = [],
  groups = [],
  days = [],
  timeBlocks = [],
  electiveSetId,
} = {}) {
  const manualTemplate = scheduleTemplates.find((t) => t.kind === 'manual')
  const generatedTemplate = scheduleTemplates.find((t) => t.kind === 'generated')
  const { templates } = deriveOccurrences({ slots: templateSlots, groups, electiveSetId })

  const cellsByKey = new Map()
  const merge = (occurrences, route) => {
    for (const o of occurrences ?? []) {
      const key = `${o.day_id}${CELL_SEP}${o.time_block_id}`
      if (!cellsByKey.has(key)) {
        cellsByKey.set(key, { day_id: o.day_id, time_block_id: o.time_block_id, manual: new Set(), generated: new Set() })
      }
      cellsByKey.get(key)[route].add(o.tier_id)
    }
  }
  merge(manualTemplate ? templates[manualTemplate.id]?.occurrences : undefined, 'manual')
  merge(generatedTemplate ? templates[generatedTemplate.id]?.occurrences : undefined, 'generated')

  const dayOrder = new Map(days.map((d, i) => [d.id, i]))
  const blockOrder = new Map(timeBlocks.map((b, i) => [b.id, i]))

  return [...cellsByKey.values()]
    .map((c) => ({ day_id: c.day_id, time_block_id: c.time_block_id, manual: [...c.manual], generated: [...c.generated] }))
    .sort((a, b) => {
      const byBlock = (blockOrder.get(a.time_block_id) ?? 0) - (blockOrder.get(b.time_block_id) ?? 0)
      if (byBlock !== 0) return byBlock
      return (dayOrder.get(a.day_id) ?? 0) - (dayOrder.get(b.day_id) ?? 0)
    })
}
