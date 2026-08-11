// D4 — Setup Readiness integration. Pure, React-free helper that derives the
// "optional areas not yet configured" sentence from the same getReadiness
// rows every other surface reads (readiness.js, ReadinessHub.jsx). It never
// restates the blocking (required/missing) message — that stays
// describeReadiness's job — and it never uses error/danger/blocked/
// misconfigured wording, since an absent optional area is not a problem.

import { describe, it, expect } from 'vitest'
import { describeOptionalGaps } from './importOutcomeModel'

function row(key, label, kind, state) {
  return { key, label, screen: key, kind, state }
}

describe('describeOptionalGaps', () => {
  it('names optional areas that are absent when required areas are all ready', () => {
    const readiness = [
      row('tiers', 'Units', 'required', 'ready'),
      row('groups', 'Groups', 'required', 'ready'),
      row('days', 'Days', 'required', 'ready'),
      row('timeblocks', 'Time Blocks', 'required', 'ready'),
      row('activities', 'Activities', 'required', 'ready'),
      row('anchors', 'Fixed Events', 'optional', 'optional'),
      row('dayoverrides', 'Day Overrides', 'optional', 'ready'),
      row('location', 'Locations', 'forward', 'optional'),
      row('staffing', 'Staffing', 'forward', 'optional'),
    ]

    const sentence = describeOptionalGaps(readiness)

    expect(sentence).toContain('Fixed Events')
    expect(sentence).toContain('Locations')
    expect(sentence).toContain('Staffing')
    expect(sentence).not.toContain('Day Overrides')
  })

  it('returns null when no optional areas are absent', () => {
    const readiness = [
      row('tiers', 'Units', 'required', 'ready'),
      row('anchors', 'Fixed Events', 'optional', 'ready'),
      row('dayoverrides', 'Day Overrides', 'optional', 'ready'),
      row('location', 'Locations', 'forward', 'ready'),
      row('staffing', 'Staffing', 'forward', 'ready'),
    ]

    expect(describeOptionalGaps(readiness)).toBeNull()
  })

  it('speaks only to optional areas even when a required area is missing', () => {
    const readiness = [
      row('tiers', 'Units', 'required', 'missing'),
      row('groups', 'Groups', 'required', 'ready'),
      row('anchors', 'Fixed Events', 'optional', 'optional'),
    ]

    const sentence = describeOptionalGaps(readiness)

    expect(sentence).toContain('Fixed Events')
    expect(sentence).not.toContain('Units')
    expect(sentence).not.toMatch(/missing/i)
  })

  it('never uses alarming wording', () => {
    const readiness = [
      row('tiers', 'Units', 'required', 'missing'),
      row('anchors', 'Fixed Events', 'optional', 'optional'),
      row('location', 'Locations', 'forward', 'optional'),
    ]

    const sentence = describeOptionalGaps(readiness)

    expect(sentence).not.toMatch(/error|blocked|misconfigured|danger|invalid/i)
  })

  it('returns null for an empty readiness array', () => {
    expect(describeOptionalGaps([])).toBeNull()
    expect(describeOptionalGaps(null)).toBeNull()
    expect(describeOptionalGaps(undefined)).toBeNull()
  })
})
