---
title: Stage 5 — wiring Automerge+libp2p into the live app behind a default-OFF flag
document_type: design
status: proposed
created: 2026-09-06
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
depends_on:
  - docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md
  - docs/work/handoffs/2026-09-06-automerge-productionization-progress.md
---

# Stage 5 — live wiring design (flag default OFF)

**Scope boundary.** This document designs how the already-built, already-merged Automerge+libp2p
engine (`electron/automerge/**`, `electron/sync/automerge/**`) gets a wire into the running app,
reversibly, behind a flag. It does **not** design Stage 6 (op-log retirement/cutover — irreversible,
owner-gated) or Stage 7 (WAN). Nothing in this document is implemented; it is a design for Maker.

Every claim below is tagged **PROVEN** (verified by reading the cited file/line on this branch) or
**PROPOSED** (this document's recommendation, not yet built or tested).

---

## 0. Candidate approaches considered (divergence)

The single architecturally consequential decision in Stage 5 is *where the flagged path attaches* —
everything else (flag storage, event translation, seeding) follows from that choice. Three genuinely
different insertion points were considered:

1. **Renderer-side dual-write** — `src/localClient.js` calls both the existing IPC methods and a new
   `window.shoresh.automergeWrite` in parallel when the flag is on.
   *Rejected*: requires new preload channels (`ipcSurfaceParity.test.js`, PLATFORM_STATE's "36
   importers, signatures frozen" constraint, breaks it), and puts sync-engine selection logic in the
   renderer, which has no business knowing which transport moved a byte on the wire. The renderer's
   entire reason for going through one seam (`localClient.js`) is so it never has to know this.

2. **New IPC channel, feature-detected by the renderer** — add `shoresh:write-v2` etc., renderer picks
   the channel based on a flag it reads via IPC.
   *Rejected*: same signature-surface expansion problem as (1), just moved one layer down; still
   requires `localClient.js` to branch, still requires `preload.js` additions, still means
   `ipcSurfaceParity.test.js` must special-case a channel that only exists in one mode. Buys nothing
   over (3) except an extra layer of indirection.

3. **Behind the existing IPC handlers, inside `main.js`/`electron/ops/**`** — `appendOp` (and the
   `bulk_replace`/read-path equivalents) grow an internal branch: same inputs, same outputs, same
   thrown-error contract, but when the flag is on, an Automerge write also happens and the push
   events are shaped identically. `localClient.js`, `preload.js`, and every renderer caller see zero
   difference.
   *Chosen.*

**Why 3 wins, concretely:** `appendOp` (`electron/ops/operations.js:107-150`) is already the single
choke point both the local write() path and the Host's `handleSubmitOp` go through (comment at
operations.js:135-144 says this explicitly). It is the one place that already knows "a write just
happened, with this entity/entity_id/field/value" without knowing or caring who called it. That is
exactly the shape `campDocument.js`'s `applyWrite({entity, entity_id, field, value})`
(`electron/automerge/campDocument.js:88-101`) wants as input — the two functions take structurally
identical arguments today, by design (the campDocument.js header comment says the doc mirrors the
op-log's `(entity, entity_id, field, value)` semantics "exactly ... so the projector can replay each
field through the EXISTING applyProjection"). Inserting at this seam means the flag changes what
`appendOp` does *in addition to* its existing job, never what its callers pass in or get back.

---

## 1. The flag

**Mechanism (PROPOSED):** a single boolean, read once at `main.js` startup, stored the same way other
per-install config already is: a row in the existing SQLite `camps`-adjacent settings surface if one
exists, or — simpler and matching this repo's existing pattern for build-time toggles
(`SHORESH_SMOKE_NONCE`, referenced at `electron/preload.js:14` and consumed in `main.js`) — an
environment variable, `SHORESH_SYNC_ENGINE`, with two values: `'oplog'` (default, and the value when
unset) and `'automerge'`.

**Recommendation: env var, not a DB row, for Stage 5.** Reasoning: a DB-row flag persists per-camp and
survives reinstall, which is the right shape for a *permanent* per-camp setting — but Stage 5 is
explicitly a reversible test/transition scaffold (per the task's own framing), not a per-camp
production setting yet. An env var:
- defaults safely to `'oplog'` with zero code path executed differently (not even a conditional
  branch reads DB state to decide — the check is `process.env.SHORESH_SYNC_ENGINE === 'automerge'`,
  a pure in-memory comparison with no I/O, so "off" cannot itself introduce a new failure mode);
- is what QA and the owner already use to flip `electron:dev` vs `electron:dev:fresh`-style behavior
  in this repo (README's Commands section documents env-driven dev variants);
  gives per-launch control for two-machine LAN testing (Stage 5f) without needing a UI toggle that
  would itself need Designer/Maker work and a place in the settings screen — premature until the
  engine has run on real hardware.
- Migrating this env var to a persisted per-camp settings row is the natural Stage 6 pre-cutover
  step (once the engine is proven, cutover needs every device to agree, which argues for a
  synced-or-at-least-host-authoritative setting) — **out of scope here, flagged as a Stage 6 input.**

**Where it's read (PROPOSED):** once, in `main.js` at startup, into a single exported constant
`SYNC_ENGINE` (module: new file `electron/sync/engineFlag.js`, ~10 lines) — `'oplog' | 'automerge'`.
Every branch point below reads this constant, never `process.env` directly, so a test can override it
without mutating global env state (the constant is a plain export, re-importable per test file; if a
runtime toggle is ever needed the module becomes a getter, but a redeploy-to-change-flag is
acceptable for Stage 5's test/transition scope).

**How QA flips it:** `SHORESH_SYNC_ENGINE=automerge npm run electron:dev`. No UI. Documented in the
handoff for whoever runs Stage 5f's two-machine test.

**Reversibility guarantee:** `SYNC_ENGINE === 'oplog'` (the default) must produce **zero** new code
execution — not "the same result via a different path," but the literal existing path, unchanged. This
is what makes "flag OFF must be a provable no-op" (item 6) checkable by diffing test coverage, not just
by inspection: every new branch below is `if (SYNC_ENGINE === 'automerge') { ...new code... }` with no
`else` that changes existing behavior, and no new code runs when the condition is false.

---

## 2. Where the doc meets the write path

**Today (PROVEN):** renderer `window.shoresh.write` → `shoresh:write` IPC handler (`main.js:1680`) →
`appendOp` (`electron/ops/operations.js:107`), which inserts into `operations` and calls
`applyProjection` in one transaction. `bulk_replace` is the parallel primitive
(`appendBulkReplaceOp`, `operations.js:390`) for `template_slots` only (`BULK_REPLACE_ENTITIES`,
`operations.js:240`).

**Insertion point (PROPOSED):** two call sites, both inside `electron/ops/operations.js`, not touched
by `main.js`'s IPC signatures at all:

```
appendOp(db, {...}) {
  ... existing validation, coerceOpValue, appendOp transaction (unchanged) ...
  const op = run()
  if (SYNC_ENGINE === 'automerge' && MODELED_ENTITIES.has(entity)) {
    try {
      const newDoc = applyWrite(automergeState.doc, { entity, entity_id, field, value })
      await automergeState.node.applyLocal(newDoc)   // projects + broadcasts
    } catch (err) {
      console.error('automerge dual-write failed (op-log write already committed, unaffected):', err)
      // never throws — op-log write already succeeded and is authoritative for this flag state
    }
  }
  return op
}
```

`appendOp` is currently synchronous (`operations.js:107` has no `async`); `syncNode.applyLocal` is
`async` (`electron/sync/automerge/syncNode.js:84`). **Design requirement for Maker:** `appendOp`'s
signature and return value must not change (many callers `await` it defensively already or use it
synchronously — grep before changing). The dual-write call is therefore fire-and-forget from
`appendOp`'s perspective: kicked off, not awaited, with its own catch so a rejection can never surface
as an unhandled rejection or delay the op-log write's already-returned result. This means the
Automerge side is **eventually** applied relative to the op-log write, not atomically joined to it —
acceptable because (a) SQLite is authoritative for the op-log path regardless of flag state per this
whole design, (b) the Automerge side is a test/transition scaffold, not yet load-bearing for any real
data, and (c) `syncNode.js`'s own comment (line 40-58) already documents that a merged doc can
project asynchronously relative to receipt, with `onProjectionError` as the escape valve — the same
tolerance applies to the local-write direction.

**What "the doc" is at runtime (PROPOSED, ties to §5):** `main.js`, at startup and only when
`SYNC_ENGINE === 'automerge'`, loads or creates the per-camp Automerge document and starts a sync
node (`startSyncNode`, `electron/sync/automerge/syncNode.js:23`), storing the handle in a
module-level `automergeState = { doc, node }` inside `operations.js` (or a new thin
`electron/automerge/runtimeState.js` that `operations.js` and `main.js` both import — avoids
`operations.js` importing Electron-adjacent startup logic). `main.js` is the owner of the lifecycle
(start/stop with the app); `operations.js` only reads the current state to decide whether to
dual-write.

**`bulk_replace` (template_slots) — NOT modeled (PROVEN gap).** `campDocument.js:1-8` explicitly
excludes `template_slots` (the one bulk-replace entity) and parent-scoped entities from
`MODELED_ENTITIES`. **Design decision: the flagged path falls back to op-log-only for
`template_slots`, parent-scoped entities (e.g. `week_activity_exclusions`,
`special_day_slots`/`event_slots`), and `day_overrides`, unconditionally, even with the flag on.**
Concretely: `appendBulkReplaceOp` and every parent-scoped write path get **no** Automerge branch added
in Stage 5 at all — not a silent skip inside a generic dual-write, but the dual-write hook itself is
only wired into `appendOp`, and `MODELED_ENTITIES.has(entity)` gates even that. This is not a
"block" (the op-log write proceeds exactly as today for these entities regardless of flag state) — it
is a scope fence: these entities simply don't participate in the CRDT side yet, so a schedule
(entirely `template_slots`) built with the flag on is fully written to the op-log and fully absent
from the Automerge doc until Stage 5's successor entities are modeled. **This must be called out
loudly to whoever runs Stage 5b/5c**: convergence testing with the flag on will show the doc
converging for 14 of the ~17 entity classes and will show `template_slots`/parent-scoped/
`day_overrides` visibly NOT converging via the doc (they still converge via the existing WS op-log,
unaffected) — that is expected, not a bug, and it directly reflects the prerequisite the handoff
already named ("Parent-scoped entities + template_slots ... also still need modeling for full
coverage," `docs/work/handoffs/2026-09-06-automerge-productionization-progress.md:56`).

**Received remote docs (PROVEN mechanism, PROPOSED wiring):** `syncNode.js`'s `handleReceived`
(`syncNode.js:26-69`) already does `A.merge` → `projectAll` → re-broadcast, entirely inside
`electron/sync/automerge/**`. Wiring it in means only: `main.js` passes the same `db` handle used by
the op-log path into `startSyncNode({ db, ... })`, and `projectAll` writes into the **same** SQLite
tables `applyProjection` (op-log path) writes into (`projector.js:1-24` — it reuses `applyProjection`
itself, so there is no separate "automerge SQLite" to keep in sync with "op-log SQLite": one set of
tables, two producers, gated so only one produces at a time per §6). No renderer-visible change beyond
push events (§3).

---

## 3. Push events staying compatible

**Today (PROVEN):** `main.js:204` sends `shoresh:op-applied` with a single sanitized op object shaped
like an `operations` row (`{id, entity, entity_id, field, value, ...}`, see `sanitizeOpForIpc`,
`operations.js`-adjacent, `main.js:120-127`). `shoresh:op-conflict` similarly carries
`{incomingOp, existingOp}`. `shoresh:full-sync-applied` carries no payload at all
(`preload.js:36-40`, `main.js:235`).

**Under Automerge (PROPOSED):** a merged remote doc is a *set* of field changes, not one op — the
translation layer's job is to turn "the doc advanced" into the same shape the 36 renderer consumers
already parse. Recommended approach:

1. **Diff, don't guess.** Automerge exposes `A.diff(doc, before, after)` / can compute changed paths
   between two heads. `syncNode.js`'s `handleReceived` already has `before`/`merged` heads
   (`syncNode.js:35-38`) — Stage 5's addition computes the field-level diff between them (entity,
   entity_id, field, newValue) using Automerge's own diff API, one call, before/after `projectAll`.
2. **Synthesize one `op_applied`-shaped event per changed field**, with the same fields the renderer
   already expects (`entity, entity_id, field, value`), and `author_user_id`/`device_id` set to
   `null`/the remote peer's mapped identity (§4) since a merged CRDT change has no single
   op-log-style author record the way a submitted op does. **This is the one place the payload is NOT
   byte-identical to today's** — `main.js`'s `sanitizeOpForIpc` strips PIN fields by entity/field name
   already (`main.js:120-127`), and that same strip must run on every synthesized event before it
   reaches `webContents.send`, exactly as it does for genuine op-log events. Reuse
   `sanitizeOpForIpc` verbatim — do not reimplement it for the synthetic path (two copies of a
   security-relevant filter is exactly the drift class `IPC_PIN_FIELDS`'s own comment warns about,
   `main.js:53-59`).
3. **A whole-doc replacement (first sync, or seeding) fires `shoresh:full-sync-applied`** — no payload
   needed either way, since the existing handler contract is "re-read everything" (its consumers
   already re-`list()` rather than trust a payload — verify this against the actual
   `onFullSyncApplied` consumers in `src/` during Maker's implementation, but the IPC contract itself
   carries no payload today so there is nothing to match).
4. **A rejected/conflicting write has no Automerge analogue in Stage 5.** CRDTs converge without a
   conflict-resolution UI step — there is no `op_conflict` equivalent to synthesize, because Automerge
   resolves concurrent writes deterministically (last-write-wins per field, or Automerge's built-in
   merge rules) rather than surfacing a `conflicts` table row for a human to pick a side. **This is a
   real, product-visible difference the owner should see named, not hidden inside "compatible push
   events":** the `conflicts` table / `resolveConflict` IPC / pending-conflicts UI simply produce
   nothing under the flagged path, for the entities the doc models. Whether that's the intended
   product behavior for Stage 6 is a question for §7's open list, not something Stage 5 should
   silently paper over by inventing a fake `op_conflict` event.

**Test requirement (PROPOSED, feeds §6):** a Stage 5c-scoped test asserts that, for a synthetic
two-device Automerge convergence exercised in-process, the sequence of `shoresh:op-applied`-shaped
events the (mocked) `webContents.send` receives is parseable by the SAME renderer-side consumers'
existing assertions as a hand-built op-log fixture would be — i.e. structural compatibility, not "we
believe it looks similar."

---

## 4. Membership / identity mapping — the ADR's open item, now due

**PROVEN model to preserve:** Host holds `host_signing_key` (Ed25519 keypair, generated once at
`bootstrapCamp`, never replicated — `localAuth.js:88-117`). `camp` tokens are minted only by whoever
holds the private key (`issueCampToken`, `localAuth.js:139-163`) and verified by anyone holding the
public half (`camps.signing_public_key`, mirrored at `localAuth.js:112-115`, verified at
`verifySessionToken`, `localAuth.js:238-250`). `local` tokens are HMAC'd to a per-device
`device_secret_identifier` set at pairing (`issueLocalToken`, `localAuth.js:165-185`) and are
rejected by the Host's WS layer outright (per the module header comment, `localAuth.js:79-138`
region, and the CLAUDE.md architecture summary). `authorize()` (`authorize.js:19-74`) re-derives role
and device-trust **fresh on every call**, never trusting the token payload beyond
`{userId, deviceId}` — this is the actual security boundary and it must stay exactly this shape
regardless of transport.

**The gap:** libp2p's identity primitive is a PeerId (a keypair-derived identifier), established at
the transport layer (`transport.js`, Stage 4) and used today only to protocol-gate connections
(Security's Stage-4 note, cited in the task: "protocol-gating ≠ authorization"). Nothing currently
maps a PeerId to a Shoresh `userId`/`deviceId`/role.

**Recommendation (PROPOSED — file as its own sub-ADR, not decided here):** the Host's `host_signing_key`
stays the single source of camp membership truth exactly as today; libp2p PeerIds are treated as
*transport-layer* identity only, one layer below the app's own identity, mirroring how a WS connection
today has no bearing on `authorize()` until a token is presented over it. Concretely:

- **Pairing (device joining a camp for the first time) stays token-based, not PeerId-based.** A
  Client dials the Host over libp2p, then — over that now-connected channel — sends the *same*
  `login`-shaped message syncClient/syncServer use today (`syncServer.js:782`, `handleAuthenticate`,
  `syncServer.js:41`), through a small message-framing layer analogous to `wireProtocol.js`
  (Stage 4's `electron/sync/automerge/wireProtocol.js`) but carrying auth messages instead of doc
  bytes. The Host's `attemptLogin` (`localAuth.js:289-349`) is reused verbatim — this is the same
  function WS login already calls, so PIN check, lockout, and audit logging cannot drift between
  transports (this is explicitly why `attemptLogin` is factored out already, per its own header
  comment: "the two login paths ... both route through `attemptLogin` so behavior can't drift" —
  Automerge/libp2p becomes a **third** path through the same function, not a fork).
- **What mints camp tokens:** unchanged — only the Host, via `issueCampToken`
  (`localAuth.js:139-163`), triggered by a successful `attemptLogin` on the Host's device, regardless
  of which transport carried the login attempt. libp2p does not mint tokens; it carries the same
  token-issuing conversation WS carries today.
- **How a Client proves membership on *subsequent* connections (not first pairing):** the Client
  presents its existing camp/local token over the libp2p channel (a new message type in the
  auth-over-libp2p framing above), and `authorize()` is called exactly as it is for WS
  (`authorize.js:19`) — no new authorization code path, only a new transport carrying the same
  token bytes to the same function.
- **PeerId ↔ device mapping:** a `devices` row (already the pairing/trust record —
  `deviceTrust.js:4-14`) gains a nullable `libp2p_peer_id` column, set once at first successful
  libp2p-transport login (mirrors how `device_secret_identifier` is set at pairing). This lets the
  Host recognize a reconnecting known device's PeerId as a fast-path (skip straight to "present your
  token") without it being a trust decision by itself — trust is still `authorize()`/`deviceTrust.js`,
  the PeerId column is purely a connection-routing convenience, exactly analogous to how a WS
  connection's remote address today is not itself a trust signal.
- **Host election:** unchanged from today's model (whichever device ran `bootstrapCamp` and holds
  `host_signing_key`) — Stage 5 does not add host-failover or multi-writer election; that would be a
  materially different trust model and is explicitly out of scope (matches the ADR's already-accepted
  "Host stays a privileged signing role" resolution, `docs/adr/2026-09-06-...md`, resolved per the
  git log entry "Host privileged, hard cutover, LAN-first").

**Why this is likely its own sub-ADR:** this introduces a new wire-level auth handshake (auth-over-
libp2p, distinct from doc-sync-over-libp2p) and a schema change (`devices.libp2p_peer_id`) that other
code will come to depend on for connection routing — both trip the Architect ADR bar in this
project's own constitution (new persistent shape + a contract other modules will call). **Recommend:
file `docs/adr/<date>-libp2p-membership-mapping.md` as Stage 5d's own artifact**, reviewed
independently before implementation, rather than folding it into this general design doc's prose.

---

## 5. Migration of existing SQLite data (seeding)

**PROVEN on-ramp:** `seedAllFromSqlite(db)` (`seed.js:56-62`) reads every modeled entity's current
SQLite rows and folds them into a fresh Automerge document via `applyWrite`
(`campDocument.js:88-101`), entity-order-independent (seed.js:53-55, no FK concerns on read). This is
explicitly required before any `projectAll`/`rebuildFromDoc` run against live data — `projector.js`'s
own comment (lines 126-134) says so.

**One-time sequence on first flag-ON for a camp (PROPOSED):**

1. On `main.js` startup, if `SYNC_ENGINE === 'automerge'` and no persisted doc file exists yet for
   this camp (see persistence below), run `seedAllFromSqlite(db)` **once**, synchronously, before
   `startSyncNode` is called and before any IPC handler is registered — i.e. before the renderer can
   possibly issue a write that would race the seed.
2. Persist the freshly-seeded doc immediately (`saveDoc`, `campDocument.js:73-75`) so a crash between
   seeding and the first sync round doesn't lose it and force a re-seed (`seedAllFromSqlite` is
   idempotent in effect — re-running it just re-derives the same doc content from unchanged SQLite —
   but re-seeding on every restart is wasted work and, more importantly, would silently discard any
   Automerge-only history accumulated between restarts, e.g. tombstones for since-deleted rows that a
   fresh reseed-from-current-SQLite would never reconstruct).
3. From then on, startup **loads** the persisted doc (`loadDoc`, `campDocument.js:76-78`) rather than
   re-seeding.

**Where the doc persists (PROPOSED — recommend a file, not a DB blob):** `<userData>/automerge/
<campId>.automerge` — a plain file next to (not inside) the SQLite database, written via
`fs.writeFileSync` after every `applyLocal`/successful `handleReceived` merge (both already have a
natural "doc changed" event to hook — `syncNode.js:65` broadcast point and `syncNode.js:93` local-apply
point). Recommend a file over a `BLOB` column in SQLite because:
- SQLite is explicitly framed as *derived* in this whole design (`projector.js`'s own header: "SQLite
  is DERIVED, not authoritative... this projector rebuilds it from the document") — storing the one
  authoritative artifact for the flagged path *inside* the derived store inverts that framing and
  would make "wipe the derived store" (a debugging move Maker will want during Stage 5) accidentally
  also destroy the source of truth.
- Matches this project's existing separate-file precedent: `electron/db/userDataPath.js` already
  treats "where does this device's durable state live" as a first-class, explicitly-set concern
  (cited by the ADR at `docs/adr/2026-07-28-explicit-userdata-directory.md`), not something folded
  into whichever table happens to exist.
- `A.save`/`A.load` (`campDocument.js:73-78`) already produce/consume a plain byte buffer — no
  translation needed to move it to/from a file.

**Reload on restart (PROPOSED):** `main.js` startup: read the file if present → `loadDoc` → skip
seeding (step 3 above) → `startSyncNode({ doc, ... })`. File absent → run the one-time seed sequence.

**Write cadence / durability tradeoff (flag for Maker, not resolved here):** writing the whole doc
file on every change is simple and safe but is O(doc size) per write, not O(change size) — fine for
Stage 5's LAN-only, single-camp, test-scope validation, but a real durability strategy (incremental
`A.saveIncremental`, or periodic snapshot + change log) is a Stage 6 concern once real data volume is
known. Note this explicitly in the Stage 5b ticket so Maker doesn't over-invest in it prematurely
(karpathy: smallest responsible thing for a flag that's off by default and being validated, not yet
carrying real camp data).

---

## 6. Test / rollout strategy

**The core proof obligation: flag OFF is a provable no-op.**
- Every existing test in the 333-file / 4807-test suite (per the handoff's own count) runs with
  `SHORESH_SYNC_ENGINE` unset — i.e. today's CI config, unchanged. Full green here is not "new tests
  pass," it is "nothing about the existing suite's *setup* changed," which is the actual no-op proof:
  if the flag's absence required test setup changes, the flag isn't truly inert.
- **New guard test (Stage 5a):** assert `electron/sync/engineFlag.js`'s exported constant is
  `'oplog'` under a plain `import` with no env var set, in a fresh Node process (not just "the module
  hasn't been mutated this test run" — a test that imports it fresh). This is the one test whose whole
  job is to fail loudly if a future edit flips the default.
- **`ipcSurfaceParity.test.js` must stay green with zero edits** — this is the structural proof that
  §2's insertion point didn't touch the renderer-facing contract. If implementing Stage 5b requires
  editing this test file at all (beyond, at most, adding assertions that already-passed calls
  *still* pass), the insertion point was wrong per this design and needs to come back to Architect.

**Flagged-path tests (in-process, CI-runnable):**
- Stage 5a: doc persistence round-trip (seed → save → load → doc equality) — pure Node, no Electron,
  no libp2p, cheap.
- Stage 5b: `appendOp` with `SYNC_ENGINE='automerge'` (test-set, not env-set — module should accept an
  override for testability, e.g. a test-only setter, or the module reads env once and tests use
  `vi.stubEnv` + fresh import) produces both an `operations` row AND a projectable Automerge doc
  change, for a `MODELED_ENTITIES` entity; and produces ONLY an `operations` row (no doc branch taken
  at all) for `template_slots`/parent-scoped/`day_overrides`, per §2's fence.
- Stage 5c: two in-process `syncNode`s (mirrors `syncNode.test.js`'s existing in-process pattern,
  `electron/sync/automerge/syncNode.test.js`) converge, and the synthesized `op_applied`-shaped
  events are asserted structurally parseable (§3's test requirement).
- Stage 5d: membership sub-ADR's own test plan (pairing-over-libp2p, token presentation, `authorize()`
  unchanged) — written when that sub-ADR is designed, not here.

**What needs the owner's two machines (cannot be proven in CI):**
- Real mDNS discovery + libp2p transport across two physical devices on the same LAN (the handoff's
  own "Stage 4d/4e" prerequisite, still open — this design assumes that validation has landed before
  Stage 5c's flagged integration tests are trusted on real hardware, not just in-process).
- A **packaged** build (`electron:build`) actually bundling the Automerge WASM binary and all-ESM
  libp2p dependency graph — this repo has hit exactly this failure class before for a different
  reason (`reference_packaged_src_bundling` — `build.files` not shipping a directory the packaged app
  needed). Stage 5f is explicitly a packaged-build smoke test for this reason, not covered by
  `npm run electron:dev`, which runs unpackaged.

**Rollback path if Stage 5 flagged testing finds a real problem:** since nothing about the OFF path
changed, rollback is "stop setting the env var" — no data migration, no schema reversal needed for
anything in §1-§4 except §4's `devices.libp2p_peer_id` column, which is additive-nullable and safe to
leave in place unused.

---

## 7. Staged sub-plan (smallest-first, reversible, each its own review loop)

| Slice | Scope | Touches a live-path file? |
|---|---|---|
| **5a** | Flag module (`electron/sync/engineFlag.js`) + doc persistence (load/save to `<userData>/automerge/<campId>.automerge`, §5) + the flag-default guard test. No wiring into `appendOp` yet — this slice only proves the flag exists and the doc can round-trip to disk. | No. New files only. |
| **5b** | Write-path dual-write behind the flag: `appendOp` branch (§2), `MODELED_ENTITIES` fence for `template_slots`/parent-scoped/`day_overrides`. | **Yes** — `electron/ops/operations.js` (`appendOp`), the single highest-traffic live-path file in the whole write path. Every existing `appendOp` caller is a blast-radius consideration even though the change is flag-gated; Maker must run the full op-log test suite (not just automerge-scoped tests) after this slice. |
| **5c** | Read/push-event parity: wire `startSyncNode` into `main.js` startup (flag-gated), synthesize `op_applied`-shaped events from doc diffs (§3), reuse `sanitizeOpForIpc`. | **Yes** — `electron/main.js` (startup sequence, push-event senders at `main.js:204/209/235`). |
| **5d** | Membership mapping — its own sub-ADR first (§4), then implementation: auth-over-libp2p framing, `devices.libp2p_peer_id` column, pairing flow reuse of `attemptLogin`. | **Yes** — `electron/auth/**` is the highest-sensitivity surface in this codebase; Security review is mandatory before this slice merges, not optional. |
| **5e** | Seeding-on-first-enable: wire `seedAllFromSqlite` into the startup sequence designed in 5a/5c (§5's full sequence), with the "file absent → seed, file present → load" branch. | **Yes** — `electron/main.js` startup, but additive or ahead of 5c's node start, not a rewrite of it. |
| **5f** | Packaged-build smoke test: `npm run electron:build`, install, launch with flag on, confirm no WASM/ESM bundling failure, confirm two real machines converge over real mDNS+libp2p. Owner's hardware required. | No code change expected — a validation slice. If it fails, the fix (bundler config) is its own follow-up slice, not folded in here. |

Each slice gets its own Maker brief, its own Verifier/Red Hat/Security pass per this project's normal
loop — this document does not shortcut that per-slice governance, it only sequences the work.

**Stage 6 (cutover) is explicitly out of scope for all of the above** — nothing in 5a-5f removes the
op-log, the `conflicts` table, or the WebSocket sync files. The flagged dual-write in 5b is scaffolding
that Stage 6 deletes, not a permanent architecture.

---

## Files/modules affected (summary)

**New:**
- `electron/sync/engineFlag.js` — the flag.
- `<userData>/automerge/<campId>.automerge` — persisted doc file (not a source file, a runtime
  artifact; document the path in `electron/db/userDataPath.js`'s vicinity per that module's existing
  convention).
- `docs/adr/<date>-libp2p-membership-mapping.md` — Stage 5d's sub-ADR (not written here).

**Changed (all flag-gated, no behavior change when flag is off):**
- `electron/ops/operations.js` — `appendOp` dual-write branch (5b).
- `electron/main.js` — startup sequence (seed-or-load doc, start sync node), push-event senders (5c,
  5e).
- `electron/auth/**` — new libp2p auth framing + `devices.libp2p_peer_id` column (5d, its own ADR).

**Untouched (the whole point):**
- `src/localClient.js`, `electron/preload.js` — zero signature changes.
- `electron/ipcSurfaceParity.test.js` — zero edits expected; if edits become necessary, stop and
  return to Architect.
- `electron/automerge/**`, `electron/sync/automerge/**` — Stage 5 consumes these as-built; no changes
  to their internals are anticipated (if one is needed, e.g. a diff-computation helper for §3, add it
  as a new export in the relevant existing file rather than reaching into its internals from
  `main.js`).

## Reused vs. new

**Reused:** `applyWrite`/`projectAll`/`seedAllFromSqlite`/`startSyncNode` (all of Stages 1-4, as-is,
zero modification anticipated); `attemptLogin`/`authorize`/`issueCampToken`/`issueLocalToken` (auth
core, reused verbatim per §4 — the whole point of the membership design is that these do NOT get a
libp2p-specific fork); `sanitizeOpForIpc` (reused for synthetic events, §3); `applyProjection` (already
shared between op-log and doc paths via `projector.js`, no change needed).

**New:** the flag module; the doc-diff-to-`op_applied`-event translation (§3) — this genuinely does
not exist anywhere, since nothing today needs to turn a CRDT merge into an op-log-shaped push event;
the doc-persistence file I/O (§5) — `saveDoc`/`loadDoc` exist but nothing calls them against a real
file path yet; the auth-over-libp2p message framing (§4) — new because today's auth messages are
WS-message-shaped (`syncServer.js`'s `msg.type` dispatch) and libp2p's transport is currently
doc-bytes-only (`wireProtocol.js`).

## ADR required: yes (partial)

This document itself is filed as a design doc, not an ADR, because it is Stage 5's execution plan for
decisions the accepted ADR (`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md`) already made
(Automerge+libp2p, Host-privileged, hard cutover) — it does not introduce a new architectural
tradeoff of its own for §1, §2, §3, §5, or §6 (the flag, the insertion point, the event translation,
the seeding sequence, and the test strategy are all engineering-plan decisions within the ADR's
already-accepted boundary, reversible, and additive).

**§4 (membership/identity mapping) is the exception and DOES meet the ADR bar**: it introduces a new
persistent shape (`devices.libp2p_peer_id`) and a new wire contract (auth-over-libp2p) that other code
(pairing UI, device-trust revocation, Stage 6's cutover) will come to depend on, and it makes a
tradeoff that isn't obviously reversible (how camp membership is proven over a new transport). Per
§4's recommendation, this should be filed as its own sub-ADR, `docs/adr/<date>-libp2p-membership-
mapping.md`, before Stage 5d is implemented — not retrofitted after.

## Open questions for Governor

1. **Conflict UX under Automerge (§3, item 4):** the flagged path produces no `op_conflict` events and
   no `conflicts` table rows for modeled entities — CRDT merge resolves silently. Is silent
   last-write-wins-per-field the intended end-state product behavior for Stage 6, or does the product
   still want a human-visible "two people edited this" surface even under Automerge? This is a product
   decision, not a technical one, and it should be settled before Stage 6, not discovered at cutover.
2. **Flag persistence model for Stage 6:** this design recommends an env var for Stage 5's test scope
   (§1) and explicitly defers "make it a real per-camp setting" to Stage 6. Confirm that's the right
   sequencing rather than building the settings-row version now.
3. **Stage 5d's sub-ADR authorship/timing:** should the membership sub-ADR be written now (in parallel
   with 5a-5c implementation) so 5d can start immediately after, or only once 5a-5c have proven the
   doc/transport plumbing on real hardware (5f)? This affects whether Security should review the
   sub-ADR before or after Stage 5f's hardware validation.
4. **Owner's two-machine availability** for 5f (and the still-open Stage 4d/4e prerequisite this
   document assumes precedes it) — sequencing/timing question, not technical.
