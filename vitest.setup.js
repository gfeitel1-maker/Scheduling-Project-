// Global test setup — runs in every test file's environment before the file.
//
// Raises React Testing Library's async-utility budget (the timeout shared by
// waitFor / findBy / waitForElementToBeRemoved) from its 1000ms default to
// 3000ms, for the SAME reason vite.config.js raises testTimeout: on a busy
// 4-core machine (several agent sessions each running this suite) a green run
// otherwise depends on how busy the machine is.
//
// Measured, not guessed. This budget is INDEPENDENT of testTimeout — a test can
// sit well inside its 20000ms test budget yet still fail because a single
// waitFor blew its own 1000ms. The heaviest async-settle in the suite is
// ScheduleScreen's initial load (~12 sequential localClient calls); the
// useScheduleData hook behind it resolves in ~130ms idle. The config comment for
// testTimeout records ~8x contention under concurrent agent sessions, and
// 130ms x 8 ~= 1040ms — i.e. the default 1000ms sits exactly on the edge under
// the load the repo already documents, which is why waitFor-heavy files fail a
// different subset each run. 3000ms clears that ~8x case with headroom while
// staying far below testTimeout, so a genuinely stuck async still fails
// deterministically (via testTimeout) rather than hanging.
//
// 3000ms is the value ScheduleScreen.test.jsx had already adopted locally for
// its own load; this makes that protection the floor for all ~340 waitFor call
// sites instead of one file. If this ever needs raising again, measure first and
// record the numbers, as here — a rising timeout is the symptom, not the fix.
import { configure } from '@testing-library/dom'

configure({ asyncUtilTimeout: 3000 })
