import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the packaged app can load index.html over file://
  // (Electron uses loadFile in production; an absolute "/" base would 404).
  base: './',
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    // electron-builder copies the whole project — including every *.test.js —
    // into release/. Without this, `npm run test` after `npm run electron:build`
    // collects two copies of the suite, and the duplicated syncServer tests
    // bind the same WebSocket ports concurrently and fail on contention. The
    // failures look like real sync regressions and are not.
    // '.claude/worktrees' is the same problem from a different direction: an
    // agent worktree is a full checkout inside the project, so collection picks
    // up another branch's suite alongside this one. Observed 2026-07-28 — the
    // count went 678 -> 1367 and the duplicated sync tests contended for the
    // same WebSocket ports, failing exactly as the release/ copies did.
    exclude: ['**/node_modules/**', '**/dist/**', 'release/**', '**/.claude/worktrees/**'],
    // T25: the default 5000ms per-test budget made a green run depend on how
    // busy the machine was. Six identical full runs on 2026-07-31 produced
    // three greens and three reds, with a different set of tests failing each
    // time and every red run a slow one.
    //
    // Measured, not guessed. `electron/main.test.js` run alone: 14.6s for 95
    // tests, slowest single test 1535ms. The same file inside the full suite:
    // 118s. That is ~8x contention, and it is not because the file is slow —
    // it is 56 test files (sqlite native, jsdom, real WebSocket servers) on a
    // 4-core machine, usually alongside other agent sessions.
    //
    // 1535ms x 8 = ~12s, so 20s clears the worst observed case with headroom
    // while still being far below "hung". A test that genuinely never resolves
    // still fails here; only the contention noise is absorbed.
    //
    // If this ever needs raising again, measure first and record the numbers,
    // as here. Do not treat a rising timeout as the fix — it is the symptom.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Runs before every test file. Raises RTL's waitFor/findBy budget from its
    // 1000ms default to 3000ms so a green run does not depend on machine load —
    // the same contention concern as testTimeout above, at a different layer
    // (waitFor's budget is independent of testTimeout). See vitest.setup.js for
    // the measurements.
    setupFiles: ['./vitest.setup.js'],
  },
  server: {
    port: 5200,
    strictPort: true,
  },
})
