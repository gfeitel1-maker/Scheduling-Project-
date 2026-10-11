// The app must always keep a usable window while the process runs. A renderer that dies leaves the
// process alive with no page (remote-debugging /json returns []), and on macOS closing the last
// window deliberately keeps the process alive, so something must put a window back.

export function recoverFromRendererGone(win, details, { createWindow }) {
  if (details?.reason === 'clean-exit') return
  if (win.isDestroyed()) {
    createWindow()
    return
  }
  win.webContents.reload()
}

export function wireActivate({ app, getWindow, createWindow }) {
  app.on('activate', () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) createWindow()
  })
}
