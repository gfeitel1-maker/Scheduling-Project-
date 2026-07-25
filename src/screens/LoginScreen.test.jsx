// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import LoginScreen from './LoginScreen'

describe('LoginScreen submit rejection recovery', () => {
  it('recovers from a rejected onSubmit instead of getting stuck on "Signing in…"', async () => {
    let rejectSubmit
    const pending = new Promise((_resolve, reject) => { rejectSubmit = reject })
    const onSubmit = vi.fn().mockReturnValue(pending)

    render(<LoginScreen campName="Camp Test" onSubmit={onSubmit} />)

    fireEvent.change(screen.getByPlaceholderText('e.g. Sarah Cohen'), { target: { value: 'Sarah' } })
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: '1234' } })

    const submitBtn = screen.getByRole('button', { name: 'Sign in' })
    fireEvent.click(submitBtn)

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    // While submitting, the button flips to "Signing in…" and is disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Signing in…' }).disabled).toBe(true)
    })

    // Now let the in-flight request reject
    rejectSubmit(new Error('name and pin are required'))

    // After the rejection, it becomes a clickable "Sign in" button again
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Sign in' })
      expect(btn.disabled).toBe(false)
    })

    // Shows the connection-error message, not the wrong-PIN message
    expect(screen.getByText(/Couldn't reach the app right now/)).toBeTruthy()
    expect(screen.queryByText(/doesn't match/)).toBeNull()

    // PIN was not cleared since it was never actually wrong
    expect(screen.getByPlaceholderText('••••').value).toBe('1234')
  })
})
