// What the director took back during one import (Change, Forget, Undo for this import) outlives the
// review screen remounting, keyed by the import itself, and is dropped once that import is
// committed or discarded.
export const importSessions = new Map()

export function importKeyOf(baseInputs, sourceLabel) {
  return [sourceLabel ?? '', baseInputs?.mode ?? '', JSON.stringify(baseInputs?.approved ?? {}).length, (baseInputs?.fixedEvents ?? []).length].join('|')
}

export function sessionFor(key) {
  let session = importSessions.get(key)
  if (!session) {
    session = { suppressed: new Set(), returned: new Set() }
    importSessions.set(key, session)
  }
  return session
}
