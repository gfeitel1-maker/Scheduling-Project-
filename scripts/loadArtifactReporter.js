// T308 — the vitest reporter that carries `loadArtifactAdvisory` to an ad-hoc run.
//
// A THIN SHELL ON PURPOSE. All the judgement lives in loadArtifactAdvisory.js and all
// the thresholds live in verify.js; this file only reads durations off vitest's
// reporter API and prints. It changes no exit code and suppresses no failure — see the
// header of loadArtifactAdvisory.js for why that restraint is the whole design.
//
// THE API WAS CONFIRMED BY EXECUTION against the installed vitest (4.1.7), not from
// memory: `onTestRunEnd(testModules, unhandledErrors, reason)` fires with
// reason === 'failed', `module.children.allTests()` yields the tests, `test.result()`
// carries `.state` and `test.diagnostic()` carries `.duration` in ms. The legacy
// `onFinished` hook is NOT called in v4, so it is deliberately not implemented — a
// fallback nobody invokes is a second code path that cannot be tested.
import os from 'node:os'
import { loadArtifactAdvisory } from './loadArtifactAdvisory.js'

/**
 * Durations of the FAILED tests in a run, or null if any of them cannot be timed.
 *
 * Null rather than a filtered list: loadArtifactAdvisory must not reason about a
 * partially-timed set, because a min() over holes silently answers a question about the
 * tests it could see rather than the run. Exported so the shape-handling is testable
 * without booting vitest.
 *
 * @param {Iterable<any>} testModules  vitest's TestModule collection
 * @returns {number[]|null}
 */
export function failedDurationsFrom(testModules) {
  const out = []
  for (const mod of testModules ?? []) {
    const tests = typeof mod?.children?.allTests === 'function' ? mod.children.allTests() : []
    for (const test of tests) {
      if (test?.result?.()?.state !== 'failed') continue
      const ms = test?.diagnostic?.()?.duration
      if (!Number.isFinite(ms)) return null // untimed failure — say nothing at all
      out.push(ms)
    }
  }
  return out
}

export default class LoadArtifactReporter {
  onTestRunEnd(testModules, _unhandledErrors, reason) {
    // A reporter that throws can take the run down with it, and this one exists only to
    // add a diagnostic. Any surprise in the API shape must cost the advisory, never the
    // test results.
    try {
      if (reason !== 'failed') return
      const failedDurationsMs = failedDurationsFrom(testModules)
      if (failedDurationsMs === null) return
      const advisory = loadArtifactAdvisory({
        failedDurationsMs,
        load1: os.loadavg()[0],
        cores: os.cpus().length,
      })
      if (!advisory) return
      console.log('\n' + '═'.repeat(60) + '\n' + advisory.line + '\n')
    } catch {
      // Deliberately silent: see above.
    }
  }
}
