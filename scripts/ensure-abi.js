#!/usr/bin/env node
// Make the better-sqlite3 native binary match whoever is about to load it —
// Node (Vitest) or Electron (the real app) — without the human having to
// remember which rebuild to run.
//
// better-sqlite3 is a native module, so its compiled .node is tied to one ABI.
// Node and Electron use DIFFERENT ABIs, so flipping between `npm test` and
// `npm run electron:dev` needs a rebuild each way. Doing that by hand ("reinstall
// a package every time") is the friction this removes: `pretest` ensures the
// Node build, `preelectron:dev` ensures the Electron build, and this script is a
// fast no-op when the binary already matches — so only an actual switch pays.
//
// How it knows without recompiling to check: it records the last target it built
// for in .abi-target (gitignored). Nothing else in this repo rebuilds the
// binary, so the marker is authoritative. If the marker is ever wrong, the worst
// case is one unnecessary rebuild — never a silently mismatched binary, because
// the rebuild itself is what a mismatch would trigger.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MARKER = new URL('../.abi-target', import.meta.url)

const target = process.argv[2]
if (target !== 'node' && target !== 'electron') {
  console.error(`ensure-abi: expected "node" or "electron", got ${JSON.stringify(target)}`)
  process.exit(2)
}

// The signature that has to match for the current binary to be loadable. Node's
// ABI is process.versions.modules; Electron's is pinned by its version, so the
// version string is a sufficient and stable proxy.
function signatureFor(which) {
  if (which === 'node') return `node:${process.versions.modules}`
  const electronVersion = require('electron/package.json').version
  return `electron:${electronVersion}`
}

const want = signatureFor(target)
const have = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : null

if (have === want) {
  console.log(`ensure-abi: better-sqlite3 already built for ${want} — nothing to do.`)
  process.exit(0)
}

console.log(`ensure-abi: rebuilding better-sqlite3 for ${want} (was ${have ?? 'unknown'})…`)

try {
  if (target === 'node') {
    // Rebuild against the running Node's ABI.
    execFileSync('npm', ['rebuild', 'better-sqlite3'], { stdio: 'inherit' })
  } else {
    // Rebuild against Electron's ABI. -f forces even if it looks current; -w
    // scopes the work to just this one native module. The CLI is addressed by
    // its file path, not require.resolve('@electron/rebuild/lib/cli.js') — the
    // package's "exports" map hides that subpath, so resolving it throws.
    const bin = fileURLToPath(new URL('../node_modules/@electron/rebuild/lib/cli.js', import.meta.url))
    execFileSync(process.execPath, [bin, '-f', '-w', 'better-sqlite3'], { stdio: 'inherit' })
  }
} catch {
  console.error(`ensure-abi: rebuild for ${target} failed. Run it by hand to see why:`)
  console.error(target === 'node'
    ? '  npm rebuild better-sqlite3'
    : '  npx electron-rebuild -f -w better-sqlite3')
  process.exit(1)
}

writeFileSync(MARKER, `${want}\n`)
console.log(`ensure-abi: done — better-sqlite3 now built for ${want}.`)
