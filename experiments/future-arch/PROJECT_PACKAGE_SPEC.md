# `.shoresh` project package — spec (doc-first)

**Conceptual shift from the earlier prototype.** The first convergence prototype
(`oplog.cjs`) treated a *shared folder* as a generic transport. This model is sharper and
matches the accepted ADR: **the durable, portable thing is a Shoresh *project package*, and
SQLite is a disposable local engine that reads/rebuilds from it.**

> **Shoresh is the product. SQLite is the engine Shoresh happens to use to work with a
> project.** The project — "Camp Achva — Summer 2027" — is the document. A SQLite database is
> to a `.shoresh` package what a browser's cache is to a website: fast local working state you
> can throw away and rebuild.

This spec defines the package so that: (a) two independent SQLite instances can open the same
package, edit independently, publish immutable operations, notice each other's operations, and
converge; and (b) a SQLite database can be **deleted entirely** and **rebuilt from the package
alone**, yielding byte-for-byte the same logical state as a surviving instance.

## The package layout

A `.shoresh` project is a **directory** (a bundle, like a `.app`). Minimal v1:

```
test-project.shoresh/
├── project.json          # identity + metadata + format/schema version
└── journal/              # the durable history: immutable operations, one file per op
    ├── 000000001-devA-<opid>.op.json
    ├── 000000002-devB-<opid>.op.json
    └── …
```

- **`project.json`** — the project's identity and the format contract needed to read it.
  ```json
  {
    "format": "shoresh-project/v1",
    "projectId": "<uuid>",
    "name": "Camp Achva",
    "season": "Summer 2027",
    "schemaVersion": 1,
    "createdAt": "<iso>",
    "createdBy": "<deviceId>"
  }
  ```
  (In the full design this record is *signed* by an owner key per the identity ADR; the
  experiment omits signing — it is proving reconstruction/convergence, not auth.)

- **`journal/`** — the source of truth. One **immutable** file per operation. Filename
  `<lamport padded>-<deviceId>-<opId>.op.json` sorts human-readably and is globally unique.
  Contents (frozen at write time):
  ```json
  {
    "id": "<uuid>", "lamport": 7, "deviceId": "devA",
    "entity": "entities", "entityId": "archery", "field": "location", "value": "Field 1",
    "parentOpId": "<opid|null>", "clientWriteId": "<uuid>", "ts": "<iso>"
  }
  ```

**What is NOT in the package:** no `.sqlite` file, ever. SQLite lives outside, per instance, and
is rebuildable. Putting a live DB in a synced package is the corruption trap the ADR forbids.

## Invariants (the contract the code must uphold)

1. **Journal files are immutable and append-only.** Never modified or deleted once published.
   Writes are temp-then-rename so a reader never sees a partial file.
2. **Operation identity is global** (`id`), so apply is idempotent — seeing an op twice is a
   no-op. Instances dedupe by `id`.
3. **Convergence is order-independent.** Final materialized state is a deterministic function of
   the *set* of operations, via last-writer-wins per `(entity, entityId, field)` keyed on
   `(lamport, deviceId)`. Arrival order, restarts, and duplicates cannot change the result.
4. **Everything needed to reconstruct is in the package.** No materialized state exists only in
   a SQLite db; every durable fact is an operation in the journal. (Entity creation is itself an
   op — a row is born when its first field op is applied — so replay rebuilds rows too.)
5. **The local SQLite is pure derived state.** It may be deleted at any time and rebuilt from the
   package alone.

## The two proofs this spec exists to enable

- **Convergence:** instances A and B, each with its own SQLite outside the package, open the same
  `test-project.shoresh`, edit independently, publish ops into `journal/`, `sync()` (scan +
  apply unseen), and reach identical state — including a genuine same-field conflict that both
  converge on and both record.
- **Reconstruction:** delete B's SQLite entirely; build a fresh SQLite from **only**
  `test-project.shoresh` (replay the journal from empty); assert its canonical state hash equals
  the surviving instance A's, exactly.

## Deferred (documented, not built here)
- **Checkpoints** (`checkpoints/`): periodic compacted state so reconstruction need not replay
  the whole journal — a performance optimization, not required for correctness. v1 replays the
  full immutable journal, which is the cleanest proof.
- **Signing** of `project.json` genesis and of each op (identity ADR).
- **Compaction/GC** of the journal (needs a checkpoint first).
