// T248 (docs/work/tickets/T248-child-schedule-export.md) — the single
// derivation of a run's per-camper outer schedule rows, shared by BOTH the
// draft-derive read path (getElectiveRunOuterScheduleHandler, electron/
// main.js) and finalizeElectiveRun.js's snapshot-write path.
//
// GOVERNOR DEVIATION FROM THE ADR: docs/adr/2026-09-23-elective-run-lifecycle-
// and-remaining-slices.md decision (d)'s prose describes the draft path as
// reading the camper's GROUP's non-elective template_slots. That is not what
// T244 actually built: finalizeElectiveRun.js snapshots the run's
// generation-visible elective_assignments joined to their occurrences —
// per-camper RESOLVED elective placements, not a group's template. Building
// the draft path to the ADR's literal group-template reading would make it
// disagree with what finalize snapshots for the exact same run, which is
// unverifiable and wrong. Resolution (Governor): extract T244's derivation
// into this one function and have BOTH the draft-read handler and
// finalizeElectiveRun.js call it, so draft-derive and finalize are PROVABLY
// symmetric — finalizing a draft and re-deriving it must produce identical
// rows, which is exactly what the integration test asserts. Do not implement
// the ADR's group/template_slots reading here.
//
// v76 (T197, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-
// choice-export.md) RESOLVES the deferred half of that gap: this function now
// returns TWO cell kinds — 'elective' (unchanged) and 'inherited' (new, reads
// the camper's group's non-elective template_slots, per the ADR's decision
// 1). Both kinds flow through the SAME symmetric call from both callers, so
// the symmetry argument above still holds by construction.
//
// Span-awareness note: this module returns one row per span HEAD (span_blocks
// carries the length), never one row per covered block — the renderer grid
// helpers named in the ticket (collectSpanTails/getActivityRowSpan,
// src/screens/schedule/useSlotMutations.js and gridGeometry.js) are NOT used
// here. Those operate on a group schedule's rendered `slots` array in the
// renderer and cannot run in the main process against this shape; they are
// also out of bounds for electron/ per this repo's renderer/main boundary.
// On the elective side, the activity's own `span_blocks` column, copied
// through unchanged, carries span length, exactly as before. On the inherited
// side, span_blocks is the DERIVED contiguous-run length (see
// collapseInheritedSpans below) — a deliberate divergence from the elective
// side's convention, because there is no occurrence-level authority for
// inherited cells: the template rows on disk are the only ground truth.
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'

// Resolves one template_slots row to its (kind, ref_id, activity_id, activity_name) identity.
// Mirrors finalizeElectiveRun.js's mapTemplateSlot classification (same mutually-exclusive column
// group: elective_set_id / event_id / is_anchor+anchor_id / activity_id), reused for the same
// purpose rather than re-invented, per the ADR.
function resolveTemplateSlot(row, { activityById, anchorById, eventById }) {
  if (row.event_id != null) {
    const event = eventById.get(row.event_id) ?? null
    return { kind: 'event', refId: row.event_id, activityId: null, activityName: event?.name ?? null }
  }
  if (row.is_anchor) {
    const anchor = anchorById.get(row.anchor_id) ?? null
    // anchor_activities carries no activity_id of its own (schema.sql) — its own `name` is the
    // only identity available, per the ADR's "else name from anchor_activities" fallback.
    return { kind: 'anchor', refId: row.anchor_id, activityId: null, activityName: anchor?.name ?? null }
  }
  if (row.activity_id != null) {
    const activity = activityById.get(row.activity_id) ?? null
    return { kind: 'activity', refId: row.activity_id, activityId: row.activity_id, activityName: activity?.name ?? null }
  }
  return { kind: null, refId: null, activityId: null, activityName: null }
}

