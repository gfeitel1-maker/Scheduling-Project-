// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DuplicateNameDot from './DuplicateNameDot'

describe('DuplicateNameDot', () => {
  it('names the sibling and tells the director to rename or delete', () => {
    render(<DuplicateNameDot row={{ id: '1', name: 'Bunks' }} siblings={[{ id: '2', name: 'bunks' }]} entityLabel="group" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText(/"bunks"/)).not.toBeNull()
    expect(screen.queryByText(/Rename or delete one here to clear this\./)).not.toBeNull()
  })

  it('has no merge action — informational only', () => {
    render(<DuplicateNameDot row={{ id: '1', name: 'Bunks' }} siblings={[{ id: '2', name: 'bunks' }]} entityLabel="group" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull()
  })
})
