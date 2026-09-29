// @vitest-environment jsdom
//
// T301 slice 2 — one bundle's editor: name, period grid, scope control,
// delete. Controlled entirely by props (bundle/isDraft/siblingBundles/etc.);
// every write goes out through a callback prop and back in as a new `bundle`
// prop on the next render — no local optimistic mirror of period/scope/tier
// state, so a failed write simply never shows (the standing rule: never
// apply a failed write optimistically).
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BundleEditor from './BundleEditor.jsx'

const ACTIVITY = { id: 'act-1', name: 'Woodworking' }
const TIERS = [{ id: 'tier-jr', name: 'Juniors' }, { id: 'tier-sr', name: 'Seniors' }]
const DAYS = [{ id: 'day-mon', label: 'Mon' }, { id: 'day-tue', label: 'Tue' }]
const TIME_BLOCKS = [{ id: 'tb-2nd', name: 'Second Period' }, { id: 'tb-3rd', name: 'Third Period' }]
// Both divisions present at every cell, both routes agreeing — the simple
// case; sub-labelling is deriveBundlePickerCells' own tested concern.
const OCCURRENCE_CELLS = [
  { day_id: 'day-mon', time_block_id: 'tb-3rd', manual: ['tier-jr', 'tier-sr'], generated: ['tier-jr', 'tier-sr'] },
  { day_id: 'day-tue', time_block_id: 'tb-2nd', manual: ['tier-jr'], generated: ['tier-jr'] },
]

function draftBundle(overrides = {}) {
  return { id: null, elective_set_id: 'set-1', activity_id: 'act-1', name: '', scope_mode: 'all', periods: [], tierIds: [], ...overrides }
}
function savedBundle(overrides = {}) {
  return {
    id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Woodworking', scope_mode: 'all',
    periods: [{ day_id: 'day-mon', time_block_id: 'tb-3rd' }], tierIds: [], ...overrides,
  }
}

function renderEditor(props = {}) {
  return render(
    <BundleEditor
      bundle={draftBundle()}
      isDraft={true}
      activity={ACTIVITY}
      siblingBundles={[]}
      tiers={TIERS}
      days={DAYS}
      timeBlocks={TIME_BLOCKS}
      occurrenceCells={OCCURRENCE_CELLS}
      role="admin"
      onTogglePeriod={vi.fn().mockResolvedValue()}
      onSetScopeMode={vi.fn().mockResolvedValue()}
      onToggleTier={vi.fn().mockResolvedValue()}
      onSaveName={vi.fn().mockResolvedValue()}
      onDelete={vi.fn()}
      {...props}
    />
  )
}

describe('BundleEditor — draft state', () => {
  it('renders a dashed border and a real placeholder, never a written value, until a period is picked', () => {
    renderEditor()
    const nameInput = screen.getByLabelText(/Bundle name/i)
    expect(nameInput.value).toBe('')
    expect(nameInput.getAttribute('placeholder')).toBe('Pick a period below to name this bundle')
  })

  it('clicking an unselected period cell on a draft calls onTogglePeriod so the parent can mint the bundle', async () => {
    const onTogglePeriod = vi.fn().mockResolvedValue()
    renderEditor({ onTogglePeriod })
    fireEvent.click(screen.getByLabelText('Mon, Third Period — click to include'))
    await waitFor(() => expect(onTogglePeriod).toHaveBeenCalledTimes(1))
    const [calledBundle, cell, wasSelected] = onTogglePeriod.mock.calls[0]
    expect(calledBundle.id).toBeNull()
    expect(cell).toEqual({ day_id: 'day-mon', time_block_id: 'tb-3rd' })
    expect(wasSelected).toBe(false)
  })
})

