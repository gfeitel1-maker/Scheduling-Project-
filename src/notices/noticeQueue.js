// Pure FIFO queue operations for director-facing notices (bootstrap
// failures, offline-queue rejections — see src/App.jsx's AppShell). No
// React, no App.jsx import. Every function returns a NEW array; the input
// queue is never mutated. See noticeQueue.test.js for the behavior pinned
// here without a DOM.

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

export function dismissHead(queue) {
  return queue.slice(1)
}
