// Task 10 round-5 Fix 4: report success/failure back to the caller instead
// of unconditionally swallowing it. sendMissedOps needs this to know exactly
// which missed op was the LAST one that genuinely made it out over the wire,
// so it can stop the watermark there instead of blindly advancing past ops
// that never actually sent.
export function send(ws, message) {
  try {
    if (ws.readyState !== ws.OPEN) return false
    ws.send(JSON.stringify(message))
    return true
  } catch {
    // ignore send failures to dead/closing sockets — but tell the caller
    return false
  }
}

// Red Hat review follow-up: ws.send()'s completion callback is documented to
// go unfired in some destroy-path edge cases in the underlying `ws` library.
// Without a bound, that would hang this Promise forever. sendMissedOps's
// caller isn't awaited at its own call site, so this can't cascade into a
// connection- or process-wide freeze — but it would silently stall one
// device's catch-up with zero observability. SEND_ACK_TIMEOUT_MS races the
// ack against a bounded timeout and resolves false on expiry, matching the
// existing withResolverTimeout pattern in syncClient.js: settle-once guard,
// clear the timer on whichever path wins.
export const SEND_ACK_TIMEOUT_MS = 8000

// Task 10 round-6 follow-up: a synchronous absence-of-exception from
// ws.send() is NOT proof of delivery. On a live-but-broken TCP connection,
// ws.send() commonly returns normally (readyState stays OPEN, nothing
// throws) while the actual write fails asynchronously — that failure only
// surfaces later via ws.send()'s optional completion callback (called with
// an Error on failure, undefined on success) or a subsequent close/error
// event. sendWithAck awaits that genuine confirmation instead of trusting
// the synchronous return, so callers (specifically sendMissedOps) can gate
// watermark advancement on real delivery, not just "didn't throw yet".
export function sendWithAck(ws, message, timeoutMs = SEND_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (ws.readyState !== ws.OPEN) {
      resolve(false)
      return
    }
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      // The ws.send() callback never fired within the bound. Treat this the
      // same as an explicit ack-failure so sendMissedOps's loop breaks
      // cleanly and the watermark stays honest rather than advancing past
      // an unconfirmed op.
      settle(false)
    }, timeoutMs)
    try {
      ws.send(JSON.stringify(message), (err) => {
        settle(!err)
      })
    } catch {
      // Preserve round-5 behavior: a synchronous throw from ws.send() itself
      // (if the underlying implementation can still do that) is still
      // treated as an immediate failure.
      settle(false)
    }
  })
}
