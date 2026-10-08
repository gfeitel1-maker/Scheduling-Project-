// Test-only: an in-memory signaling pair standing in for the rung 2/3 channel S1 deliberately
// does not build. Messages are structured-cloned so a test cannot accidentally share object
// identity across the "wire".
export function makeSignalingPair() {
  const make = () => ({ handlers: new Set(), peer: null })
  const a = make()
  const b = make()
  const side = (me, other) => ({
    sendSignal: (msg) => {
      const copy = structuredClone(msg)
      queueMicrotask(() => {
        for (const h of other.handlers) h(copy)
      })
    },
    onSignal: (cb) => {
      me.handlers.add(cb)
      return () => me.handlers.delete(cb)
    },
  })
  return [side(a, b), side(b, a)]
}
