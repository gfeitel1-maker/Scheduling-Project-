// @vitest-environment jsdom
// src/screens/AuthScreen.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AuthScreen from './AuthScreen'

vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signUp: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    },
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    }),
  },
}))

describe('AuthScreen', () => {
  it('renders login tab by default', () => {
    render(<AuthScreen />)
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy()
    expect(screen.getByText('Log in')).toBeTruthy()
  })

  it('switches to signup tab', () => {
    render(<AuthScreen />)
    fireEvent.click(screen.getAllByText('Sign up')[0])
    expect(screen.getByPlaceholderText('Camp Achva')).toBeTruthy()
  })

  it('login submit button is disabled when fields are empty', () => {
    render(<AuthScreen />)
    const btn = screen.getByRole('button', { name: /^Log in$/ })
    expect(btn.disabled).toBe(true)
  })
})
