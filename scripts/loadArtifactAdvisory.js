// T308 — the load judgement `npm run verify` already makes, reaching the command a
// session actually iterates with: `npx vitest run <file>`.
//
// THE PROBLEM THIS SOLVES. `scripts/verify.js` downgrades a failure to
// ⚠️ VERIFY INCONCLUSIVE when the machine is swamped, and tells you to re-run quiet
// before concluding anything. But only the full gate reaches that judgement:
// `gateLock.js` has exactly one caller, `npm run test` is a bare `vitest run`, and an
// ad-hoc one-file run takes no lock and prints no verdict. So the same failure is
// INCONCLUSIVE through the gate and a bare red directly — and the bare red is the one
// a session sees while working. On 2026-09-29 that cost two sessions their afternoon
// bisecting load.
//
// WHAT THIS DELIBERATELY DOES NOT DO — read T308's "Notes for whoever takes this"
// before changing it. It does not downgrade, suppress, or relabel anything. It adds a
// diagnostic line beside a failure that is ALREADY red and STAYS red; no exit code is
// touched anywhere. The obvious implementation — let an ad-hoc run reach the
// INCONCLUSIVE verdict — is the one T308 warns against, because widening that path
// without carrying both of T178's filters turns every load-shaped red into a laundered
// defect on the exact command sessions run most. A red that was really load costs an
// afternoon. A defect dressed as load ships. So this only ever ADDS a sentence.
//
// THE FILTERS ARE NOT REIMPLEMENTED. `verdict()` and `machineLoadVerdict()` are
// imported from verify.js (which is side-effect-free on import, by design, per the
// import.meta guard there). A hand-kept second copy of this judgement is exactly how
// the gate and the ad-hoc path would come to disagree again, one filter apart.
import { machineLoadVerdict, verdict } from './verify.js'

/**
 * Should a failing ad-hoc test run carry a load-artifact advisory?
 *
 * @param {object}   args
 * @param {number[]} args.failedDurationsMs  one duration per FAILED test
 * @param {number}   args.load1              1-minute load average
 * @param {number}   args.cores              CPU count
 * @returns {{line: string, loadRatio: number}|null} null = say nothing; a plain red
 */
export function loadArtifactAdvisory({ failedDurationsMs = [], load1, cores } = {}) {
  const durations = failedDurationsMs.filter((d) => Number.isFinite(d))
  // Nothing failed, or nothing timed — an unknown duration must never be relabelled,
  // the same posture verify.js takes for a bare step string.
  if (durations.length === 0 || durations.length !== failedDurationsMs.length) return null

  const oversubscribed = machineLoadVerdict(load1, cores) === 'oversubscribed'
  if (!oversubscribed) return null

  // THE FASTEST failing test, not the slowest, and this is the whole anti-laundering
  // decision. verify.js sees one duration — how long the `test` STEP ran — which under
  // load is always long. A one-file run can see each failure separately, so it can be
  // stricter than the gate, and should be: if even the FASTEST failure is slow then
  // every failure is slow and load is a credible explanation for all of them. One fast
  // failure means a real defect is present, and a real defect present alongside genuine
  // load is precisely the case that must not be described as "probably the machine".
  //
  // Consequence, stated because it is a deliberate divergence: this can stay silent
  // where the gate would say INCONCLUSIVE. That direction is the safe one — T308 is
  // explicit that trading a red-that-was-load for a defect-dressed-as-load makes the
  // codebase worse.
  const fastestFailureMs = Math.min(...durations)
  // Reusing verify.js's verdict rather than re-testing its thresholds: `step: 'test'`
  // is a real member of LOAD_SENSITIVE_STEPS, so this consults the same two filters
  // rather than approximating them. code 2 is its INCONCLUSIVE.
  if (verdict({ step: 'test', ms: fastestFailureMs }, { oversubscribed }).code !== 2) return null

  const loadRatio = load1 / cores
  const n = durations.length
  return {
    loadRatio,
    line:
      `⚠️  THIS RUN STILL FAILED — but every one of its ${n} failure${n === 1 ? '' : 's'} took at ` +
      `least ${(fastestFailureMs / 1000).toFixed(0)}s while this machine was at ${load1.toFixed(0)} ` +
      `1-min load on ${cores} cores (${loadRatio.toFixed(0)}× oversubscribed). Slow failures under ` +
      `that load are usually the machine, not the code — this is the same reading ` +
      `\`npm run verify\` reports as VERIFY INCONCLUSIVE. Re-run this file alone on a quiet machine ` +
      `before concluding anything, and do NOT treat the re-run as the answer if it merely passes ` +
      `once. Nothing here downgrades the result: the failures above are real until a quiet run says ` +
      `otherwise.`,
  }
}
