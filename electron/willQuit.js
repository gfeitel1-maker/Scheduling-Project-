// Electron does not await an async will-quit listener, so teardown that must finish before the
// process dies (the punch transport's native cleanup(), without which it cannot exit) is not
// guaranteed to run. The first will-quit is vetoed, teardown is awaited (bounded, so a hung cleanup
// can never block quit), then app.quit() re-fires will-quit, which the flag lets through.
// The re-quit waits a macrotask: Electron resets its is_quitting_ flag only after the vetoed
// will-quit callback (and its microtasks) unwinds, so a quit() issued before that is silently
// dropped and the app never exits — which is what an instant cleanup (punch off) used to hit.
export function createWillQuitHandler({ app, cleanup, timeoutMs = 5000 }) {
  let quitting = false
  return (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    const teardown = new Promise((resolve) => resolve(cleanup())).catch(() => {})
    Promise.race([teardown, timeout]).finally(() => {
      clearTimeout(timer)
      setImmediate(() => app.quit())
    })
  }
}

// The one synchronous flush every exit path runs (will-quit, OS session end). Each step is
// isolated so a failing flush can never skip the next one or block quit.
export function createQuitFlush(steps) {
  return () => {
    for (const [name, fn] of steps) {
      try { fn() } catch (err) { console.error(`${name}: flush on exit failed (non-fatal):`, err?.message ?? err) }
    }
  }
}

// An OS session end (Windows log-off/shutdown, macOS shutdown/logout) may give only seconds, and
// the async will-quit teardown may never finish. So flush synchronously FIRST, then attempt the
// graceful quit. query-session-end is not vetoed: the director asked the OS to shut down.
export function wireSessionEndFlush({ app, powerMonitor, win, flush }) {
  const flushThenQuit = () => { flush(); app.quit() }
  win.on('query-session-end', () => flush())
  win.on('session-end', flushThenQuit)
  powerMonitor.on('shutdown', flushThenQuit)
}
