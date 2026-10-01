import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'

// T292 S1 — the read-only camp-data-document builder. Pattern-matches
// exportWorkbook.js's structure (aoaToSanitizedSheet as the ONLY sheet
// builder, FK-name resolution, column widths layered on the sanitized sheet)
// but is a SEPARATE, simpler contract: no round-trip machinery. No
// shoresh_id, no Status column, no hidden metadata sheet — this file is
// never re-imported, only opened and read.
//
// docs/work/specs/2026-09-28-t292-database-document-view.md §4 is the
// authority for every sheet/column/label/ordering choice below.

function titleCase(value) {
  if (value == null || value === '') return ''
  return String(value)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

function yesNo(value) {
  return value ? 'Yes' : 'No'
}

function yesBlank(value) {
  return value ? 'Yes' : ''
}

function canonicalTimeLabel(value) {
  if (value == null || value === '') return ''
  const s = String(value).trim()
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) return s
  let hh = parseInt(m[1], 10)
  const mm = m[2]
  const ampm = hh >= 12 ? 'PM' : 'AM'
  hh = hh % 12
  if (hh === 0) hh = 12
  return `${hh}:${mm} ${ampm}`
}

function dateOnly(value) {
  if (value == null || value === '') return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function jsonIdArray(value) {
  let ids = []
  try { ids = JSON.parse(value ?? '[]') } catch { ids = [] }
  return Array.isArray(ids) ? ids : []
}

function namesFromIds(ids, nameById) {
  return ids.map((id) => nameById.get(id)).filter((n) => n != null).join(', ')
}

function sortEntities(rows, { ordered }) {
  const copy = [...rows]
  if (ordered) {
    copy.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  } else {
    copy.sort((a, b) => String(a.__sortName ?? '').localeCompare(String(b.__sortName ?? '')))
  }
  return copy
}

function metaLine(campName, asOf) {
  const formatted = asOf.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `Camp ${campName} — as of ${formatted}`
}

// Sheet + column layout, entirely separate from exportWorkbook.js's
// SHEET_LAYOUT. Each entry's `build(rows, maps)` returns { header, dataRows }
// already resolved to display values, so the shared writer loop below stays
// declarative.
export const CAMP_DATA_SHEETS = Object.freeze([
  {
    sheet: 'Camp',
    entity: 'camps',
    build(rows) {
      const header = ['Camp Name']
      const dataRows = rows.map((r) => [r.name ?? ''])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Age Divisions',
    entity: 'tiers',
    ordered: true,
    build(rows, maps) {
      const header = ['Name', 'Program']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '',
        r.cohort_id != null ? (maps.cohortNameById.get(r.cohort_id) ?? '') : '',
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Programs',
    entity: 'cohorts',
    ordered: true,
    build(rows) {
      const header = ['Name', 'Start Date', 'End Date', 'Capacity Source', 'Fixed-event model']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '',
        dateOnly(r.session_week_start),
        dateOnly(r.session_week_end),
        titleCase(r.capacity_source),
        titleCase(r.fixed_event_model),
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Groups',
    entity: 'groups',
    build(rows, maps) {
      const header = ['Name', 'Age Division', 'Availability']
      const withSort = rows.map((r) => ({ ...r, __sortName: r.name }))
      const dataRows = sortEntities(withSort, { ordered: false }).map((r) => [
        r.name ?? '',
        r.tier_id != null ? (maps.tierNameById.get(r.tier_id) ?? '') : '',
        r.availability ?? '',
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Campers',
    entity: 'campers',
    build(rows, maps) {
      const header = ['Name', 'Group', 'External ID', 'Active']
      const withSort = rows.map((r) => ({ ...r, __sortName: r.display_name }))
      const dataRows = sortEntities(withSort, { ordered: false }).map((r) => [
        r.display_name ?? '',
        r.group_id != null ? (maps.groupNameById.get(r.group_id) ?? '') : '',
        r.external_id ?? '',
        yesNo(r.is_active),
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Locations',
    entity: 'locations',
    ordered: true,
    build(rows) {
      const header = ['Name', 'Capacity', 'Notes']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '', r.capacity ?? '', r.notes ?? '',
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Activities',
    entity: 'activities',
    build(rows, maps) {
      const header = [
        'Name', 'Priority', 'Min Sessions/Week', 'Max Sessions/Week', 'Length (Blocks)',
        'Outdoor', 'Locked', 'Same Age Division Only', 'Max Groups per Slot',
        'Prefer Before Day', 'Prefer Before (Min)', 'Place', 'Age Divisions',
        'Eligible Groups', 'Weather Alternative', 'Notes',
      ]
      const withSort = rows.map((r) => ({ ...r, __sortName: r.name }))
      const dataRows = sortEntities(withSort, { ordered: false }).map((r) => {
        const place = r.location_id != null
          ? (maps.locationNameById.get(r.location_id) ?? '')
          : (r.location ?? '')
        const tierIds = jsonIdArray(r.eligible_tier_ids)
        const groupIds = jsonIdArray(r.eligible_group_ids)
        return [
          r.name ?? '',
          r.priority ?? '',
          r.min_per_week ?? '',
          r.max_per_week ?? '',
          r.span_blocks ?? '',
          yesBlank(r.is_outdoor),
          yesBlank(r.is_locked),
          yesBlank(r.same_tier_only),
          r.max_groups_per_slot ?? '',
          r.prefer_before_day ?? '',
          r.prefer_before_day_min ?? '',
          place,
          namesFromIds(tierIds, maps.tierNameById),
          namesFromIds(groupIds, maps.groupNameById),
          r.weather_alternative_id != null ? (maps.activityNameById.get(r.weather_alternative_id) ?? '') : '',
          r.notes ?? '',
        ]
      })
      return { header, dataRows }
    },
  },
  {
    sheet: 'Days',
    entity: 'days_of_operation',
    ordered: true,
    build(rows) {
      const header = ['Name', 'Day of Week']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.label ?? '', r.day_of_week ?? '',
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Time Blocks',
    entity: 'time_blocks',
    ordered: true,
    build(rows, maps) {
      const header = ['Name', 'Start Time', 'End Time', 'Part of Day', 'Program']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '',
        canonicalTimeLabel(r.start_time),
        canonicalTimeLabel(r.end_time),
        r.part_of_day ?? '',
        r.cohort_id != null ? (maps.cohortNameById.get(r.cohort_id) ?? '') : '',
      ])
      return { header, dataRows, timeCols: [1, 2] }
    },
  },
  {
    sheet: 'Weeks',
    entity: 'schedule_weeks',
    ordered: true,
    build(rows) {
      const header = ['Name', 'Archived']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '', yesBlank(r.is_archived),
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Fixed Events',
    entity: 'fixed_events',
    build(rows, maps) {
      const header = [
        'Name', 'Type', 'Activity', 'Day', 'Time Block', 'Program', 'Week', 'Place',
        'Age Divisions', 'Groups', 'All Groups', 'Length (Blocks)', 'Notes',
      ]
      const withSort = rows.map((r) => {
        const daySort = r.day_id != null ? (maps.daySortById.get(r.day_id) ?? 0) : 0
        const tbSort = r.time_block_id != null ? (maps.timeBlockSortById.get(r.time_block_id) ?? 0) : 0
        return { ...r, __daySort: daySort, __tbSort: tbSort }
      })
      withSort.sort((a, b) => a.__daySort - b.__daySort || a.__tbSort - b.__tbSort)
      const dataRows = withSort.map((r) => {
        let tierIds = jsonIdArray(r.unit_ids)
        if (tierIds.length === 0 && r.unit_id != null) tierIds = [r.unit_id]
        const groupIds = jsonIdArray(r.group_ids)
        return [
          r.name ?? '',
          titleCase(r.kind),
          r.activity_id != null ? (maps.activityNameById.get(r.activity_id) ?? '') : '',
          r.day_id != null ? (maps.dayNameById.get(r.day_id) ?? '') : '',
          r.time_block_id != null ? (maps.timeBlockNameById.get(r.time_block_id) ?? '') : '',
          r.cohort_id != null ? (maps.cohortNameById.get(r.cohort_id) ?? '') : '',
          r.schedule_week_id != null ? (maps.weekNameById.get(r.schedule_week_id) ?? '') : '',
          r.location_id != null ? (maps.locationNameById.get(r.location_id) ?? '') : '',
          namesFromIds(tierIds, maps.tierNameById),
          namesFromIds(groupIds, maps.groupNameById),
          yesBlank(r.is_all_groups),
          r.span_blocks ?? '',
          r.notes ?? '',
        ]
      })
      return { header, dataRows }
    },
  },
  {
    sheet: 'Special Days',
    entity: 'special_days',
    ordered: true,
    build(rows) {
      const header = ['Name', 'Notes']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [r.name ?? '', r.notes ?? ''])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Events',
    entity: 'events',
    ordered: true,
    build(rows, maps) {
      const header = ['Name', 'Place', 'Notes']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => [
        r.name ?? '',
        r.location_id != null ? (maps.locationNameById.get(r.location_id) ?? '') : '',
        r.notes ?? '',
      ])
      return { header, dataRows }
    },
  },
  {
    sheet: 'Elective Sets',
    entity: 'elective_sets',
    ordered: true,
    build(rows, maps) {
      const header = ['Name', 'Day', 'Time Block', 'Groups', 'All Groups', 'Week', 'Reusable']
      const dataRows = sortEntities(rows, { ordered: true }).map((r) => {
        const groupIds = jsonIdArray(r.group_ids)
        return [
          r.name ?? '',
          r.day_id != null ? (maps.dayNameById.get(r.day_id) ?? '') : '',
          r.time_block_id != null ? (maps.timeBlockNameById.get(r.time_block_id) ?? '') : '',
          namesFromIds(groupIds, maps.groupNameById),
          yesBlank(r.is_all_groups),
          r.schedule_week_id != null ? (maps.weekNameById.get(r.schedule_week_id) ?? '') : '',
          yesBlank(r.is_reusable),
        ]
      })
      return { header, dataRows }
    },
  },
])

function notDeleted(rows) {
  return (rows ?? []).filter((r) => r.deleted_at == null)
}

/**
 * T292 S1. Build the read-only camp-data document (pure — reads plain entity
 * arrays, writes nothing). Returns an XLSX workbook.
 *
 * @param entities  object keyed by table name (camps, tiers, cohorts, groups,
 *                  campers, locations, activities, days_of_operation,
 *                  time_blocks, schedule_weeks, fixed_events, special_days,
 *                  events, elective_sets) — listEntities()-shaped arrays.
 * @param campName  string, used in the per-sheet meta line.
 * @param asOf      Date injected for deterministic tests (default: now).
 */
export function buildCampDataWorkbook({ entities = {}, campName = '', asOf = new Date() } = {}) {
  const tiers = notDeleted(entities.tiers)
  const cohorts = notDeleted(entities.cohorts)
  const groups = notDeleted(entities.groups)
  const locations = notDeleted(entities.locations)
  const daysOfOperation = notDeleted(entities.days_of_operation)
  const timeBlocks = notDeleted(entities.time_blocks)
  const scheduleWeeks = notDeleted(entities.schedule_weeks)
  const activities = notDeleted(entities.activities)

  const maps = {
    cohortNameById: new Map(cohorts.map((c) => [c.id, c.name])),
    tierNameById: new Map(tiers.map((t) => [t.id, t.name])),
    groupNameById: new Map(groups.map((g) => [g.id, g.name])),
    locationNameById: new Map(locations.map((l) => [l.id, l.name])),
    dayNameById: new Map(daysOfOperation.map((d) => [d.id, d.label])),
    daySortById: new Map(daysOfOperation.map((d) => [d.id, d.sort_order ?? 0])),
    timeBlockNameById: new Map(timeBlocks.map((t) => [t.id, t.name])),
    timeBlockSortById: new Map(timeBlocks.map((t) => [t.id, t.sort_order ?? 0])),
    weekNameById: new Map(scheduleWeeks.map((w) => [w.id, w.name])),
    activityNameById: new Map(activities.map((a) => [a.id, a.name])),
  }

  const entityRows = {
    camps: notDeleted(entities.camps),
    tiers, cohorts, groups, locations,
    campers: notDeleted(entities.campers),
    activities,
    days_of_operation: daysOfOperation,
    time_blocks: timeBlocks,
    schedule_weeks: scheduleWeeks,
    fixed_events: notDeleted(entities.fixed_events),
    special_days: notDeleted(entities.special_days),
    events: notDeleted(entities.events),
    elective_sets: notDeleted(entities.elective_sets),
  }

  const wb = XLSX.utils.book_new()
  const meta = metaLine(campName, asOf)

  for (const def of CAMP_DATA_SHEETS) {
    const rows = entityRows[def.entity] ?? []
    const { header, dataRows, timeCols } = def.build(rows, maps)
    const aoa = [[meta], header, ...dataRows]
    const ws = aoaToSanitizedSheet(aoa)

    ws['!cols'] = header.map((h) =>
      /notes/i.test(h) ? { wch: 32 } : /name/i.test(h) ? { wch: 22 } : { wch: 14 }
    )

    if (timeCols) {
      for (const colIdx of timeCols) {
        for (let r = 2; r < aoa.length; r++) {
          const addr = XLSX.utils.encode_cell({ c: colIdx, r })
          if (ws[addr]) ws[addr].z = '@'
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, def.sheet)
  }

  return wb
}
