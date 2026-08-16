// One place that turns a failed write into something a director can act on.
//
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md §5
//
// Every screen used to end its error handling with the same ternary — admin
// role, or else "check your connection and try again". That made the CONNECTION
// the explanation for every failure in the app that was not a permission
// problem, including a foreign-key violation, a duplicate name, and a disk
// error. A director sent to check their wifi for a constraint violation finds
// the wifi fine and concludes the app is broken. It is the same misdirection as
// a silent failure, only louder.
//
// What this cannot do, and must not pretend to: the main process throws real
// Errors across IPC, and only the MESSAGE survives that boundary — `code` does
// not. So a foreign-key failure is recognised by its message and described as
// "something still refers to it", which is true of every foreign key in the
// schema. It is deliberately NOT described as "a schedule uses this": the
// operations table has its own foreign keys on device_id and author_user_id,
// and a message that named the wrong cause confidently would replace one wrong
// explanation with another.
//
// `whatFailed` is the director's half of the sentence — the subject, in plain
// words, ending with a full stop. This adds the cause.

const FOREIGN_KEY = /FOREIGN KEY constraint failed/i
const UNIQUE = /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i
const NOT_NULL = /NOT NULL constraint failed/i
const TRANSPORT = /disconnected|timeout|not connected|ECONNREFUSED|network|socket/i

export function describeWriteFailure(err, whatFailed) {
  const message = typeof err?.message === 'string' ? err.message : ''

  if (UNIQUE.test(message)) {
    return `${whatFailed} Another record already has that name.`
  }
  if (FOREIGN_KEY.test(message)) {
    return `${whatFailed} Something else still refers to it.`
  }
  if (NOT_NULL.test(message)) {
    return `${whatFailed} Something it needs is missing.`
  }
  if (TRANSPORT.test(message)) {
    return `${whatFailed} Your devices could not reach each other — try again when they are both on the network.`
  }
  // Genuinely unrecognised. Say that, rather than blaming the network for it.
  return `${whatFailed} The reason was not something the app recognised — try again, and if it keeps happening the details are in the log.`
}

// The whole ternary, in one call. `forbidden` is the permission half every
// screen already wrote by hand; everything else routes through the mapper.
export function writeErrorMessage(err, { forbidden, whatFailed }) {
  if (/admin role required/i.test(err?.message ?? '')) return forbidden
  return describeWriteFailure(err, whatFailed)
}

// The typed refusals deleteRecord returns, in a director's words.
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
export function deleteRefusalMessage(error, { name, slot_count, ref_count, unprotected_count } = {}) {
  const subject = name ? `“${name}”` : 'That record'
  // Locations report a count-changed drift with ref_count, never slot_count
  // (electron/ops/deleteRecord.js's locations branch) — fall back so this one
  // shared message still names a real number instead of "undefined".
  const count = slot_count ?? ref_count
  switch (error) {
    case 'count-changed':
      return `${subject} is now used in ${count} places, not the number shown a moment ago — someone else changed the schedule. Nothing was deleted. Try again to see the new count.`
    case 'snapshot-failed':
      return `The schedule could not be saved first, so nothing was deleted. ${subject} is still here, and so is its week.`
    case 'unprotected-slots':
      return `${unprotected_count} of the places ${subject} is used are in a schedule this app can no longer open, so they could not be saved first. Nothing was deleted.`
    case 'host-unreachable':
      return 'Your main computer is not reachable, so this cannot be deleted right now. Try again when it is back on the network.'
    case 'no-record':
      return `${subject} is already gone.`
    case 'not-clearable':
      return `${subject} cannot be deleted from here.`
    case 'forbidden':
      return 'Only an admin can delete records.'
    default:
      return `${subject} could not be deleted. Nothing was changed.`
  }
}
