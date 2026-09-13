import { describe, it, expect } from 'vitest'
import { parseTextGrid } from './textGrid'

// T36 F3 — a one-word repeated line above each page break was stripped as a
// page banner, even when it was a real event.
//
// A camp name printed above every page IS a banner and must go, or it becomes a
// phantom activity. A centred "Dismissal" printed above every page break is the
// same SHAPE and is content. Typography cannot tell them apart — which is the
// owner's ruling on this whole family: do not infer what the writing cannot
// settle.
//
// So the deciding evidence comes from the document instead: does that text also
// appear inside a real row somewhere? A camp's name does not. An event the camp
// actually runs does.

const page = (title, extra = '') => `${title}
Time      Monday    Tuesday   Wednesday
9:15      Art       Swim      Dance
10:00     Swim      Dance     Art
${extra}`

describe('detectBanner — a repeated one-word line (T36 F3)', () => {
  it('strips a camp name, which appears nowhere else', () => {
    const text = ['Shemesh', page('Bunk 1'), 'Shemesh', page('Bunk 2'), 'Shemesh', page('Bunk 3')].join('\n')
    expect(parseTextGrid(text).banner).toBe('Shemesh')
  })

  it('does NOT strip a word that also appears inside a real row', () => {
    // "Dismissal" printed above each page break AND scheduled in the grid is an
    // event, not a banner. Stripping it loses a real thing the camp does.
    const withDismissal = `Time      Monday    Tuesday   Wednesday
9:15      Art       Swim      Dance
3:30      Dismissal   Dismissal   Dismissal`
    const text = [
      'Dismissal', 'Bunk 1', withDismissal,
      'Dismissal', 'Bunk 2', withDismissal,
      'Dismissal', 'Bunk 3', withDismissal,
    ].join('\n')
    expect(parseTextGrid(text).banner).toBeNull()
  })

  it('reports a stripped banner so it is never removed silently', () => {
    // The parser has always returned this; nothing consumed it, so a removal
    // was invisible to the director. It is surfaced now (ImportScreen).
    const text = ['Shemesh', page('Bunk 1'), 'Shemesh', page('Bunk 2')].join('\n')
    const { banner } = parseTextGrid(text)
    expect(banner).toBe('Shemesh')
  })

  it('strips nothing when no line repeats above the titles', () => {
    const text = [page('Bunk 1'), page('Bunk 2'), page('Bunk 3')].join('\n')
    expect(parseTextGrid(text).banner).toBeNull()
  })

  it('is not defeated by a footer that sets the camp name beside a page number', () => {
    // Red Hat: a PDF footer tokenizes to two columns ("Shemesh   Page 1"), and
    // scanning every line let that vouch for the camp name as content — making
    // the real banner un-strippable and reintroducing it as a phantom activity
    // on every page. Only a page's ROWS count as content now.
    const text = [
      'Shemesh', page('Bunk 1'), 'Shemesh        Page 1',
      'Shemesh', page('Bunk 2'), 'Shemesh        Page 2',
      'Shemesh', page('Bunk 3'), 'Shemesh        Page 3',
    ].join('\n')
    expect(parseTextGrid(text).banner).toBe('Shemesh')
  })
})