// Contiguous-run collapse for inherited cells (ADR §1): template_slots is not pre-collapsed like
// elective_occurrences is, so a 3-block activity is three separate rows at three consecutive
// time_block_ids. Walk each (group_id, day_id) cohort's rows in sort_order and merge adjacent rows
// sharing the same resolved (kind, refId) identity into one span head. A gap breaks the run — two
// non-adjacent occurrences of the same activity are two spans, not one.
function collapseInheritedSpans(slotRows, { activityById, anchorById, eventById, timeBlockOrder }) {
  const byGroupDay = new Map()
  for (const row of slotRows) {
    const key = `${row.group_id}|${row.day_id}`
    if (!byGroupDay.has(key)) byGroupDay.set(key, [])
    byGroupDay.get(key).push(row)
  }

  const spans = []
  for (const rows of byGroupDay.values()) {
    const sorted = [...rows].sort(
      (a, b) => (timeBlockOrder.get(a.time_block_id) ?? 0) - (timeBlockOrder.get(b.time_block_id) ?? 0)
    )
    let current = null
    for (const row of sorted) {
      const resolved = resolveTemplateSlot(row, { activityById, anchorById, eventById })
      const order = timeBlockOrder.get(row.time_block_id) ?? 0
      const sameSpan =
        current &&
        current.resolved.kind === resolved.kind &&
        current.resolved.refId === resolved.refId &&
        order === current.lastOrder + 1
      if (sameSpan) {
        current.spanBlocks += 1
        current.lastOrder = order
      } else {
        if (current) spans.push(current)
        current = { groupId: row.group_id, dayId: row.day_id, timeBlockId: row.time_block_id, resolved, spanBlocks: 1, lastOrder: order }
      }
    }
    if (current) spans.push(current)
  }
  return spans
}

// F4 (round-2 fix): a camper's elective placement REPLACES their group's inherited template cell
// at that exact block — never both. Since an inherited row can be a multi-block span, a single
// elective block landing in the middle of it must split the span rather than either dropping the
// whole span (loses real inherited blocks) or emitting a colliding duplicate id (silently drops
// one of the two placements at write time, see deriveElectiveRunOuterSnapshotId). Splits
// [startOrder, startOrder+length) around the given blocked orders into the contiguous runs that
// remain.
function splitAroundBlocked(startOrder, length, blockedOrders) {
  const runs = []
  let runStart = null
  for (let order = startOrder; order < startOrder + length; order += 1) {
    if (blockedOrders.has(order)) {
      if (runStart != null) runs.push({ startOrder: runStart, length: order - runStart })
      runStart = null
    } else if (runStart == null) {
      runStart = order
    }
  }
  if (runStart != null) runs.push({ startOrder: runStart, length: startOrder + length - runStart })
  return runs
}

/**
 * @returns {{rows: Array, skipped: Array}}
 */
