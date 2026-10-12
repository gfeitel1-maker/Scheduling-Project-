// The app must always keep a usable window while the process runs. A renderer that dies leaves the
// process alive with no page (remote-debugging /json returns []), and on macOS closing the last
// window deliberately keeps the process alive, so something must put a window back.

// Once the app is quitting (T368) a dying renderer is part of the quit, never a reason to bring a
// window back: doing so kept the process alive past verify:packaged's quit bound.
export function recoverFromRendererGone(win, details, { createWindow, isQuitting = () => false }) {
  if (details?.reason === 'clean-exit' || isQuitting()) return
  if (win.isDestroyed()) {
    createWindow()
    return
  }
  win.webContents.reload()
}

export function wireActivate({ app, getWindow, createWindow, isQuitting = () => false }) {
  app.on('activate', () => {
    if (isQuitting()) return
    const win = getWindow()
    if (!win || win.isDestroyed()) createWindow()
  })
}
