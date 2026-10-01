// C2 (board item 9b) — THE GUARD for a raw finding KIND CODE reaching a
// director-facing Finalize-refusal string.
//
// Sibling to src/screens/elective/assignment/findingLabelCoverage.test.js
// (T302), which guards a DIFFERENT render surface (the AssignmentPreview
// rail) and, by its own "WHAT THIS GUARD STRUCTURALLY CANNOT SEE" section,
// explicitly does not reach this one. This file guards the ONE function
// FinalizeFindingsList (DraftRunView.jsx) calls to turn ANY finding —
// OUTER_RESOURCE_CONFLICT today, or whatever a future producer adds — into a
// director-facing string: runStateCopy.js's `finalizeFindingMessage`.
//
// Unlike T302's enumeration-by-source-scan (there is only one real producer
// shape here, findRouteConflicts' OUTER_RESOURCE_CONFLICT, plus the open-ended
// "any future kind" case), this guard instead asserts the INVARIANT directly:
// for a realistic no-`.message` conflict finding, and for an arbitrary
// unrecognised kind, the rendered string never contains the raw `kind` value
// or a raw id, and never JSON.stringify's the finding (which would print the
// kind field right back out).
//
// PROVEN NON-VACUOUS — plant/restore performed and reported in the commit
// that introduced this file: temporarily changed `finalizeFindingMessage`'s
// generic fallback to interpolate `finding.kind` (`` `Finding: ${finding.kind}` ``
// instead of the plain-words sentence). Both tests below went RED, naming the
// leaked kind string in the failure diff; reverting restored GREEN.
//
// F6 (Code Reviewer round 3) — a SECOND surface in the SAME file,
// DraftRunView.jsx's `commitNotices` row (the always-visible run-state area,
// not the Finalize-refusal alert), had its OWN independent raw-code fallback
// (`f.message ?? f.kind ?? JSON.stringify(f)`) — the identical defect class
// on an adjacent render path this guard's unit tests above do not reach,
// since they call `finalizeFindingMessage` directly rather than driving
// DraftRunView's render. commitNotices now routes through the SAME
// `finalizeFindingMessage` this file guards, so the invariant above already
// covers its OUTPUT — but the source-scan below additionally proves the
// WIRING: that no second, independent raw-fallback expression has crept back
// into either file (the exact way F6 was found: a text pattern, not a value,
// since a passing unit test on the shared function says nothing about
// whether some OTHER call site still bypasses it).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeFindingMessage } from './runStateCopy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('finalizeFindingMessage — no raw finding kind code ever reaches the rendered string', () => {
  it('a real (no-.message) OUTER_RESOURCE_CONFLICT finding never contains its own kind code', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationId: 'loc-1', locationName: 'Boathouse',
      dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ groupId: 'g1', label: 'Canoeing' }, { groupId: 'g2', label: 'Kayaking' }],
    }
    const message = finalizeFindingMessage(finding, {
      days: [{ id: 'day-1', label: 'Monday' }], timeBlocks: [{ id: 'tb-1', name: 'First Period' }],
    })
    expect(message).toContain('Boathouse')
    expect(message).toContain('Canoeing')
    expect(message).not.toContain('OUTER_RESOURCE_CONFLICT')
  })

  // The open-ended case: whatever kind a future producer invents, as long as
  // it carries no `.message`, must still degrade to plain words rather than
  // leak its own identifier.
  it('an arbitrary unrecognised kind with no .message never leaks the kind string or raw ids, and is never JSON', () => {
    const finding = { kind: 'SOME_FUTURE_KIND_XYZ', locationId: 'loc-ghost-9', somethingWeird: 1 }
    const message = finalizeFindingMessage(finding, {})
    expect(message).not.toContain('SOME_FUTURE_KIND_XYZ')
    expect(message).not.toContain('loc-ghost-9')
    expect(message).not.toMatch(/^\{/)
    expect(typeof message).toBe('string')
  })

  it('a finding carrying its own .message is rendered verbatim — the generic/conflict fallbacks never override a real message', () => {
    expect(finalizeFindingMessage({ kind: 'ANYTHING', message: 'Custom text' }, {})).toBe('Custom text')
  })
})

// F6 — the WIRING guard. Both known director-facing finding renders in this
// screen (FinalizeFindingsList's refusal rows, commitNotices' always-visible
// rows) must call finalizeFindingMessage rather than carry their own
// independent `?? f.kind` / `JSON.stringify(f)` fallback — a text-level
// pattern a passing unit test on the shared function cannot see.
describe('source-scan: no independent raw-kind fallback survives in either file', () => {
  const draftRunViewSrc = fs.readFileSync(path.join(HERE, 'DraftRunView.jsx'), 'utf8')

  it('DraftRunView.jsx contains no `?? f.kind` / `?? .kind` message fallback outside the component this guard covers', () => {
    // The ONLY acceptable way either render site may read a finding's kind
    // at all is by calling finalizeFindingMessage(f, ...) — never by
    // interpolating `f.kind` (or any destructured `.kind`) into a message
    // string directly.
    const rawKindFallback = /message=\{[^}]*\?\?\s*f\.kind/
    const rawJsonFallback = /message=\{[^}]*JSON\.stringify\(f\)/
    expect(draftRunViewSrc).not.toMatch(rawKindFallback)
    expect(draftRunViewSrc).not.toMatch(rawJsonFallback)
  })

  it('both finding-message render sites call finalizeFindingMessage — confirms this guard is actually wired to what renders, not just to the pure function', () => {
    const callSites = draftRunViewSrc.match(/finalizeFindingMessage\(/g) ?? []
    // One call inside FinalizeFindingsList (the refusal rows) and one inside
    // the commitNotices map (F6) — two, not one, or the fix only reached
    // half the surfaces this round named.
    expect(callSites.length).toBeGreaterThanOrEqual(2)
  })
})
