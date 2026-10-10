// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import AssignmentPreview from './AssignmentPreview'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments'
import { findMismatches } from './buildOfferings'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds'

const OCC = [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
const TBS = [{ id: 'tb-1', name: 'Period 2' }]
const ACTIVITIES = [{ id: 'act-1', name: 'Swim' }]
const CAMPERS = [{ id: 'cam-1', display_name: 'Ari Green' }]

describe('AssignmentPreview', () => {
  it('shows the zero-assignment sub-state with NO Commit button', () => {
    render(
      <AssignmentPreview
        assignments={[]} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByText('No campers could be placed')).not.toBeNull()
    expect(screen.queryByText(/commit/i)).toBeNull()
  })

  // T316 — a run refused before any assignment exists (e.g. a blank limited
  // capacity) must still tell the director why, not just "no campers placed".
  it('shows findings alongside the zero-assignment sub-state, with NO Commit button', () => {
    const findings = [{
      kind: 'INVALID_CAPACITY', activity_id: 'act-1',
      message: '"Archery": capacity blank.',
    }]
    render(
      <AssignmentPreview
        assignments={[]} findings={findings} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByText(/capacity blank/)).not.toBeNull()
    expect(screen.queryByText(/commit/i)).toBeNull()
  })

  it('disables the commit control for a non-admin role', () => {
    const assignments = [{ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 1, flags: [] }]
    render(
      <AssignmentPreview
        assignments={assignments} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="staff" onCommit={vi.fn()} committing={false}
      />
    )
    const btn = screen.getByRole('button', { name: /commit/i })
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe('Admin only')
  })

  it('enables the commit control for an admin role with placements', () => {
    const assignments = [{ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 1, flags: [] }]
    render(
      <AssignmentPreview
        assignments={assignments} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByRole('button', { name: /commit/i }).disabled).toBe(false)
  })

  // L1 — two occurrences in the same day/time-block but different tiers
  // rendered an IDENTICAL label ("Monday, Period 2"), which is exactly what
  // hid the H4 double-placement bug (a director could not tell them apart).
  it('includes the tier/division name in the occurrence label so same-cell tiers are distinguishable', () => {
    const occurrences = [
      { id: 'occ-juniors', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-juniors' },
      { id: 'occ-seniors', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-seniors' },
    ]
    const tiers = [
      { id: 'tier-juniors', name: 'Juniors' },
      { id: 'tier-seniors', name: 'Seniors' },
    ]
    const assignments = [
      { camper_id: 'cam-1', occurrence_id: 'occ-juniors', activity_id: 'act-1', preference_rank: 1, flags: [] },
    ]
    render(
      <AssignmentPreview
        assignments={assignments} findings={[]} occurrences={occurrences} days={DAYS} timeBlocks={TBS}
        tiers={tiers} activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByText(/Juniors/)).not.toBeNull()
    expect(screen.getByText(/Seniors/)).not.toBeNull()
  })
})

// T300 — a finding names an activity the way the DIRECTOR spells it.
//
// These tests drive the RENDERED output, not the engine's raw `message`, and
// they call the real producers (`buildElectiveAssignments`, `findMismatches`)
// rather than hand-writing a finding. That is deliberate: the renderer
// substitutes the display name into a sentence the producer already built, so
// the two are coupled through the message text. A hand-written finding would
// let the producer change its wording — or its quote characters — while these
// stayed green and the director went back to reading `arts&crafts`.
describe('AssignmentPreview — findings name an activity the way a director spells it', () => {
  const ARTS = { id: 'a-arts', name: 'Arts & Crafts' }
  const SWIM = { id: 'a-swim', name: 'Swim' }
  // Derived, never hand-spelled: the key is whatever the one canonicaliser says
  // it is, so this test cannot drift from the rule it is about.
  const ARTS_KEY = electiveChoiceLabelKey(ARTS.name)
  const SWIM_KEY = electiveChoiceLabelKey(SWIM.name)
  const OCC_1 = [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }]
  const four = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, display_name: id.toUpperCase() }))

  const preview = (props) => render(
    <AssignmentPreview
      occurrences={OCC_1} days={DAYS} timeBlocks={TBS}
      activities={[ARTS, SWIM]} role="admin" onCommit={vi.fn()} committing={false}
      {...props}
    />
  )

  it('names the declined offering by its activity name when it misses its minimum', () => {
    const solved = buildElectiveAssignments({
      campers: four,
      occurrences: [{ id: 'occ-1' }],
      offerings: [
        { occurrence_id: 'occ-1', labelKey: ARTS_KEY, activity_id: ARTS.id, capacity: 10, minimum: 5 },
        { occurrence_id: 'occ-1', labelKey: SWIM_KEY, activity_id: SWIM.id, capacity: 10, minimum: null },
      ],
      preferences: four.flatMap((c) => [
        { camper_id: c.id, labelKey: ARTS_KEY, rank: 1 },
        { camper_id: c.id, labelKey: SWIM_KEY, rank: 2 },
      ]),
    })
    expect(solved.findings.map((f) => f.kind)).toContain('BELOW_MINIMUM')

    const { container } = preview({ assignments: solved.assignments, findings: solved.findings, campers: four })
    expect(container.textContent).toContain('“Arts & Crafts” had 4 of the 5 campers it needs to run')
    expect(container.textContent).not.toContain(ARTS_KEY)
  })

  it('names the offering kept below its minimum by its activity name', () => {
    const two = [{ id: 'c1', display_name: 'C1' }, { id: 'c2', display_name: 'C2' }]
    const solved = buildElectiveAssignments({
      campers: two,
      occurrences: [{ id: 'occ-1' }],
      offerings: [
        { occurrence_id: 'occ-1', labelKey: ARTS_KEY, activity_id: ARTS.id, capacity: 10, minimum: 5 },
        { occurrence_id: 'occ-1', labelKey: SWIM_KEY, activity_id: SWIM.id, capacity: 10, minimum: null },
      ],
      lockedAssignments: [{ camperId: 'c2', occurrenceId: 'occ-1', activityId: ARTS.id }],
      preferences: [
        { camper_id: 'c1', labelKey: ARTS_KEY, rank: 1 },
        { camper_id: 'c1', labelKey: SWIM_KEY, rank: 2 },
      ],
    })
    expect(solved.findings.map((f) => f.kind)).toContain('KEPT_BELOW_MINIMUM')

    const { container } = preview({ assignments: solved.assignments, findings: solved.findings, campers: two })
    expect(container.textContent).toContain('“Arts & Crafts” has 2 of the 5 campers it needs to run')
    expect(container.textContent).not.toContain(ARTS_KEY)
  })

  // T247's finding, the same defect one screen over: an offering nobody ranked
  // carries only a labelKey, so it is resolved back through the activity list.
  it('names an unranked offering by its activity name', () => {
    const offerings = [{ occurrence_id: 'occ-1', labelKey: ARTS_KEY, activity_id: ARTS.id, capacity: 10, minimum: null }]
    const findings = findMismatches({ offerings, preferences: [] })
    expect(findings.map((f) => f.kind)).toContain('UNRANKED_OFFERING')

    const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] }]
    const { container } = preview({ assignments, findings, campers: [{ id: 'c1', display_name: 'C1' }] })
    expect(container.textContent).toContain('"Arts & Crafts" offered but never ranked')
    expect(container.textContent).not.toContain(ARTS_KEY)
  })

  // A linked choice is named by the CHOICE's own label, not an activity's — the
  // set is the thing the director named. Nothing in `src/` passes `choices` to
  // the solver yet, so this finding is unreachable from this screen today; the
  // renderer is wired for it so that whoever wires the solver does not have to
  // rediscover this bug.
  it('names an unsupported linked choice by its choice label', () => {
    const solved = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [{ id: 'occ-1' }],
      offerings: [{ occurrence_id: 'occ-1', labelKey: ARTS_KEY, activity_id: ARTS.id, capacity: 5 }],
      preferences: [{ camper_id: 'c1', labelKey: ARTS_KEY, rank: 1 }],
      choices: [{ id: 'C', labelKey: ARTS_KEY, is_linked: 0 }],
      choiceOfferings: [
        { choice_id: 'C', occurrence_id: 'occ-1', activity_id: ARTS.id },
        { choice_id: 'C', occurrence_id: 'occ-gone', activity_id: ARTS.id },
      ],
    })
    expect(solved.findings.map((f) => f.kind)).toContain('UNSUPPORTED_LINKED_CHOICE')

    const { container } = preview({
      assignments: solved.assignments,
      findings: solved.findings,
      campers: [{ id: 'c1', display_name: 'C1' }],
      choices: [{ id: 'C', label: ARTS.name, labelKey: ARTS_KEY }],
    })
    expect(container.textContent).toContain('“Arts & Crafts” is meant to be taken as a set')
    expect(container.textContent).not.toContain(ARTS_KEY)
  })

  // THE TEST THAT EARNS THE ANCHORING. The substitution replaces the label key
  // only where it appears QUOTED, and this is the fixture that says why: an
  // elective named "Run" has the key `run`, and `run` is also an ordinary word
  // in the sentence the engine writes ("campers it needs to run, so it did not
  // run"). A substitution that did not require the quotes would rewrite the
  // prose around the label as well.
  //
  // Verified non-vacuous by planting the defect: making the quotes optional in
  // findingDisplayMessage.js turns THIS test red. It was the second guard tried
  // — the `UNMATCHED_PREFERENCE_LABEL` one below survives that plant, because
  // there the key never appears in the message at all.
  it('replaces the label only where it is quoted, never the same word in the prose around it', () => {
    const RUN = { id: 'a-run', name: 'Run' }
    const RUN_KEY = electiveChoiceLabelKey(RUN.name)
    const solved = buildElectiveAssignments({
      campers: four,
      occurrences: [{ id: 'occ-1' }],
      offerings: [
        { occurrence_id: 'occ-1', labelKey: RUN_KEY, activity_id: RUN.id, capacity: 10, minimum: 5 },
        { occurrence_id: 'occ-1', labelKey: SWIM_KEY, activity_id: SWIM.id, capacity: 10, minimum: null },
      ],
      preferences: four.flatMap((c) => [
        { camper_id: c.id, labelKey: RUN_KEY, rank: 1 },
        { camper_id: c.id, labelKey: SWIM_KEY, rank: 2 },
      ]),
    })
    expect(solved.findings.map((f) => f.kind)).toContain('BELOW_MINIMUM')

    const { container } = preview({
      assignments: solved.assignments, findings: solved.findings, campers: four,
      activities: [RUN, SWIM],
    })
    expect(container.textContent).toContain(
      '“Run” had 4 of the 5 campers it needs to run, so it did not run.'
    )
  })

  // REGRESSION GUARD. `UNMATCHED_PREFERENCE_LABEL` was ALREADY correct — it
  // prefers the sheet's own spelling — and the substitution here is generic, so
  // the thing to prove is that it leaves that finding alone. The sentence is
  // about what the SHEET said, so the sheet's spelling is the right thing to
  // show even when the camp spells the same activity differently.
  it('leaves an unmatched preference label showing the spelling the SHEET used', () => {
    const findings = findMismatches({
      offerings: [],
      preferences: [{ camper_id: 'c1', label: 'Archery Advanced', labelKey: electiveChoiceLabelKey('Archery Advanced'), rank: 1 }],
    })
    expect(findings.map((f) => f.kind)).toContain('UNMATCHED_PREFERENCE_LABEL')

    const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] }]
    const { container } = preview({
      assignments, findings, campers: [{ id: 'c1', display_name: 'C1' }],
      // The camp's own spelling differs only in case/spacing, so it normalises to
      // the SAME key — the one shape that could tempt a substitution.
      activities: [SWIM, { id: 'a-arch', name: 'ARCHERY  ADVANCED' }],
    })
    expect(container.textContent).toContain('"Archery Advanced" ranked but not offered')
    expect(container.textContent).not.toContain('ARCHERY  ADVANCED')
  })

  // A finding the renderer cannot resolve must still read as its author wrote
  // it. Silently dropping the sentence would be worse than the key it replaces.
  it('leaves a finding it cannot resolve exactly as the producer wrote it', () => {
    const findings = [{ kind: 'NO_CAPACITY', occurrence_id: 'occ-1', message: 'Nothing here names an activity.' }]
    const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] }]
    const { container } = preview({ assignments, findings, campers: [{ id: 'c1', display_name: 'C1' }] })
    expect(container.textContent).toContain('Nothing here names an activity.')
  })

  // Owner call 2026-09-29: all three counts in the summary line, not just the
  // one the bug report named.
  it('says "1 camper placed · 1 occurrence · 1 finding", not "1 campers · 1 occurrences · 1 findings"', () => {
    const findings = [{ kind: 'NO_CAPACITY', occurrence_id: 'occ-1', message: 'One finding.' }]
    const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] }]
    const { container } = preview({ assignments, findings, campers: [{ id: 'c1', display_name: 'C1' }] })
    expect(container.textContent).toContain('1 camper placed · 1 occurrence · 1 finding')
  })

  it('keeps the plural for counts that are not one', () => {
    const findings = [
      { kind: 'NO_CAPACITY', occurrence_id: 'occ-1', message: 'One.' },
      { kind: 'NO_CAPACITY', occurrence_id: 'occ-2', message: 'Two.' },
    ]
    const assignments = [
      { camper_id: 'c1', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] },
      { camper_id: 'c2', occurrence_id: 'occ-1', activity_id: SWIM.id, preference_rank: 1, flags: [] },
    ]
    const occurrences = [...OCC_1, { id: 'occ-2', day_id: 'day-1', time_block_id: 'tb-1' }]
    const { container } = preview({
      assignments, findings, occurrences,
      campers: [{ id: 'c1', display_name: 'C1' }, { id: 'c2', display_name: 'C2' }],
    })
    expect(container.textContent).toContain('2 campers placed · 2 occurrences · 2 findings')
  })
})

// Audit E5 (2026-10-10) — a "Not requested" placement says why, from the solver.
describe('AssignmentPreview — Not requested says why (audit E5)', () => {
  it('words the solver reason on the chip and summarises it in one line', async () => {
    const { assignments, findings } = buildElectiveAssignments({
      campers: [{ id: 'cam-1' }],
      occurrences: [{ id: 'occ-1' }],
      offerings: [{ occurrence_id: 'occ-1', labelKey: 'swim', activity_id: 'act-1', capacity: 5 }],
      preferences: [{ camper_id: 'cam-1', labelKey: 'ceramics', rank: 1 }],
    })
    const { default: userEvent } = await import('@testing-library/user-event')
    render(
      <AssignmentPreview
        assignments={assignments} findings={findings} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByText('1 placement is not something the camper requested: 1 because none of their choices was offered then.')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Monday, Period 2/ }))
    expect(screen.getByText('Not requested: none of their choices is offered here')).not.toBeNull()
  })
})
