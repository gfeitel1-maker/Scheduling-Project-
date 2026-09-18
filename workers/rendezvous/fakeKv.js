// A tiny in-memory stand-in for the subset of the Workers KV API this Worker uses
// (`get`, `put` with `expirationTtl`, `list` with `prefix`/`limit`), driven by an
// injectable clock so a TTL boundary can be crossed deterministically in a test
// without a real 2-hour wait or a `wrangler`/`miniflare` dependency.
//
// This is test infrastructure, not a KV reimplementation — it does not model KV's
// eventual consistency across edge PoPs (see worker.js's comment on that).
export class FakeKvNamespace {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now
    this._store = new Map() // key -> { value, expiresAtMs }
  }

  async get(key) {
    const entry = this._store.get(key)
    if (!entry) return null
    if (entry.expiresAtMs <= this._now()) {
      this._store.delete(key)
      return null
    }
    return entry.value
  }

  async put(key, value, { expirationTtl } = {}) {
    const ttlMs = (expirationTtl ?? 0) * 1000
    this._store.set(key, { value, expiresAtMs: this._now() + ttlMs })
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const now = this._now()
    const keys = []
    for (const [name, entry] of this._store) {
      if (entry.expiresAtMs <= now) continue
      if (!name.startsWith(prefix)) continue
      keys.push({ name })
      if (keys.length >= limit) break
    }
    return { keys, list_complete: true }
  }
}
