// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import GroupGridFrame from './GroupGridFrame'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'

const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', start_time: '10:00:00', end_time: '11:00:00' },
]
const css = readFileSync(resolve('src/components/schedule/scheduleGrid.css'), 'utf8')

function renderFrame(collapsed = []) {
  return render(
    <GroupGridFrame
      groups={[{ id: 'g1', name: 'Alpha' }]}
      days={days}
      timeBlocks={timeBlocks}
      selectedGroup="g1"
      onSelectGroup={() => {}}
      geometry={makeGridGeometry({ slots: [], timeBlocks, groups: [{ id: 'g1' }] })}
      collapsedBlockIds={new Set(collapsed)}
      onToggleBlockCollapsed={() => {}}
      renderCell={({ cellKey, isCollapsed }) => (
        <div key={cellKey} className="cell" data-cell-key={cellKey} data-collapsed={isCollapsed ? '' : undefined} />
      )}
    />,
  )
}

describe('GroupGridFrame row-header collapse affordance', () => {
  it('every row-header toggle carries a decorative chevron and aria-expanded', () => {
    const { container } = renderFrame(['b2'])
    const toggles = [...container.querySelectorAll('.row-header-toggle')]
    expect(toggles).toHaveLength(2)
    for (const t of toggles) {
      const chevron = t.querySelector('.row-header-chevron')
      expect(chevron).not.toBeNull()
      expect(chevron.getAttribute('aria-hidden')).toBe('true')
    }
    expect(toggles[0].getAttribute('aria-expanded')).toBe('true')
    expect(toggles[1].getAttribute('aria-expanded')).toBe('false')
  })

  it('the chevron rotates off the row header data-collapsed attribute, not React state', () => {
    expect(css).toMatch(/\.row-header\[data-collapsed\] \.row-header-chevron\s*\{[^}]*transform:\s*rotate\(-90deg\)/)
    expect(css).toMatch(/\.row-header-chevron\s*\{[^}]*transition:\s*transform var\(--motion-fast\)/)
  })

  it('the collapse transition ships a prefers-reduced-motion fallback', () => {
    expect(css).toMatch(/\.cell\[data-collapsed\] \.cell-inner,[\s\S]*?animation:\s*collapsed-row-in var\(--motion-fast\)/)
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.row-header-chevron[\s\S]*?\n\}/)
    expect(reduced).not.toBeNull()
    expect(reduced[0]).toMatch(/transition:\s*none/)
    expect(reduced[0]).toMatch(/animation:\s*none/)
  })

  it('collapsed day entries are separated by a divider, not run together', () => {
    expect(css).toMatch(/\.cell\[data-collapsed\]:not\(\.row-header\) \+ \.cell\[data-collapsed\]\s*\{[^}]*box-shadow:\s*inset 1px 0 0 var\(--border\)/)
  })
})

describe('keyboard drag feedback', () => {
  it('the picked-up cell has its own data-attribute state', () => {
    expect(css).toMatch(/\.cell\[data-drag-source\] \.cell-inner\s*\{[^}]*outline:\s*2px dashed var\(--primary\)/)
  })
})
