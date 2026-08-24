import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferMultiBlockCandidates } from './multiBlockCandidates'

// docs/adr/2026-08-24-merged-cell-multiblock-ingest.md, Slice B addendum §1,
// plus the Governor round-2 aggregation fix (real-file defect against
// Group Schedules 1.xlsx: 14 groups each showing the same Friday merge must
// collapse into ONE candidate, not 14).

describe('inferMultiBlockCandidates', () => {
  it('surfaces a >=2 blockSpans cell as a candidate, orientation A (days as columns)', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          rows: [
            row('16:00', ['Ruach & Shabbat', '', '', '', ''], [3]),
            row('17:00', ['', '', '', '', '']),
            row('18:00', ['', '', '', '', '']),
          ],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    // One group total ('A'), one showing -> is_all_groups (every group that
    // exists showed it).
    expect(multiBlockCandidates).toEqual([
      { name: 'Ruach & Shabbat', start_block: '16:00', span_blocks: 3, days: ['Monday'], scope: { is_all_groups: true, groups: null } },
    ])
  })

  it('surfaces a >=2 blockSpans cell as a candidate, orientation B (groups as columns) — transpose', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        {
          title: 'Monday',
          columns: ['A', 'B', 'C'],
          rows: [
            row('16:00', ['Ruach & Shabbat', '', ''], [3]),
            row('17:00', ['', '', '']),
            row('18:00', ['', '', '']),
          ],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    // Only 'A' showed it, but the camp has A/B/C -> partial scope, not all-groups.
    expect(multiBlockCandidates).toEqual([
      { name: 'Ruach & Shabbat', start_block: '16:00', span_blocks: 3, days: ['Monday'], scope: { is_all_groups: false, groups: ['A'] } },
    ])
  })

  it('aggregates the SAME merge across every group into ONE all-groups candidate, not one per group (the real-file defect)', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    // Orientation A — one page per group, exactly like Group Schedules 1.xlsx:
    // every group's Friday page shows the same 3-block "Ruach & Shabbat" merge.
    const groups = ['Yeladim 1', 'Yeladim 2', 'Tzofim 1', 'Tzofim 2', 'Tzofim 3', 'CITs']
    const parsed = {
      pages: groups.map((title) => ({
        title,
        columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        rows: [row('16:00', ['', '', '', '', 'Ruach & Shabbat'], [undefined, undefined, undefined, undefined, 3])],
      })),
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates).toEqual([
      { name: 'Ruach & Shabbat', start_block: '16:00', span_blocks: 3, days: ['Friday'], scope: { is_all_groups: true, groups: null } },
    ])
  })

  it('a merge on only SOME of the camp groups aggregates to a partial-groups candidate, not all-groups', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        { title: 'Yeladim 1', columns: ['Friday'], rows: [row('16:00', ['Special Trip'], [2])] },
        { title: 'Yeladim 2', columns: ['Friday'], rows: [row('16:00', ['Special Trip'], [2])] },
        { title: 'CITs', columns: ['Friday'], rows: [row('16:00', [''], [undefined])] },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates).toEqual([
      { name: 'Special Trip', start_block: '16:00', span_blocks: 2, days: ['Friday'], scope: { is_all_groups: false, groups: ['Yeladim 1', 'Yeladim 2'] } },
    ])
  })

  it('Red Hat HIGH #2 — a block present for DIFFERENT groups on different days does NOT over-claim a union scope', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    // Orientation B — one page per day, groups as columns. Camp has 4 groups
    // total (A, B, C, D). Monday: A and B show the merge. Tuesday: C and D
    // show it. A naive single-pass union would wrongly collapse this to ONE
    // is_all_groups candidate spanning both days — A/B never had it Tuesday,
    // C/D never had it Monday.
    const parsed = {
      pages: [
        {
          title: 'Monday',
          columns: ['A', 'B', 'C', 'D'],
          rows: [row('16:00', ['Trip', 'Trip', '', ''], [2, 2, undefined, undefined])],
        },
        {
          title: 'Tuesday',
          columns: ['A', 'B', 'C', 'D'],
          rows: [row('16:00', ['', '', 'Trip', 'Trip'], [undefined, undefined, 2, 2])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    // TWO candidates, each correctly scoped — never one over-claiming candidate.
    expect(multiBlockCandidates).toEqual([
      { name: 'Trip', start_block: '16:00', span_blocks: 2, days: ['Monday'], scope: { is_all_groups: false, groups: ['A', 'B'] } },
      { name: 'Trip', start_block: '16:00', span_blocks: 2, days: ['Tuesday'], scope: { is_all_groups: false, groups: ['C', 'D'] } },
    ])
  })

  it('the same merge recurring on multiple days aggregates its days into one candidate', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: ['Monday', 'Tuesday', 'Wednesday'],
          rows: [row('16:00', ['Swim', 'Swim', ''], [2, 2, undefined])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates).toEqual([
      { name: 'Swim', start_block: '16:00', span_blocks: 2, days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null } },
    ])
  })

  it('ignores a blockSpans entry of 1 or undefined (Slice A never sets those, but stay defensive)', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: ['Monday', 'Tuesday'],
          rows: [row('16:00', ['Swim', ''], [1, undefined])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates).toEqual([])
  })

  it('returns no candidates when nothing has blockSpans', () => {
    const row = (label, cells) => ({ label, cells })
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: ['Monday', 'Tuesday'],
          rows: [row('09:00', ['Mifkad', 'Mifkad'])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates).toEqual([])
  })

  it('is a no-op over an empty pages array', () => {
    expect(inferMultiBlockCandidates({ pages: [] })).toEqual({ multiBlockCandidates: [] })
  })

  it('works without a proposal (falls back to detectOrientation + raw column/title spelling, no all-groups verdict possible)', () => {
    const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
    const parsed = {
      pages: [
        {
          title: 'Bunk 3',
          columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          rows: [row('16:00', ['Ruach & Shabbat', '', '', '', ''], [2])],
        },
      ],
    }
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed)
    expect(multiBlockCandidates).toEqual([
      { name: 'Ruach & Shabbat', start_block: '16:00', span_blocks: 2, days: ['Monday'], scope: { is_all_groups: false, groups: ['Bunk 3'] } },
    ])
  })
})
