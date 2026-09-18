// T195 — preference-import identity + choice resolution. PURE: no db, no I/O.
//
// Every snapshot (roster, groups, activityIndex, offeringIndex, occurrenceIds)
// is passed in by the caller (electron/ops/preferenceImportPreview.js or
// commitPreferenceImport.js) as plain data read from the db BEFORE this
// function runs — this is what makes preview and commit provably run the
// SAME decision (they both call this function against a snapshot) and makes
// this module unit-testable with hand-built fixtures, no live db required.
//
// Identity/name matching is EXACT STRING EQUALITY throughout — never
// case/whitespace-normalized, never fuzzy. Auto-merging two differently-cased
// or differently-spaced names is exactly the "silent guess" this importer
// exists to refuse (T195 brief, DOES NOT COUNT AS DONE).
//
// SHEET SHAPE ASSUMED (not fully specified upstream; recorded here as the
// resolver's contract): `mapping.choices` is an ORDERED array of RANK SLOTS
// — choices[i] is rank (i+1). A non-linked slot's one member column holds
// free text naming the activity the camper ranked at that position; a linked
// slot's memberColumns hold the same choice's text repeated across the
// linked periods (isLinked, ADR D12). A blank cell at a configured rank slot
// is an error (BLANK_RANK) unless the row's noPreferenceValues literal is
// used — a rank slot is either filled, explicitly "no preference", or the
// row is not ambiguous about it.

export const IDENTITY_STATUS = Object.freeze({
  MATCHED: 'matched',
  OFFERED: 'offered',
  OFFERED_NEW: 'offered_new',
  BLOCKED: 'blocked',
})

export const IDENTITY_REASONS = Object.freeze({
  DUPLICATE_NAME_ACROSS_GROUPS: 'DUPLICATE_NAME_ACROSS_GROUPS',
  MISSING_GROUP: 'MISSING_GROUP',
  AMBIGUOUS_SAME_GROUP: 'AMBIGUOUS_SAME_GROUP',
})

export const CHOICE_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  NO_PREFERENCE: 'no_preference',
  BLOCKED: 'blocked',
})

export const CHOICE_REASONS = Object.freeze({
  ACTIVITY_NOT_OFFERED: 'ACTIVITY_NOT_OFFERED',
  UNKNOWN_ACTIVITY: 'UNKNOWN_ACTIVITY',
  AMBIGUOUS_ACTIVITY: 'AMBIGUOUS_ACTIVITY',
  UNSUPPORTED_LINKED_CHOICE: 'UNSUPPORTED_LINKED_CHOICE',
})

export const ROW_ERROR_REASONS = Object.freeze({
  BLANK_RANK: 'BLANK_RANK',
  DUPLICATE_RANK: 'DUPLICATE_RANK',
})

function cellValue(row, headers, colIndex) {
  if (colIndex === null || colIndex === undefined) return ''
  const header = headers[colIndex]
  return row[header] ?? ''
}

function resolveGroupId(groupText, groups) {
  if (!groupText) return null
  const matches = (groups ?? []).filter((g) => g.name === groupText)
  return matches.length === 1 ? matches[0].id : null
}

/** @returns {{ status, camperId?, reason?, disambiguation? }} */
function resolveCamperIdentity(row, headers, mapping, roster) {
  const name = cellValue(row, headers, mapping.displayName)
  const groupText = cellValue(row, headers, mapping.group)
  const externalId =
    mapping.externalId === null || mapping.externalId === undefined
      ? ''
      : cellValue(row, headers, mapping.externalId)

  if (externalId) {
    const byExternalId = (roster ?? []).filter((c) => c.external_id === externalId)
    if (byExternalId.length === 1) {
      return { status: IDENTITY_STATUS.MATCHED, camperId: byExternalId[0].id }
    }
    // Zero or ambiguous external_id matches fall through to name+group.
  }

  const groupId = resolveGroupId(groupText, mapping._groups)
  if (!groupId) {
    return { status: IDENTITY_STATUS.BLOCKED, reason: IDENTITY_REASONS.MISSING_GROUP }
  }

  const sameGroupMatches = (roster ?? []).filter(
    (c) => c.display_name === name && c.group_id === groupId
  )
  if (sameGroupMatches.length === 1) {
    return { status: IDENTITY_STATUS.OFFERED, camperId: sameGroupMatches[0].id }
  }
  if (sameGroupMatches.length > 1) {
    return {
      status: IDENTITY_STATUS.BLOCKED,
      reason: IDENTITY_REASONS.AMBIGUOUS_SAME_GROUP,
      disambiguation: {
        candidates: sameGroupMatches.map((c) => ({ camperId: c.id, createdAt: c.createdAt ?? null })),
      },
    }
  }

  const otherGroupMatches = (roster ?? []).filter(
    (c) => c.display_name === name && c.group_id !== groupId
  )
  if (otherGroupMatches.length > 0) {
    return { status: IDENTITY_STATUS.BLOCKED, reason: IDENTITY_REASONS.DUPLICATE_NAME_ACROSS_GROUPS }
  }

  return { status: IDENTITY_STATUS.OFFERED_NEW, groupId }
}

