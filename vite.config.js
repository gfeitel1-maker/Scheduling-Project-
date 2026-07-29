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
  },
  server: {
    port: 5200,
    strictPort: true,
  },
})
