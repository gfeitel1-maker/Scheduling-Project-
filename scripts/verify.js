// The quality gate — lint + test + test:integration + check:governance, in order,
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

export const VERIFY_STEPS = ['lint', 'test', 'test:integration', 'check:governance']

// Pure: map "which step failed (or null)" → the verdict line + process exit code.
export function verdict(failedStep) {
  if (failedStep) {
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
  const v = verdict(failed)
  // eslint-disable-next-line no-console
  console.log('\n' + '═'.repeat(60) + '\n' + v.line)
  process.exit(v.code)
}
