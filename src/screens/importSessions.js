// What the director took back during one import (Change, Forget, Undo for this import) outlives the
// review screen remounting, keyed by the import itself, and is dropped once that import is
// committed or discarded.
export const importSessions = new Map()

// Keyed by the import's CONTENT, not its size: two different files with the same name and the
// same approved-set length must never share undone answers (Red Hat, PR #916).
function digest(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function importKeyOf(baseInputs, sourceLabel) {
  const content = JSON.stringify({ approved: baseInputs?.approved ?? {}, fixedEvents: baseInputs?.fixedEvents ?? [] })
  return [sourceLabel ?? '', baseInputs?.mode ?? '', digest(content)].join('|')
}

export function sessionFor(key) {
  let session = importSessions.get(key)
  if (!session) {
    session = { suppressed: new Set(), returned: new Set() }
    importSessions.set(key, session)
  }
  return session
}
