// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DeleteWeekDialog from './DeleteWeekDialog'

const week = { id: 'w1', name: 'Week 1' }
const campId = 'camp1'

const repo = {
  loadTemplateData: async () => ({ templates: [], slots: [], snapshots: [] }),
  loadWeekExclusions: async () => ({ activityExclusions: [], groupExclusions: [] }),
}

function renderDialog(localClient) {
  return render(
    <DeleteWeekDialog
      week={week}
      campId={campId}
      localClient={localClient}
      repo={repo}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  )
}

const ERROR_MSG = 'Week could not be deleted. Please try again, or restart the app if this keeps happening.'

describe('DeleteWeekDialog failure paths', () => {
  it('shows error message when deleteWeek throws', async () => {
    const localClient = {
      deleteWeek: async () => { throw new Error('IPC timeout') },
    }
    renderDialog(localClient)

    const btn = await screen.findByRole('button', { name: /Delete .* permanently/i })
    fireEvent.click(btn)

    await waitFor(() => expect(screen.getByText(ERROR_MSG)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Cancel/i }).disabled).toBe(false)
  })

  it('shows error message when deleteWeek returns { error }', async () => {
    const localClient = {
      deleteWeek: async () => ({ error: 'unauthorized' }),
    }
    renderDialog(localClient)

    const btn = await screen.findByRole('button', { name: /Delete .* permanently/i })
    fireEvent.click(btn)

    await waitFor(() => expect(screen.getByText(ERROR_MSG)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Cancel/i }).disabled).toBe(false)
  })
})
