// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OpenSavedCampScreen from './OpenSavedCampScreen'
import LoadIncompleteScreen from './LoadIncompleteScreen'
import ModeSelectScreen from './ModeSelectScreen'
import { CAMP_FILE_FAILURE_TEXT } from './campFileMessages'

const PICKED = { ok: true, fileName: 'Willow.shoresh-camp', campName: 'Camp Willow', counts: { groups: 14, activities: 8, locations: 3 } }

function setup(over = {}) {
  const props = {
    onBack: vi.fn(),
    onPick: vi.fn().mockResolvedValue(PICKED),
    onOpen: vi.fn().mockResolvedValue({ ok: true, counts: { groups: 14 } }),
    onFinish: vi.fn(),
    onStartOver: vi.fn().mockResolvedValue({ ok: true }),
    holdDoneMs: 0,
    ...over,
  }
  render(<OpenSavedCampScreen {...props} />)
  return props
}

async function chooseFile() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose a camp file' }))
  await screen.findByLabelText('Camp name')
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ruth' } })
  fireEvent.change(screen.getByLabelText('Create a PIN'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open camp' }))
}

describe('start screen', () => {
  it('offers "Open a saved camp" as a peer card with its text', () => {
    const onChooseOpenFile = vi.fn()
    render(<ModeSelectScreen onChooseHost={() => {}} onChooseJoin={() => {}} onChooseOpenFile={onChooseOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: /Open a saved camp/ }))
    expect(screen.getByText('Start from a saved camp file')).toBeTruthy()
    expect(onChooseOpenFile).toHaveBeenCalledTimes(1)
  })
})

describe('Open a saved camp', () => {
  it('picks the file first, then reuses the camp setup form prefilled with the saved camp name', async () => {
    const props = setup()
    expect(props.onPick).not.toHaveBeenCalled()
    await chooseFile()
    expect(screen.getByLabelText('Camp name').value).toBe('Camp Willow')
    expect(screen.getByText(/Willow\.shoresh-camp/)).toBeTruthy()
    expect(screen.getByText(/14 groups/)).toBeTruthy()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('shows staged progress and hands over when done', async () => {
    let finish
    const props = setup({ onOpen: vi.fn().mockReturnValue(new Promise((r) => { finish = r })) })
    await chooseFile()
    await fillAndSubmit()
    await screen.findByText('Loading your camp')
    expect(screen.getByText('Checking the file').closest('li').textContent).toMatch(/✓/)
    expect(props.onOpen).toHaveBeenCalledWith({ campName: 'Camp Willow', adminName: 'Ruth', adminPin: '123456' })
    expect(props.onFinish).not.toHaveBeenCalled()
    finish({ ok: true, counts: {} })
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Done').closest('li').textContent).toMatch(/✓/)
  })

  it('a file that fails the check offers Try another file and no Start over (nothing was written)', async () => {
    const props = setup({ onPick: vi.fn().mockResolvedValueOnce({ ok: false, reason: 'newer_version', fileName: 'x.shoresh-camp', detail: {} }).mockResolvedValue(PICKED) })
    fireEvent.click(screen.getByRole('button', { name: 'Choose a camp file' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(CAMP_FILE_FAILURE_TEXT.newer_version)
    expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try another file' }))
    await screen.findByRole('button', { name: 'Choose a camp file' })
    expect(props.onPick).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the file dialog is cancelled', async () => {
    setup({ onPick: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Choose a camp file' }))
    await screen.findByRole('button', { name: 'Choose a camp file' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a load that fails offers Start over and not Try another file, and Start over runs', async () => {
    const props = setup({ onOpen: vi.fn().mockResolvedValue({ ok: false, reason: 'load_incomplete', detail: { message: 'x' } }) })
    await chooseFile()
    await fillAndSubmit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(CAMP_FILE_FAILURE_TEXT.load_incomplete)
    expect(screen.queryByRole('button', { name: 'Try another file' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(props.onStartOver).toHaveBeenCalledTimes(1))
  })

  it('says so when Start over itself fails', async () => {
    setup({
      onOpen: vi.fn().mockResolvedValue({ ok: false, reason: 'load_incomplete', detail: {} }),
      onStartOver: vi.fn().mockResolvedValue({ ok: false, reason: 'start_over_failed' }),
    })
    await chooseFile()
    await fillAndSubmit()
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Couldn.t start over/))
  })

  it('has a sentence for every rejection reason the file check can give', () => {
    for (const reason of ['not_a_camp_file', 'too_large', 'newer_version', 'unknown_entity', 'unknown_field', 'bad_type', 'dangling_reference', 'count_mismatch', 'camp_not_empty', 'load_incomplete']) {
      expect(CAMP_FILE_FAILURE_TEXT[reason], reason).toMatch(/\.$/)
    }
  })

  it('Back from the form returns to choosing a file; Back from choosing leaves', async () => {
    const props = setup()
    await chooseFile()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    await screen.findByRole('button', { name: 'Choose a camp file' })
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })
})

describe('a camp that did not finish opening', () => {
  it('blocks use and offers only Start over', async () => {
    const onStartOver = vi.fn().mockResolvedValue({ ok: true })
    render(<LoadIncompleteScreen onStartOver={onStartOver} />)
    expect(screen.getByRole('alert').textContent).toContain(CAMP_FILE_FAILURE_TEXT.load_incomplete)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(onStartOver).toHaveBeenCalledTimes(1))
  })
})
