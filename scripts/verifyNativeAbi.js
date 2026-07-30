// Is the native module we are about to ship built for Electron, or for Node?
//
// T20. `npm run install:mac` printed "Installed:" for an app that could not
// open its database, because the bundle carried the NODE build of
// better-sqlite3 (ABI 141) where Electron needs its own (ABI 148). The app then
// launched, drew no window, and said nothing — see T19.
//
// ROOT CAUSE, established by comparing the artifacts rather than assuming:
// electron-builder does NOT produce its own copy of the module. Its
// "preparing/finished moduleName=better-sqlite3" step decided the existing
// build was current and skipped rebuilding, and packaging then copied the
// project's node_modules verbatim — the bundled .node is byte-identical to the
// project's. So **the project's ABI state at package time IS the shipped ABI**,
// and a `npm rebuild better-sqlite3` run minutes earlier (to run Vitest under
// Node, which is a documented and normal thing to do) silently decides what
// ships.
//
// That makes the check cheap and exact, in two links:
//   1. the project's module does NOT load under Node (so it is the Electron
//      build), and
//   2. the bundled binary is byte-identical to the project's.
// Together those prove the shipped module is the Electron one. Neither link
// alone is sufficient: (1) says nothing about what was copied, and (2) would
// happily confirm that a Node-ABI module was faithfully copied.
//
// The bundle does not retain `build/config.gypi` — only `Release` and `deps` —
// so the ABI is determined from the project copy and tied to the bundle by
// byte identity.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

export const MODULE_REL = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'

// Ask the binary, not the build config.
//
// The first version of this check read `nodedir` out of build/config.gypi,
// on the reasoning that Electron's headers live under ~/.electron-gyp and
// Node's under ~/.node-gyp. **That does not work, and the check caught itself
// failing:** `npm rebuild better-sqlite3` produces a Node-ABI binary but leaves
// config.gypi still saying `.electron-gyp/43.1.1`. A stale file described the
// build that used to be there, and the guard cheerfully approved shipping the
// wrong module — the exact failure it exists to prevent.
//
// So probe the artifact instead. This script runs under Node, so:
//   loads here            -> it is a NODE build -> wrong for packaging
//   NODE_MODULE_VERSION   -> built for another ABI (Electron) -> right
//   anything else         -> unknown, refuse
// The classification is pure; the probe is injected so it can be tested
// without a rebuild.
export function classifyLoad(loadResult) {
  if (loadResult && loadResult.loaded) return 'node'
  const msg = (loadResult && loadResult.error) || ''
  if (/NODE_MODULE_VERSION/.test(msg)) return 'electron'
  return 'unknown'
}

export function probeUnderNode(modulePath) {
  try {
    createRequire(import.meta.url)(modulePath)
    return { loaded: true, error: null }
  } catch (err) {
    return { loaded: false, error: (err && err.message) || String(err) }
  }
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Pure so the decision can be tested without a build on disk.
export function verdict({ target, projectHash, bundleHash }) {
  if (target === 'node') {
    return {
      ok: false,
      reason: 'built-for-node',
      message:
        'better-sqlite3 in this project is built for Node, not Electron.\n' +
        'This is what `npm rebuild better-sqlite3` leaves behind after running the tests.\n' +
        'Packaging would ship it and the installed app would start, show no window, and say nothing.\n' +
        'Fix:  npx electron-rebuild -f -w better-sqlite3',
    }
  }
  if (target === 'unknown') {
    return {
      ok: false,
      reason: 'unknown-target',
      message:
        'Could not tell which runtime better-sqlite3 was built for.\n' +
        'Refusing to package rather than shipping a module of unknown provenance.\n' +
        'Rebuild explicitly:  npx electron-rebuild -f -w better-sqlite3',
    }
  }
  if (bundleHash != null && projectHash !== bundleHash) {
    return {
      ok: false,
      reason: 'bundle-mismatch',
      message:
        'The native module inside the app bundle is not the one this project built.\n' +
        'Packaging substituted or rebuilt it, so the ABI check above proves nothing about what ships.',
    }
  }
  return { ok: true, reason: 'electron-abi', message: 'Native module is built for Electron.' }
}

function targetOf(root) {
  const modulePath = path.join(root, MODULE_REL)
  if (!fs.existsSync(modulePath)) return 'unknown'
  return classifyLoad(probeUnderNode(modulePath))
}

export function checkProject(root) {
  return verdict({ target: targetOf(root), projectHash: null, bundleHash: null })
}

export function checkBundle(root, appPath) {
  const target = targetOf(root)
  const projectModule = path.join(root, MODULE_REL)
  const bundleModule = path.join(appPath, 'Contents/Resources/app', MODULE_REL)
  if (!fs.existsSync(bundleModule)) {
    return { ok: false, reason: 'missing-in-bundle', message: `No native module at ${bundleModule}` }
  }
  return verdict({
    target,
    projectHash: sha256(projectModule),
    bundleHash: sha256(bundleModule),
  })
}

// CLI:  node scripts/verifyNativeAbi.js project
//       node scripts/verifyNativeAbi.js bundle <path-to-.app>
if (process.argv[1] && process.argv[1].endsWith('verifyNativeAbi.js')) {
  const [, , mode, appPath] = process.argv
  const root = path.resolve(path.dirname(process.argv[1]), '..')
  const result = mode === 'bundle' ? checkBundle(root, appPath) : checkProject(root)
  if (!result.ok) {
    process.stderr.write(`\nNATIVE MODULE CHECK FAILED (${result.reason})\n\n${result.message}\n\n`)
    process.exit(1)
  }
  process.stdout.write(`${result.message}\n`)
}
