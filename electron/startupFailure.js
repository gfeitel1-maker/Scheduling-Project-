// What the app does when it cannot start.
//
// T19. The database is opened at module top level in main.js, before
// app.whenReady().then(createWindow) is reached. A throw there aborted the rest
// of the module body, so no window was ever created — and Electron, having
// nothing to show and no reason to exit, simply stayed alive. The result was an
// app with a Dock icon, a menu bar, no window, nothing on stderr, nothing in the
// unified log and no crash report. Every ordinary diagnostic returned nothing.
//
// Observed for real on 2026-07-29 when a packaged build shipped the Node-ABI
// build of better-sqlite3 (T20). Finding it required instrumenting the installed
// bundle, because the failure produced no signal of any kind.
//
// The specific cause was fixable in a minute. The silence was what cost the
// afternoon, and the silence will outlive that cause: a corrupt database, a
// missing file, a permissions error or a migration that throws all present
// identically today. So this module is about making the failure SAY something,
// not about any one fault.
//
// Kept out of main.js so the wording and the classification can be tested
// without standing up Electron.

// Director-facing text for a startup failure.
//
// Article V governs this: the person reading it knows camps, not software. They
// are also, by definition, completely stuck — the app will not open — so the
// message has to carry an action, not just a diagnosis. The technical detail is
// included but placed last, because the director may need to relay it to
// someone who can act on it.
export function describeStartupFailure(err, logPath) {
  const detail = (err && (err.message || String(err))) || 'Unknown error'

  // The database is the only failure the director can plausibly act on
  // themselves, and it is the likeliest one, so it gets its own wording.
  const isDbFailure = /Failed to open local database|SQLITE|database/i.test(detail)

  const body = isDbFailure
    ? [
      'Shoresh could not open this camp’s schedule file, so it cannot start.',
      '',
      'Your data has not been changed. This is usually a problem with the app itself rather than with your schedule, and reinstalling the app is the normal fix.',
    ]
    : [
      'Shoresh could not start.',
      '',
      'Your data has not been changed.',
    ]

  if (logPath) {
    body.push('', `Details were saved to:\n${logPath}`)
  }
  body.push('', `Technical detail:\n${detail}`)

  return { title: 'Shoresh could not start', message: body.join('\n') }
}

// A durable record, so a director can be asked to send a file rather than
// reproduce a silent failure over the phone.
export function formatStartupFailureLog(err, when) {
  const stack = (err && err.stack) || (err && err.message) || String(err)
  return [
    `Shoresh startup failure`,
    `when: ${when}`,
    '',
    stack,
    '',
  ].join('\n')
}
