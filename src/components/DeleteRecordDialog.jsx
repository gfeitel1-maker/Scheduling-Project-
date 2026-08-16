import React, { useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { deleteRefusalMessage } from '../utils/writeErrorMessage'

// The confirmation for deleting a setup record a schedule uses.
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
//
// The count is the whole basis on which a director decides, so it is counted
// (previewDelete), stated BEFORE the action, and never reported afterwards as
// a surprise. Where the week goes is said in words a director could act on
// months later without knowing what a snapshot is — and where a record does
// NOT come back the same way, that is said too, because they would reasonably
// expect otherwise.

const LABEL = {
  groups: { one: 'group', the: 'group' },
  activities: { one: 'activity', the: 'activity' },
  days_of_operation: { one: 'day', the: 'day' },
  // M3c — locations join the shared delete path (D2), but are never
  // schedule-shaped: they have no "place in a schedule", so this file's own
  // "places" plural for a schedule cell would collide confusingly with the
  // entity's own name. LABEL is still needed for the confirmLabel fallback.
  locations: { one: 'place', the: 'place' },
}

function places(n) {
  return `${n} place${n === 1 ? '' : 's'}`
}

function activityCount(n) {
  return `${n} activit${n === 1 ? 'y' : 'ies'}`
}

// One concept, one name, across both routes: a director sees "your schedules",
// never "templates" or "routes".
function whatChanges(preview) {
  const { entity, name, slot_count, ref_count, anchor_count, overlay_count } = preview
  const who = name || `this ${LABEL[entity].the}`

  if (entity === 'locations') {
    if (ref_count === 0) return `Nothing uses ${who} right now.`
    return `${activityCount(ref_count)} use ${who} right now. Deleting it takes ${who} off those activities — they stay on the schedule, just without a place.`
  }

  if (entity === 'activities') {
    if (slot_count === 0) return `Nothing in your schedules uses ${who}.`
    return `${who} is used in ${places(slot_count)} in your schedules. Deleting it empties those cells — everything else in the week stays exactly where it is.`
  }

  if (entity === 'groups') {
    if (slot_count === 0) return `Nothing in your schedules uses ${who}.`
    return `${who} is used in ${places(slot_count)} in your schedules. Deleting it removes its whole week from both schedules — there is nothing left behind to fill in.`
  }

  const parts = []
  if (slot_count > 0) parts.push(places(slot_count))
  if (anchor_count > 0) parts.push(`${anchor_count} fixed event${anchor_count === 1 ? '' : 's'}`)
  if (overlay_count > 0) parts.push(`${overlay_count} trip${overlay_count === 1 ? '' : 's'} or other overlay`)
  if (parts.length === 0) return `Nothing in your schedules uses ${who}.`
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${who} holds ${list} across your schedules. Deleting it removes that day from every group's week.`
}

function howItComesBack(preview) {
  const { entity, name, slot_count } = preview
  const who = name || 'It'

  if (entity === 'locations') {
    return `${who} goes to Trash, and you can put it back from there — but the activities won’t automatically start using it again.`
  }

  if (entity === 'activities') {
    if (slot_count === 0) return `${who} goes to Trash, and you can put it back from there.`
    return `${who} goes to Trash, and you can put it back from there — but the cells it was in stay empty. Putting it back does not put it back on the schedule.`
  }

  if (slot_count === 0) return `${who} goes to Trash, and you can put it back from there.`
  return `Both schedules are saved exactly as they are now, before anything is removed. You can bring the week back later from Versions on the Schedule screen, and ${who} comes back from Trash.`
}

export default function DeleteRecordDialog({ preview, onCancel, onDeleted }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

  // Locations preview with `ref_count` (bound activities), never `slot_count`
  // (a schedule-grid concept locations don't have) — exactly one of the two
  // is ever present on a given preview, so a plain `??` picks it without
  // needing to branch on `entity` (mirrors writeErrorMessage.js's own
  // slot_count ?? ref_count convention). deleteRecord's own count-drift
  // guard is entity-agnostic about which of the two arrives.
  const expectedCount = preview.slot_count ?? preview.ref_count

  async function confirm() {
    setWorking(true)
    setError(null)
    let result
    try {
      result = await localClient.deleteRecord(preview.entity, preview.entity_id, expectedCount)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete records.'
          : deleteRefusalMessage('unknown', preview)
      )
      setWorking(false)
      return
    }
    if (!result || result.error) {
      setError(deleteRefusalMessage(result?.error ?? 'unknown', { ...preview, ...result }))
      setWorking(false)
      return
    }
    onDeleted(result)
  }

  const destructive = preview.destructive && preview.slot_count > 0
  const confirmLabel =
    preview.entity === 'locations'
      ? preview.ref_count > 0
        ? `Delete and clear ${activityCount(preview.ref_count)}`
        : `Delete ${LABEL[preview.entity].the}`
      : preview.slot_count > 0
        ? `Delete and clear ${places(preview.slot_count)}`
        : `Delete ${LABEL[preview.entity].the}`

  return (
    <div style={{ ...overlay, ...enterStyle }}>
      <div style={panel}>
        <div style={title}>Delete “{preview.name || 'this record'}”?</div>

        <p style={body}>{whatChanges(preview)}</p>
        <div style={destructive ? recoveryStrong : recovery}>{howItComesBack(preview)}</div>

        {error && <div style={{ ...S.errorBanner, marginTop: 14, marginBottom: 0 }}>{error}</div>}

        <div style={actions}>
          <button className="press-97" onClick={onCancel} disabled={working} style={S.btnSecondary}>
            Cancel
          </button>
          <button onClick={confirm} disabled={working} style={S.btnDanger}>
            {working ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const panel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 520,
  maxWidth: '100%',
}

const title = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 14,
}

const body = { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px' }

const recovery = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const recoveryStrong = {
  ...recovery,
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--primary) 8%, var(--surface))',
  border: '1px solid color-mix(in srgb, var(--primary) 25%, var(--border))',
  borderRadius: 8,
  padding: '10px 12px',
}

const actions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 22,
}