describe('BundleEditor — saved state', () => {
  it('shows the real name and reflects the selected period as aria-pressed', () => {
    renderEditor({ bundle: savedBundle(), isDraft: false })
    const nameInput = screen.getByLabelText(/Bundle name/i)
    expect(nameInput.value).toBe('Woodworking')
    const cell = screen.getByLabelText('Mon, Third Period — included, click to remove')
    expect(cell.getAttribute('aria-pressed')).toBe('true')
    const other = screen.getByLabelText('Tue, Second Period — click to include')
    expect(other.getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking a SELECTED cell reports isSelected=true, so the parent removes it', async () => {
    const onTogglePeriod = vi.fn().mockResolvedValue()
    renderEditor({ bundle: savedBundle(), isDraft: false, onTogglePeriod })
    fireEvent.click(screen.getByLabelText('Mon, Third Period — included, click to remove'))
    await waitFor(() => expect(onTogglePeriod).toHaveBeenCalledTimes(1))
    expect(onTogglePeriod.mock.calls[0][2]).toBe(true)
  })

  it('commits a name edit on blur, via onSaveName', () => {
    const onSaveName = vi.fn().mockResolvedValue()
    renderEditor({ bundle: savedBundle(), isDraft: false, onSaveName })
    const nameInput = screen.getByLabelText(/Bundle name/i)
    fireEvent.change(nameInput, { target: { value: 'Woodworking — Mondays' } })
    fireEvent.blur(nameInput)
    expect(onSaveName).toHaveBeenCalledWith(expect.objectContaining({ id: 'bundle-1' }), 'Woodworking — Mondays')
  })

  it('a non-admin can still edit periods, but Delete bundle is disabled', () => {
    const onDelete = vi.fn()
    renderEditor({ bundle: savedBundle(), isDraft: false, role: 'staff', onDelete })
    const del = screen.getByRole('button', { name: /Delete bundle/i })
    expect(del.disabled).toBe(true)
    expect(del.title).toBe('Admin only')
    fireEvent.click(del)
    expect(onDelete).not.toHaveBeenCalled()

    const cell = screen.getByLabelText('Tue, Second Period — click to include')
    expect(cell.disabled).toBe(false)
  })

  it('an admin can delete, which calls onDelete with the bundle (no dialog owned by this component)', () => {
    const onDelete = vi.fn()
    const bundle = savedBundle()
    renderEditor({ bundle, isDraft: false, role: 'admin', onDelete })
    fireEvent.click(screen.getByRole('button', { name: /Delete bundle/i }))
    expect(onDelete).toHaveBeenCalledWith(bundle)
  })
})

describe('BundleEditor — saving state is scoped to the one control clicked', () => {
  it('only the clicked cell gets disabled+dimmed while its write is in flight; a second cell stays live', async () => {
    let resolveWrite
    const onTogglePeriod = vi.fn(() => new Promise((resolve) => { resolveWrite = resolve }))
    renderEditor({ bundle: savedBundle(), isDraft: false, onTogglePeriod })

    const clicked = screen.getByLabelText('Tue, Second Period — click to include')
    const untouched = screen.getByLabelText('Mon, Third Period — included, click to remove')
    fireEvent.click(clicked)

    await waitFor(() => expect(clicked.disabled).toBe(true))
    expect(clicked.style.opacity).toBe('0.55')
    expect(untouched.disabled).toBe(false)

    resolveWrite()
    await waitFor(() => expect(clicked.disabled).toBe(false))
  })
})

describe('BundleEditor — scope control', () => {
  it("switching to 'Only' calls onSetScopeMode, then reveals a chip per division present in this set", async () => {
    const onSetScopeMode = vi.fn().mockResolvedValue()
    renderEditor({ bundle: savedBundle(), isDraft: false, onSetScopeMode })
    fireEvent.click(screen.getByRole('button', { name: 'Only' }))
    await waitFor(() => expect(onSetScopeMode).toHaveBeenCalledWith(expect.objectContaining({ id: 'bundle-1' }), 'only'))
  })

  it("under 'only', clicking a division chip calls onToggleTier with the tier id and current selection state", async () => {
    const onToggleTier = vi.fn().mockResolvedValue()
    renderEditor({ bundle: savedBundle({ scope_mode: 'only', tierIds: ['tier-jr'] }), isDraft: false, onToggleTier })
    const juniors = screen.getByRole('button', { name: 'Juniors' })
    expect(juniors.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(juniors)
    await waitFor(() => expect(onToggleTier).toHaveBeenCalledWith(expect.objectContaining({ id: 'bundle-1' }), 'tier-jr', true))
  })
})

describe('BundleEditor — overlap warning', () => {
  it('warns, in a caution banner (never the error banner), when a sibling bundle of the SAME activity overlaps at a shared cell — and still shows the period selected', () => {
    const bundle = savedBundle({ name: 'Woodworking — Mondays' })
    const sibling = {
      id: 'bundle-2', name: 'Woodworking — Tuesdays', activity_id: 'act-1', scope_mode: 'all', tierIds: [],
      periods: [{ day_id: 'day-mon', time_block_id: 'tb-3rd' }],
    }
    renderEditor({ bundle, isDraft: false, siblingBundles: [sibling] })
    expect(screen.getByText(/Overlaps another Woodworking bundle/)).toBeTruthy()
    expect(screen.getByText(/Woodworking — Tuesdays/)).toBeTruthy()
    // The overlapping cell is still rendered selected — the warning never
    // blocks the save that caused it.
    const cell = screen.getByLabelText('Mon, Third Period — included, click to remove')
    expect(cell.getAttribute('aria-pressed')).toBe('true')
  })

  it('does not warn when no sibling shares a cell', () => {
    renderEditor({ bundle: savedBundle(), isDraft: false, siblingBundles: [] })
    expect(screen.queryByText(/Overlaps another/)).toBeNull()
  })
})
