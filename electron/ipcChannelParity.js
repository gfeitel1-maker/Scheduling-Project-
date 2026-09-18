// A listener with no sender is invisible to lint, to the graphify knowledge graph, and to any
// test that mocks the channel (which is exactly what let 'shoresh:auth-rejected' survive the
// Stage 6 cutover unnoticed — preload.js exposed onAuthRejected, useDeviceMode.js consumed it,
// and every test mocked localClient.onAuthRejected directly, so nothing ever asked "does anything
// in electron/ actually call webContents.send for this channel?"). This module is the cheap,
// mechanical answer to that question, pulled out as pure functions so it is testable against
// defect shapes its author did not have in mind — see ipcChannelParity.test.js's non-vacuity
// tests, and internetRendezvousScan.js for the same rationale applied to a different guard.
//
// KNOWN LIMITS, stated because a guard's description is part of the guard:
//   * Text-pattern matching, not a call graph. A channel name built at runtime (a template
//     literal, string concatenation, a variable) is invisible to both the listener and sender
//     regexes — this only sees a channel spelled out as a literal string at the call site.
//   * `findSentChannels` matches ANY `send('channel', ...)` call, not only
//     `webContents.send(...)` — deliberately broad, because a sender can be reached through a
//     local indirection (dispatchRemoteOps.js's injected `send(channel, payload)` parameter is
//     exactly this shape) that a narrower regex tied to `webContents.send` would miss. The
//     tradeoff is it could match an unrelated `.send(` call that happens to take a matching
//     string literal as its first argument — a false negative on "no sender", not a dangerous
//     direction to fail in for this guard's purpose.
//   * Only sees the files handed to it. A sender that lives outside the scanned source (a
//     different tree entirely) is invisible — same class of blind spot the module header above
//     names for the WS-layer deletion that started this.

const LISTEN_RE = /ipcRenderer\.on\(\s*['"]([a-zA-Z0-9:_-]+)['"]/g
const SEND_RE = /\bsend\(\s*['"]([a-zA-Z0-9:_-]+)['"]/g

/** Pure: preload.js source -> the distinct channel names it registers via ipcRenderer.on. */
export function findListenedChannels(preloadSource) {
  return [...new Set([...String(preloadSource).matchAll(LISTEN_RE)].map((m) => m[1]))]
}

/** Pure: any electron/ source text -> the set of channel names it sends via some `.send(...)` call. */
export function findSentChannels(source) {
  return new Set([...String(source).matchAll(SEND_RE)].map((m) => m[1]))
}

/**
 * Pure: given preload.js's source and the concatenated source of the rest of electron/, return
 * the listened-to channels that have no corresponding sender anywhere in that source — a
 * listener with nothing that could ever fire it. `knownGaps` excludes channels a human has
 * already identified and tracked elsewhere (see ipcChannelParity.guard.test.js for the current
 * list and why each entry is there) so this stays a tripwire for NEW regressions rather than a
 * permanently red gate for a pre-existing, separately-tracked one.
 */
export function findChannelsWithoutSender(preloadSource, electronSource, { knownGaps = [] } = {}) {
  const listened = findListenedChannels(preloadSource)
  const sent = findSentChannels(electronSource)
  const known = new Set(knownGaps)
  return listened.filter((channel) => !sent.has(channel) && !known.has(channel))
}
