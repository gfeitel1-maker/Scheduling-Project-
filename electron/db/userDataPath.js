import path from 'node:path'
import fs from 'node:fs'

// Where this app's data lives, decided explicitly rather than inferred.
//
// Per docs/adr/2026-07-28-explicit-userdata-directory.md.
//
// Electron derives the userData directory from the app name, and derives the
// app name from whatever `--app-path` points at. Launched as
// `electron electron/main.js` there is no package.json at that path, so it
// falls back to its own built-in constant, "Electron" — which is not derived
// from this repository at all. Every development clone on a machine therefore
// resolved to the SAME directory, while the packaged app resolved to "shoresh".
// Two codebases, one database, and nothing on screen said so.
//
// APP_NAME must be applied via app.setName() BEFORE any app.getPath() call and
// before app.whenReady(), or it silently has no effect. That ordering is the
// whole correctness of this module and is why the logic lives here, testable,
// instead of inline in main.js.

export const APP_NAME = 'shoresh'

// Development deliberately does NOT share the packaged app's data. Shoresh runs
// a real camp: a dev session that regenerates a schedule or exercises a
// migration against operational data is unrecoverable, where a testing gap
// costs a re-test. The two are not comparable.
export const DEV_APP_NAME = 'shoresh-dev'

export function userDataDirName(isPackaged) {
  return isPackaged ? APP_NAME : DEV_APP_NAME
}

// `appDataPath` is Electron's app.getPath('appData') — the per-user
// application-support root, which does not depend on the app name.
export function resolveUserDataPath(appDataPath, isPackaged) {
  return path.join(appDataPath, userDataDirName(isPackaged))
}

// Applies the decision to a live Electron `app`. Call this first thing, before
// anything reads a path. Returns the resolved userData path.
//
// The directory MUST be created here. Electron auto-creates only the userData
// directory it derived itself; one supplied via setPath() is taken on trust and
// never created, so the first launch after this change would otherwise die in
// openLocalDb with "Cannot open database because the directory does not exist".
// `mkdir` is injectable purely so this is testable without touching a real disk.
export function applyUserDataPath(app, mkdir = (p) => fs.mkdirSync(p, { recursive: true })) {
  app.setName(APP_NAME)
  const resolved = resolveUserDataPath(app.getPath('appData'), app.isPackaged)
  app.setPath('userData', resolved)
  mkdir(resolved)
  return resolved
}
