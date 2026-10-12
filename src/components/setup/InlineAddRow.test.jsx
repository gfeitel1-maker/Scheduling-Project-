// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import InlineAddRow from './InlineAddRow'

const FIELDS = [
  { key: 'label', type: 'text', placeholder: 'Label (e.g. Monday)', required: true },
  { key: 'day_of_week', type: 'select', default: 1, options: [
    { value: 0, label: 'Sunday' },
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
  ] },
]

function renderRow({ fields = FIELDS, adding = false, onAdd = vi.fn(() => Promise.resolve(true)) } = {}) {
  const utils = render(
    <table><tbody>
      <InlineAddRow fields={fields} adding={adding} onAdd={onAdd} />
    </tbody></table>
  )
  return { onAdd, ...utils }
}

describe('InlineAddRow', () => {
  it('renders one control per configured field, honoring placeholder and select default', () => {
    renderRow()
    expect(screen.getByPlaceholderText('Label (e.g. Monday)')).not.toBeNull()
    // Select seeded with its configured default (Monday = 1).
    expect(screen.getByDisplayValue('Monday')).not.toBeNull()
  })

  it('disables "+ Add" until every required field is non-empty', () => {
    renderRow()
    const addBtn = screen.getByText('+ Add')
    expect(addBtn.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Wednesday' } })
    expect(addBtn.disabled).toBe(false)
  })

  it('commits via onAdd on "+ Add" click with the collected field values', async () => {
    const { onAdd } = renderRow()
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(onAdd.mock.calls[0][0]).toMatchObject({ label: 'Wednesday', day_of_week: 1 })
  })

  it('commits on Enter pressed in any field', async () => {
    const { onAdd } = renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Thursday' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
  })

  it('commits on blur when focus leaves the row entirely', async () => {
    const { onAdd } = renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Friday' } })
    fireEvent.blur(input, { relatedTarget: document.body })

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
  })

  it('does NOT commit when focus moves to another control within the row', async () => {
    const { onAdd } = renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Saturday' } })
    const select = screen.getByDisplayValue('Monday')
    // Blur whose relatedTarget is still inside the row must not commit.
    fireEvent.blur(input, { relatedTarget: select })

    expect(onAdd).not.toHaveBeenCalled()
  })

  it('does NOT commit on blur when a required field is empty', () => {
    const { onAdd } = renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('clears required fields and restores defaults after a successful add, keeping the row present', async () => {
    const onAdd = vi.fn(() => Promise.resolve(true))
    renderRow({ onAdd })
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Wednesday' } })
    // Change the select away from its default so we can prove it restores.
    fireEvent.change(screen.getByDisplayValue('Monday'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    // Required text field cleared...
    await waitFor(() => expect(screen.getByPlaceholderText('Label (e.g. Monday)').value).toBe(''))
    // ...select restored to its configured default (Monday), row still there.
    expect(screen.getByDisplayValue('Monday')).not.toBeNull()
  })

  it('does NOT clear the row when onAdd resolves falsy (failed add)', async () => {
    const onAdd = vi.fn(() => Promise.resolve(false))
    renderRow({ onAdd })
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    // Value preserved so the director can retry without retyping.
    expect(input.value).toBe('Wednesday')
  })

  it('renders trailingCells between the field cells and the action cell', () => {
    render(
      <table><tbody>
        <InlineAddRow fields={FIELDS} adding={false} onAdd={vi.fn()} trailingCells={<td data-testid="spacer" />} />
      </tbody></table>
    )
    const cells = document.querySelectorAll('tr td')
    // 2 field cells, then the spacer, then the +Add cell.
    expect(cells[2].getAttribute('data-testid')).toBe('spacer')
    expect(cells[cells.length - 1].textContent).toContain('+ Add')
  })

  it('disables "+ Add" when the screen-level `disabled` guard is set, even with required fields filled', () => {
    render(
      <table><tbody>
        <InlineAddRow fields={FIELDS} adding={false} onAdd={vi.fn()} disabled />
      </tbody></table>
    )
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Wednesday' } })
    expect(screen.getByText('+ Add').disabled).toBe(true)
  })

  it('does NOT commit on "+ Add" click, Enter, or blur-out when `disabled` is set', async () => {
    const onAdd = vi.fn(() => Promise.resolve(true))
    render(
      <table><tbody>
        <InlineAddRow fields={FIELDS} adding={false} onAdd={onAdd} disabled />
      </tbody></table>
    )
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Wednesday' } })

    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input, { relatedTarget: document.body })

    // Give any (incorrectly) scheduled async commit a chance to fire.
    await Promise.resolve()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('commits normally when `disabled` is absent (default false) — behavior unchanged', async () => {
    const { onAdd } = renderRow()
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))
    await waitFor(() => expect(onAdd).toHaveBeenCalled())
  })

  it('renders text, time, and select field types', () => {
    renderRow({ fields: [
      { key: 'name', type: 'text', placeholder: 'Name', required: true },
      { key: 'start', type: 'time' },
      { key: 'pod', type: 'select', default: 'morning', options: [{ value: 'morning', label: 'Morning' }] },
    ] })
    expect(screen.getByPlaceholderText('Name')).not.toBeNull()
    expect(document.querySelector('input[type="time"]')).not.toBeNull()
    expect(screen.getByDisplayValue('Morning')).not.toBeNull()
  })

  // Design audit 2026-10-12 #1 (DESIGN_STANDARD §6a): after an Enter or "+ Add" commit the row is
  // ready for the next entry, so focus returns to its first field instead of falling to <body>.
  it('returns focus to the first field after a successful Enter commit', async () => {
    renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    input.focus()
    fireEvent.change(input, { target: { value: 'Thursday' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input.value).toBe(''))
    expect(document.activeElement).toBe(input)
  })

  it('returns focus to the first field after a successful "+ Add" click', async () => {
    renderRow()
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    fireEvent.change(input, { target: { value: 'Thursday' } })
    const add = screen.getByText('+ Add')
    add.focus()
    fireEvent.click(add)
    await waitFor(() => expect(input.value).toBe(''))
    expect(document.activeElement).toBe(input)
  })

  it('a commit from tabbing out of the row does not pull focus back', async () => {
    render(<><table><tbody><InlineAddRow fields={FIELDS} onAdd={vi.fn(() => Promise.resolve(true))} /></tbody></table><button>elsewhere</button></>)
    const input = screen.getByPlaceholderText('Label (e.g. Monday)')
    const elsewhere = screen.getByText('elsewhere')
    fireEvent.change(input, { target: { value: 'Thursday' } })
    elsewhere.focus()
    fireEvent.blur(input, { relatedTarget: elsewhere })
    await waitFor(() => expect(input.value).toBe(''))
    expect(document.activeElement).toBe(elsewhere)
  })

  // Consistency audit 2026-10-12 A2: a row with no required field (Days: weekday has a default, the label
  // is optional) must not create a record just because focus passed through it.
  it('an untouched row does not commit on blur, even with no required fields', async () => {
    const onAdd = vi.fn(() => Promise.resolve(true))
    const fields = [{ key: 'day', type: 'select', default: 1, options: [{ value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' }] }, { key: 'label', type: 'text', placeholder: 'Optional' }]
    render(<><table><tbody><InlineAddRow fields={fields} onAdd={onAdd} /></tbody></table><button>elsewhere</button></>)
    fireEvent.blur(screen.getByPlaceholderText('Optional'), { relatedTarget: screen.getByText('elsewhere') })
    await new Promise((r) => setTimeout(r, 20))
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.change(screen.getByDisplayValue('Monday'), { target: { value: '2' } })
    fireEvent.blur(screen.getByPlaceholderText('Optional'), { relatedTarget: screen.getByText('elsewhere') })
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
  })
})
