// Pure FIFO queue operations for director-facing notices (bootstrap
// failures, offline-queue rejections — see src/App.jsx's AppShell). No
// React, no App.jsx import. Every function returns a NEW array; the input
// queue is never mutated. See noticeQueue.test.js for the behavior pinned
// here without a DOM.
//
// Deliberately id-keyed throughout, with no positional removal (there used
// to be a `dismissHead`, removed in round 2): the dismiss path is deferred
// behind a ~140ms fade, and another writer (a bootstrap retry resolving
// cleanly, a fresh arrival) can change what sits at index 0 before that
// timer fires. A removal keyed to the id captured at dismiss time is a
// no-op if that entry is already gone and never touches a different entry
// that has since become head; a positional removal has no way to tell the
// two apart.

export function enqueue(queue, entry) {
  return [...queue, entry]
}

// Replaces the entry with this id in place (same index), merging `patch`
// onto the existing entry so callers can update just the fields that
// changed. Appends a new entry { id, ...patch } when no entry with this id
// exists yet, so a caller can upsert without first checking presence.
export function upsertById(queue, id, patch) {
  const index = queue.findIndex((entry) => entry.id === id)
  if (index === -1) return [...queue, { id, ...patch }]
  const next = [...queue]
  next[index] = { ...next[index], ...patch, id }
  return next
}

export function removeById(queue, id) {
  return queue.filter((entry) => entry.id !== id)
}