export function deriveElectiveRunOuterRows(db, run) {
  // An unknown runId (round 2, Code Reviewer + Red Hat) leaves `run`
  // undefined — degrade the same way getElectiveRunHandler does for the
  // same input, rather than dereferencing run.id below.
  if (!run) return { rows: [], skipped: [] }

  const activityById = new Map(db.prepare('SELECT * FROM activities').all().map((a) => [a.id, a]))
  const locationById = new Map(db.prepare('SELECT * FROM locations').all().map((l) => [l.id, l]))
  const anchorById = new Map(db.prepare('SELECT * FROM anchor_activities').all().map((a) => [a.id, a]))
  const eventById = new Map(db.prepare('SELECT * FROM events').all().map((e) => [e.id, e]))

  // --- Elective query (unchanged shape, plus choice_id / is_linked_choice) ---
  const assignmentRows = db
    .prepare(
      `SELECT a.camper_id, a.activity_id, o.day_id, o.time_block_id, a.choice_id,
              c.is_linked AS is_linked_choice, c.label AS choice_label
         FROM elective_assignments a
         JOIN elective_occurrences o ON o.id = a.occurrence_id
         LEFT JOIN elective_choices c ON c.id = a.choice_id
        WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}
        ORDER BY a.camper_id, o.day_id, o.time_block_id`
    )
    .all({ runId: run.id, gen: run.solver_generation })

  const rows = []
  const skipped = []
  const visibleCamperIds = new Set()
  for (const row of assignmentRows) {
    if (row.day_id == null || row.time_block_id == null) {
      skipped.push({ camperId: row.camper_id, reason: 'missing day_id or time_block_id' })
      continue
    }
    visibleCamperIds.add(row.camper_id)
    const activity = activityById.get(row.activity_id) ?? null
    const location = activity?.location_id != null ? locationById.get(activity.location_id) ?? null : null
    rows.push({
      camper_id: row.camper_id,
      day_id: row.day_id,
      time_block_id: row.time_block_id,
      cell_kind: 'elective',
      activity_id: row.activity_id,
      activity_name: activity?.name ?? null,
      location_id: activity?.location_id ?? null,
      location_name: location?.name ?? null,
      span_blocks: activity?.span_blocks ?? null,
      solver_generation: run.solver_generation,
      choice_id: row.choice_id ?? null,
      is_linked_choice: !!row.is_linked_choice,
      choice_label: row.choice_label ?? null,
    })
  }

  // --- Camper universe: generation-visible assignments UNION elective_preferences (ADR §1) ---
  const preferenceCamperIds = db
    .prepare('SELECT DISTINCT camper_id FROM elective_preferences WHERE run_id = ?')
    .all(run.id)
    .map((r) => r.camper_id)
  const camperUniverse = new Set([...visibleCamperIds, ...preferenceCamperIds])

  // --- Inheritance query (new): each camper's group's non-elective template_slots ---
  if (run.schedule_template_id != null && camperUniverse.size > 0) {
    const camperRows = db
      .prepare(
        `SELECT id, group_id FROM campers WHERE id IN (${[...camperUniverse].map(() => '?').join(',')})`
      )
      .all(...camperUniverse)
    const groupIdByCamperId = new Map(camperRows.map((c) => [c.id, c.group_id]))
    const groupIds = [...new Set(camperRows.map((c) => c.group_id).filter((g) => g != null))]

    if (groupIds.length > 0) {
      const slotRows = db
        .prepare(
          `SELECT * FROM template_slots
            WHERE template_id = ? AND elective_set_id IS NULL
              AND group_id IN (${groupIds.map(() => '?').join(',')})`
        )
        .all(run.schedule_template_id, ...groupIds)

      const timeBlockOrder = new Map(
        db.prepare('SELECT id, sort_order FROM time_blocks').all().map((t) => [t.id, t.sort_order ?? 0])
      )

      const spans = collapseInheritedSpans(slotRows, { activityById, anchorById, eventById, timeBlockOrder })

      // F4: (camperId, dayId) -> Set of time-block ORDERS already covered by this camper's own
      // elective row — `rows` at this point holds only the elective rows pushed above. Order-based
      // (not blockId-based) so a multi-block inherited span can be split around a single blocked
      // block inside it, not just matched whole.
      const electiveOrdersByCamperDay = new Map()
      for (const r of rows) {
        const key = `${r.camper_id}|${r.day_id}`
        if (!electiveOrdersByCamperDay.has(key)) electiveOrdersByCamperDay.set(key, new Set())
        electiveOrdersByCamperDay.get(key).add(timeBlockOrder.get(r.time_block_id) ?? -1)
      }
      const orderToBlockId = new Map([...timeBlockOrder.entries()].map(([id, order]) => [order, id]))

      // Emit one inherited row per (camper, span) — every camper in that group gets the span,
      // minus any blocks where that specific camper already holds an elective placement.
      const campersByGroup = new Map()
      for (const [camperId, groupId] of groupIdByCamperId) {
        if (!campersByGroup.has(groupId)) campersByGroup.set(groupId, [])
        campersByGroup.get(groupId).push(camperId)
      }
      for (const span of spans) {
        if (span.resolved.kind == null) {
          // F9 (round 2): the elective side already records a `skipped` entry for a malformed row
          // (missing day_id/time_block_id, above) — this inherited-side skip silently dropped its
          // equivalent (a template_slots row with none of event_id/is_anchor/activity_id set).
          // Same treatment: record it, don't just vanish it.
          skipped.push({ groupId: span.groupId, dayId: span.dayId, timeBlockId: span.timeBlockId, reason: 'template_slots row unresolved to any kind' })
          continue
        }
        const camperIds = campersByGroup.get(span.groupId) ?? []
        const spanStartOrder = timeBlockOrder.get(span.timeBlockId) ?? 0
        for (const camperId of camperIds) {
          const blockedOrders = electiveOrdersByCamperDay.get(`${camperId}|${span.dayId}`) ?? new Set()
          const runs = splitAroundBlocked(spanStartOrder, span.spanBlocks, blockedOrders)
          for (const run of runs) {
            const location = span.resolved.activityId != null
              ? activityById.get(span.resolved.activityId)?.location_id ?? null
              : null
            rows.push({
              camper_id: camperId,
              day_id: span.dayId,
              time_block_id: orderToBlockId.get(run.startOrder) ?? span.timeBlockId,
              cell_kind: 'inherited',
              activity_id: span.resolved.activityId,
              activity_name: span.resolved.activityName,
              location_id: location,
              location_name: location != null ? locationById.get(location)?.name ?? null : null,
              span_blocks: run.length,
              solver_generation: null,
              choice_id: null,
              is_linked_choice: false,
              choice_label: null,
            })
          }
        }
      }
    }
  }

  rows.sort((a, b) =>
    a.camper_id === b.camper_id
      ? a.day_id === b.day_id
        ? a.time_block_id.localeCompare(b.time_block_id)
        : a.day_id.localeCompare(b.day_id)
      : a.camper_id.localeCompare(b.camper_id)
  )

  return { rows, skipped }
}
