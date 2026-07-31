// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DeleteRecordDialog from './DeleteRecordDialog'

// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
//
// T23: the confirmation is not scoped to groups. An activity placed in 30 cells
// is exactly the decision the ADR says the count exists to inform, and a
// director who learns that deleting is confirmed will assume it always is.
// These lock that in, and lock in that the two entities say DIFFERENT true
// things — §2: an activity's cells are emptied and kept, a group's week is
// removed.

function preview(over = {}) {
  return {
    ok: true,
    entity: 'activities',
    entity_id: 'a1',
    name: 'Swimming',
    destructive: false,
    slot_count: 0,
    routes: [],
    anchor_count: 0,
    overlay_count: 0,
    ...over,
  }
}

const noop = () => {}

describe('DeleteRecordDialog: an activity gets the same confirmation a group does', () => {
  it('states the real count before anything happens', () => {
    render(<DeleteRecordDialog preview={preview({ slot_count: 30 })} onCancel={noop} onDeleted={noop} />)

    expect(screen.getByText(/Swimming is used in 30 places in your schedules/)).toBeTruthy()
    // The count is on the button too, so it is unmissable at the moment of
    // committing — not only in prose above it.
    expect(screen.getByRole('button', { name: 'Delete and clear 30 places' })).toBeTruthy()
  })

  it('says the cells are emptied and kept — not that a week is removed', () => {
    render(<DeleteRecordDialog preview={preview({ slot_count: 30 })} onCancel={noop} onDeleted={noop} />)

    expect(screen.getByText(/empties those cells/)).toBeTruthy()
    expect(screen.getByText(/everything else in the week stays exactly where it is/)).toBeTruthy()
    // The group wording must not leak onto an activity: nothing is removed
    // wholesale, so promising that would be false.
    expect(screen.queryByText(/removes its whole week/)).toBeNull()
  })

  it('warns that putting the activity back does not put it back on the schedule', () => {
    render(<DeleteRecordDialog preview={preview({ slot_count: 30 })} onCancel={noop} onDeleted={noop} />)

    // ADR §3: a director may reasonably expect restore to undo everything.
    expect(screen.getByText(/the cells it was in stay empty/)).toBeTruthy()
  })

  it('does not invent consequences for an activity nothing uses', () => {
    render(<DeleteRecordDialog preview={preview({ slot_count: 0 })} onCancel={noop} onDeleted={noop} />)

    expect(screen.getByText(/Nothing in your schedules uses Swimming/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete activity' })).toBeTruthy()
  })
})

describe('DeleteRecordDialog: a group says the harder, truer thing', () => {
  it('says the week is removed and points at Versions by name', () => {
    render(
      <DeleteRecordDialog
        preview={preview({ entity: 'groups', name: 'Bunk 2', destructive: true, slot_count: 50 })}
        onCancel={noop}
        onDeleted={noop}
      />
    )

    expect(screen.getByText(/Bunk 2 is used in 50 places in your schedules/)).toBeTruthy()
    expect(screen.getByText(/removes its whole week from both schedules/)).toBeTruthy()
    // ADR §4: the copy must tell the director where the week went, in their
    // words — "Versions on the Schedule screen", never "a snapshot was taken".
    expect(screen.getByText(/Versions on the Schedule screen/)).toBeTruthy()
    expect(screen.queryByText(/snapshot/i)).toBeNull()
  })
})
