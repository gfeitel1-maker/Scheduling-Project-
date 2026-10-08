// Electron does not await an async will-quit listener, so teardown that must finish before the
// process dies (the punch transport's native cleanup(), without which it cannot exit) is not
// guaranteed to run. The first will-quit is vetoed, teardown is awaited (bounded, so a hung cleanup
// can never block quit), then app.quit() re-fires will-quit, which the flag lets through.
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
      app.quit()
    })
  }
}
