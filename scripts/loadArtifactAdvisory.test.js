import { describe, it, expect } from 'vitest'
import { loadArtifactAdvisory } from './loadArtifactAdvisory.js'
import { failedDurationsFrom } from './loadArtifactReporter.js'
import { MIN_LOAD_TIMEOUT_MS } from './verify.js'

// T308. The advisory exists so a one-file run gets the judgement the gate already
// makes. These tests are mostly about the cases where it must STAY SILENT, because the
// failure mode of this feature is the failure mode it was written to prevent: a defect
// described as load is strictly worse than a red that was really load.
const CORES = 4
const SWAMPED = CORES * 4 // machineLoadVerdict's threshold
const QUIET = CORES // ordinary concurrent-session load in this repo
const SLOW = MIN_LOAD_TIMEOUT_MS + 1
const FAST = 300

describe('loadArtifactAdvisory — when it speaks', () => {
  it('speaks when the machine is swamped and every failure was slow', () => {
    const out = loadArtifactAdvisory({ failedDurationsMs: [SLOW, SLOW * 2], load1: SWAMPED, cores: CORES })
    expect(out).not.toBeNull()
    expect(out.line).toMatch(/still failed/i)
  })

  it('says the result is NOT downgraded, in the line itself', () => {
    // The whole safety of this feature is that it adds a sentence rather than changing
    // a verdict. The line has to say so, or a reader will take it as permission.
    const out = loadArtifactAdvisory({ failedDurationsMs: [SLOW], load1: SWAMPED, cores: CORES })
    expect(out.line).toMatch(/Nothing here downgrades the result/i)
    expect(out.line).toMatch(/real until a quiet run says otherwise/i)
  })

  it('names the measurements rather than only a conclusion', () => {
    const out = loadArtifactAdvisory({ failedDurationsMs: [SLOW], load1: 64, cores: CORES })
    expect(out.line).toContain('64')
    expect(out.line).toContain('4 cores')
    expect(out.line).toMatch(/16×/)
  })
})

describe('loadArtifactAdvisory — when it MUST stay silent', () => {
  it('stays silent when nothing failed', () => {
    expect(loadArtifactAdvisory({ failedDurationsMs: [], load1: SWAMPED, cores: CORES })).toBeNull()
  })

  it('stays silent on a quiet machine, however slow the failure', () => {
    expect(
      loadArtifactAdvisory({ failedDurationsMs: [SLOW * 10], load1: QUIET, cores: CORES })
    ).toBeNull()
  })

  // THE CASE THIS FEATURE COULD GET WRONG, and the reason the fastest failure is used
  // rather than the slowest. A real defect failing fast, alongside genuine load, must
  // not be described as probably-the-machine.
  it('stays silent when ANY failure was fast, even under crushing load', () => {
    expect(
      loadArtifactAdvisory({ failedDurationsMs: [FAST, SLOW * 5], load1: SWAMPED * 10, cores: CORES })
    ).toBeNull()
  })

  it('stays silent for a single fast failure under crushing load', () => {
    expect(loadArtifactAdvisory({ failedDurationsMs: [FAST], load1: SWAMPED * 10, cores: CORES })).toBeNull()
  })

  // Boundary: MIN_LOAD_TIMEOUT_MS is verify.js's, and `slow` there is `>=`. Asserted
  // against the imported constant so raising it there cannot silently widen this.
  it('treats exactly MIN_LOAD_TIMEOUT_MS as slow, and one ms under it as fast', () => {
    const base = { load1: SWAMPED, cores: CORES }
    expect(loadArtifactAdvisory({ ...base, failedDurationsMs: [MIN_LOAD_TIMEOUT_MS] })).not.toBeNull()
    expect(loadArtifactAdvisory({ ...base, failedDurationsMs: [MIN_LOAD_TIMEOUT_MS - 1] })).toBeNull()
  })

  // machineLoadVerdict's own threshold is `>=`, and it is 4x cores. One under it is
  // ordinary load for this repo, which runs a few times oversubscribed by design.
  it('needs load at 4x cores, not merely high load', () => {
    const base = { failedDurationsMs: [SLOW], cores: CORES }
    expect(loadArtifactAdvisory({ ...base, load1: SWAMPED })).not.toBeNull()
    expect(loadArtifactAdvisory({ ...base, load1: SWAMPED - 1 })).toBeNull()
  })

  it('never relabels when a duration is unknown', () => {
    // verify.js stays FAILED for an unknown duration; so does this. A partially-timed
    // set is worse than an untimed one — it invites a max/min over holes.
    const base = { load1: SWAMPED, cores: CORES }
    expect(loadArtifactAdvisory({ ...base, failedDurationsMs: [undefined] })).toBeNull()
    expect(loadArtifactAdvisory({ ...base, failedDurationsMs: [SLOW, undefined] })).toBeNull()
    expect(loadArtifactAdvisory({ ...base, failedDurationsMs: [SLOW, NaN] })).toBeNull()
  })

  it('never relabels when the core count is unusable', () => {
    const base = { failedDurationsMs: [SLOW], load1: SWAMPED }
    expect(loadArtifactAdvisory({ ...base, cores: 0 })).toBeNull()
    expect(loadArtifactAdvisory({ ...base, cores: undefined })).toBeNull()
  })

  it('is silent on an empty call rather than throwing', () => {
    expect(loadArtifactAdvisory()).toBeNull()
  })
})

// T308 — the reporter's only non-trivial job: reading durations off vitest's shapes.
// Tested against hand-built stand-ins rather than by booting vitest, so the shape
// handling (and especially the untimed-failure refusal) is pinned cheaply.
describe('failedDurationsFrom', () => {
  const test = (state, duration) => ({ result: () => ({ state }), diagnostic: () => ({ duration }) })
  const mod = (...tests) => ({ children: { allTests: () => tests } })

  it('collects only the failed tests, ignoring passes and skips', () => {
    const mods = [mod(test('failed', 11_000), test('passed', 3), test('skipped', undefined))]
    expect(failedDurationsFrom(mods)).toEqual([11_000])
  })

  it('collects across several modules', () => {
    expect(failedDurationsFrom([mod(test('failed', 10)), mod(test('failed', 20))])).toEqual([10, 20])
  })

  it('returns [] when a run failed but no individual test did (a suite-level error)', () => {
    // reason === 'failed' can mean an import or hook blew up with zero failed tests.
    // An empty array makes the advisory stay silent, which is right: nothing was timed.
    expect(failedDurationsFrom([mod(test('passed', 5))])).toEqual([])
  })

  // THE REFUSAL. A min() over a partially-timed set answers a question about the tests
  // it could see, not about the run, so an untimed failure abandons the whole advisory.
  it('returns null — not a filtered list — when any failure is untimed', () => {
    expect(failedDurationsFrom([mod(test('failed', 11_000), test('failed', undefined))])).toBeNull()
    expect(failedDurationsFrom([mod(test('failed', NaN))])).toBeNull()
  })

  it('tolerates missing or foreign shapes rather than throwing', () => {
    expect(failedDurationsFrom(undefined)).toEqual([])
    expect(failedDurationsFrom([{}])).toEqual([])
    expect(failedDurationsFrom([{ children: {} }])).toEqual([])
  })
})