/** Resolve one member column's text to an activity+occurrence. */
function resolveMember(text, activityIndex, offeringIndex, occurrenceIdSet) {
  const activityIds = activityIndex?.[text] ?? []
  if (activityIds.length === 0) {
    return { ok: false, reason: CHOICE_REASONS.UNKNOWN_ACTIVITY }
  }
  if (activityIds.length > 1) {
    return { ok: false, reason: CHOICE_REASONS.AMBIGUOUS_ACTIVITY }
  }
  const activityId = activityIds[0]
  const occurrenceIds = (offeringIndex?.[activityId] ?? []).filter((occId) => occurrenceIdSet.has(occId))
  if (occurrenceIds.length === 0) {
    return { ok: false, reason: CHOICE_REASONS.ACTIVITY_NOT_OFFERED }
  }
  if (occurrenceIds.length > 1) {
    return { ok: false, reason: CHOICE_REASONS.AMBIGUOUS_ACTIVITY }
  }
  return { ok: true, activityId, occurrenceId: occurrenceIds[0] }
}

function resolveChoiceSlot(row, headers, choice, rank, mapping, activityIndex, offeringIndex, occurrenceIdSet) {
  const texts = choice.memberColumns.map((col) => cellValue(row, headers, col))
  const isNoPreference = texts.some((t) => (mapping.noPreferenceValues ?? []).includes(t))
  if (isNoPreference) {
    return { status: CHOICE_STATUS.NO_PREFERENCE, label: choice.label, rank }
  }
  if (texts.some((t) => !t)) {
    return { status: CHOICE_STATUS.BLOCKED, label: choice.label, rank, rowError: ROW_ERROR_REASONS.BLANK_RANK }
  }

  const memberResults = texts.map((t) => resolveMember(t, activityIndex, offeringIndex, occurrenceIdSet))
  const failures = memberResults.filter((m) => !m.ok)

  if (failures.length > 0) {
    if (choice.isLinked) {
      // Malformed linkage — a member outside the run/ineligible. The whole
      // choice blocks; the other member must NOT resolve independently.
      return { status: CHOICE_STATUS.BLOCKED, label: choice.label, rank, reason: CHOICE_REASONS.UNSUPPORTED_LINKED_CHOICE }
    }
    return { status: CHOICE_STATUS.BLOCKED, label: choice.label, rank, reason: failures[0].reason }
  }

  return {
    status: CHOICE_STATUS.RESOLVED,
    label: choice.label,
    rank,
    isLinked: !!choice.isLinked,
    members: memberResults.map((m) => ({ activityId: m.activityId, occurrenceId: m.occurrenceId })),
  }
}

/**
 * @param {{ rows, headers, mapping, roster, groups, run, occurrenceIndex, offeringIndex, activityIndex }} args
 *   headers: string[]  — same headers parsePreferenceSheet returned; mapping's
 *     column indices are positions into this array.
 *   roster: [{ id, display_name, group_id, external_id, is_active, createdAt }]
 *   groups: [{ id, name }]
 *   run: { id }  — unused by resolution logic itself; accepted so a caller can
 *     pass the same object it uses elsewhere without stripping it first.
 *   occurrenceIndex: [{ id }]  — the run's frozen, valid occurrence ids
 *   offeringIndex: { [activityId]: occurrenceId[] }
 *   activityIndex: { [activityText]: activityId[] }  — [] = unknown, >1 = ambiguous
 */
export function resolvePreferenceImport({
  rows,
  headers = [],
  mapping,
  roster = [],
  groups = [],
  run: _run,
  occurrenceIndex = [],
  offeringIndex = {},
  activityIndex = {},
}) {
  const occurrenceIdSet = new Set(occurrenceIndex.map((o) => o.id))
  const mappingWithGroups = { ...mapping, _groups: groups }

  const camperResolutions = []
  const choiceResolutions = []
  const rowResults = []
  let blockedCount = 0
  let warnCount = 0

  rows.forEach((row, rowIndex) => {
    const camper = resolveCamperIdentity(row, headers, mappingWithGroups, roster)
    camperResolutions.push({ rowIndex, ...camper })

    const choiceSlots = (mapping.choices ?? []).map((choice, i) =>
      resolveChoiceSlot(row, headers, choice, i + 1, mapping, activityIndex, offeringIndex, occurrenceIdSet)
    )

    // Duplicate rank: two rank slots resolved to the SAME occurrence.
    const seenOccurrences = new Map()
    const rowErrors = []
    choiceSlots.forEach((slot) => {
      if (slot.rowError) rowErrors.push({ reason: slot.rowError, rank: slot.rank })
      if (slot.status === CHOICE_STATUS.RESOLVED) {
        for (const member of slot.members) {
          if (seenOccurrences.has(member.occurrenceId)) {
            rowErrors.push({ reason: ROW_ERROR_REASONS.DUPLICATE_RANK, rank: slot.rank })
          } else {
            seenOccurrences.set(member.occurrenceId, slot.rank)
          }
        }
      }
    })

    choiceSlots.forEach((slot) => choiceResolutions.push({ rowIndex, ...slot }))

    const isBlocked =
      camper.status === IDENTITY_STATUS.BLOCKED ||
      choiceSlots.some((s) => s.status === CHOICE_STATUS.BLOCKED) ||
      rowErrors.length > 0
    const isWarn =
      !isBlocked &&
      (camper.status === IDENTITY_STATUS.OFFERED || camper.status === IDENTITY_STATUS.OFFERED_NEW)

    if (isBlocked) blockedCount += 1
    if (isWarn) warnCount += 1

    rowResults.push({ rowIndex, camper, choices: choiceSlots, rowErrors, blocked: isBlocked })
  })

  return { camperResolutions, rowResults, choiceResolutions, blockedCount, warnCount }
}
