// A tiny in-memory stand-in for the subset of the Workers KV API this Worker uses
// (`get`, `put` with `expirationTtl`, `list` with `prefix`/`limit`), driven by an
// injectable clock so a TTL boundary can be crossed deterministically in a test
// without a real 2-hour wait or a `wrangler`/`miniflare` dependency.
//
// This is test infrastructure, not a KV reimplementation, and it is not faithful in three
// documented ways:
//   - Eventual consistency across edge PoPs (see worker.js's comment on that) is not modeled;
//     `get` immediately reflects every `put`, which a real deployment cannot promise.
//   - `list` always returns `list_complete: true` with no cursor — there is no pagination here.
//     Real Workers KV can return a partial page (`list_complete: false` plus a `cursor`) even
//     under a namespace's key count, and this fake will never exercise that path.
//   - There is no minimum TTL enforced. Real Workers KV rejects `expirationTtl` below its
//     documented ~60s floor; this fake accepts any value, including 0 or negative, so a future
//     change that lowers TTL_SECONDS below that floor would pass these tests and then fail at
//     an actual deploy.
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
