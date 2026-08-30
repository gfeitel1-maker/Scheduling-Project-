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
})
