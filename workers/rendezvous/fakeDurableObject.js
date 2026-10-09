// Test stand-in for a Durable Object namespace binding (env.X): idFromName / get(id).fetch(request),
// one lazily-built instance per id (the Worker only ever asks for "rendezvous"). Each instance gets a real in-memory SQLite database behind the
// `ctx.storage.sql.exec(query, ...bindings)` surface (cursor: toArray(), rowsWritten), so the SQL the
// class runs is executed by a real engine rather than interpreted by a mock.
//
// Faithful: per-id isolated storage; positional bindings; an id nobody wrote to has no tables.
// Not faithful: fetches are NOT serialized here (JS runs the class's synchronous SQL section
// atomically, and leaving interleaving on is the conservative model for any await in the class).
import Database from 'better-sqlite3'

export class FakeDurableObjectNamespace {
  constructor(DurableObjectClass) {
    this._Class = DurableObjectClass
    this._instances = new Map()
  }

  idFromName(name) {
    return name
  }

  get(id) {
    return { fetch: (request) => this._instance(id).object.fetch(request) }
  }

  // Test-only handle on what a name's storage holds; never touches the object under test.
  storageFor(name) {
    return this._instance(name).storage
  }

  _instance(id) {
    let instance = this._instances.get(id)
    if (!instance) {
      const db = new Database(':memory:')
      const storage = { db, rowsWritten: 0 }
      const sql = {
        exec(query, ...bindings) {
          const stmt = db.prepare(query)
          if (stmt.reader) {
            const rows = stmt.all(...bindings)
            return { toArray: () => rows, rowsWritten: 0 }
          }
          const { changes } = stmt.run(...bindings)
          storage.rowsWritten += changes
          return { toArray: () => [], rowsWritten: changes }
        },
      }
      instance = { storage, object: new this._Class({ storage: { sql } }, {}) }
      this._instances.set(id, instance)
    }
    return instance
  }
}
