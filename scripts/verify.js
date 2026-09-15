// The quality gate — lint + agents:check + test + test:integration + security + check:governance,
// in order,
// stopping at the first failure.
//
// Why this exists instead of a bare `a && b && c` npm chain: a chain prints no
// verdict, so `npm run verify 2>&1 | tail -N` (a common way to fit the long output
// under a tool/time budget) shows only the last step's trailing lines AND reports
// tail's exit code (always 0) rather than the gate's. That masks a real red as a
// false green. This wrapper ALWAYS prints a final, unmistakable verdict line in the
// output text — so the truth survives any tail-piping — and exits with the real code.
// See memory: feedback-gate-exit-code-not-tail.
import { spawnSync } from 'node:child_process'
import os from 'node:os'

export const VERIFY_STEPS = [
  'lint',
  'agents:check',
  'test',
  'test:integration',
  'security',
  'check:governance',
]

// T164: a test run on a badly oversubscribed machine has not discovered anything about the CODE —
// several ordinary synchronous tests were measured at 400-500s each at load 66 on 4 cores (16x),
// purely because the machine was swamped, and a per-test timeout is an absolute number the machine's
// speed is not. A red under that condition trains people to re-run, and re-running is the habit that
// lets a real regression through. So a failure under extreme load is reported as a THIRD answer —
// INCONCLUSIVE — not FAILED: it is still non-zero (never a false green, never masks a real red), it
// just tells a human "the machine was swamped; re-run in isolation before concluding a defect."
// Same 0/1/2 shape gateResultCode.sh already uses (T171).
//
// The threshold is deliberately high: normal concurrent-session load in this repo runs a few times
// oversubscribed by design (vitest.setup.js/vite.config.js say so), so only GENUINE swamping — the
// 1-minute load average at 4x the core count or more — trips it. `factor` is injectable for tests.
export function machineLoadVerdict(load1, cores, { factor = 4 } = {}) {
  if (!Number.isFinite(load1) || !Number.isFinite(cores) || cores <= 0) return 'ok' // unknown → don't relabel
  return load1 >= cores * factor ? 'oversubscribed' : 'ok'
}

// Pure: map "which step failed (or null)" + machine state → the verdict line + process exit code.
// oversubscribed is only consulted WHEN a step failed — a passing run is always a clean exit 0.
export function verdict(failedStep, { oversubscribed = false } = {}) {
  if (failedStep) {
    if (oversubscribed) {
      return {
        line:
          `⚠️  VERIFY INCONCLUSIVE — step "${failedStep}" failed, but this machine was oversubscribed ` +
          `(1-min load ≥ 4× cores). This is very likely a load timeout, not a defect. Re-run the ` +
          `failing step in isolation before concluding anything. This is NOT a pass.`,
        code: 2,
      }
    }
    return { line: `❌ VERIFY FAILED at step: ${failedStep}`, code: 1 }
  }
  return {
    line: `✅ VERIFY PASSED — ${VERIFY_STEPS.join(' + ')} all green`,
    code: 0,
  }
}

// Run each step in order via `run(step)` (returns the step's exit code). Returns the
// first failing step name, or null if all passed. Short-circuits on first failure.
export function runVerify(steps = VERIFY_STEPS, run = defaultRun) {
  for (const step of steps) {
    // eslint-disable-next-line no-console
    console.log(`\n▶ npm run ${step}`)
    if (run(step) !== 0) return step
  }
  return null
}

function defaultRun(step) {
  return spawnSync('npm', ['run', step], { stdio: 'inherit' }).status ?? 1
}

// Execute only when invoked directly (`node scripts/verify.js`), not when imported by
// the test. import.meta guards keep the module side-effect-free under Vitest.
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/verify.js')
if (invokedDirectly) {
  const failed = runVerify()
  // Measure load AFTER the run: the 1-minute average at this point reflects the load the suite just
  // ran under (a verify run takes minutes). Only consulted if something failed.
  const oversubscribed =
    !!failed && machineLoadVerdict(os.loadavg()[0], os.cpus().length) === 'oversubscribed'
  const v = verdict(failed, { oversubscribed })
  // eslint-disable-next-line no-console
  console.log('\n' + '═'.repeat(60) + '\n' + v.line)
  process.exit(v.code)
}
