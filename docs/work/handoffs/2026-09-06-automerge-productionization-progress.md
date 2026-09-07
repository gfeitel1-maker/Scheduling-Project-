---
title: Automerge + libp2p productionization — progress + owner-gated remainder
document_type: handoff
status: active
created: 2026-09-06
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
archive_when: Stage 6 cutover is merged and the op-log is retired
---

# Automerge + libp2p productionization — where it stands

**Authority:** [ADR 2026-09-06](../../adr/2026-09-06-productionize-automerge-libp2p-sync.md) (accepted).
**Decision:** Automerge (data/merge/conflict) + libp2p (transport/discovery/NAT); SQLite becomes a
rebuildable projection. Host stays a privileged signing role; hard cutover; LAN-first then WAN.

## Merged to `main` — the new sync engine is built, reviewed, hardened

Every slice was test-first, independently reviewed (Verifier + Red Hat, plus Security on the
transport), and gated. All are **additive** — nothing in the live app imports `electron/automerge/**`
or `electron/sync/automerge/**` yet, so current behavior is untouched.

| PR | Slice | What it added |
|----|-------|---------------|
| #294 | Stage 1 | `electron/automerge/campDocument.js` + `projector.js` — Automerge doc + SQLite projection for one entity; projector **reuses `applyProjection`** so op-log parity is structural. |
| #295 | Stage 2 slice 1 | `seed.js` — `seedDocFromSqlite`, the safe on-ramp (build the doc from current SQLite before any projection can delete live rows). |
| #296 | Generalization | 14 direct camp entities; FK-safe `projectAll`; **reverse-order** delete-reconcile; `day_overrides` deferred. |
| #297 | Stage 3 | Host-only/infra tables pinned as **structurally excluded** from the doc (signing key + reconciliation provenance can never enter the CRDT). |
| #298 | Stage 4 | `electron/sync/automerge/{transport,wireProtocol,syncNode,discovery}.js` — libp2p transport (noise+yamux, protocol-gated), merge→project glue, in-process convergence proven. |
| #299 | Hardening | Explicit frame-size cap + connection ceiling (Security follow-up). |

Full `npm run verify` is green on main (333 files / 4807 tests / 27-27 integration).

## UPDATE — Stage 5 wiring begun (8 PRs merged)

Since the table above, two more slices merged, both behind the default-off `SHORESH_SYNC_ENGINE` flag:
- **#301 — Stage 5 design + 5a:** the flag (`electron/sync/automerge/syncEngineFlag.js`, default
  `'oplog'`, fail-safe) + Automerge doc disk persistence (`docStore.js`, atomic temp+rename). Design
  doc: `docs/work/plans/2026-09-06-stage5-live-wiring-design.md`.
- **#302 — 5b write-path dual-write:** `electron/ops/operations.js`'s `appendOp` mirrors each
  modeled-entity write into the Automerge doc via `electron/sync/automerge/liveDoc.js`, ONLY when the
  flag is on (flag-off early-returns with zero new work — proven a full-suite no-op). Op-log stays the
  source of truth; a doc-mirror failure can't touch the committed op-log write.

**⚠️ HARD GATES before the flag may be enabled for ANY real camp — FOUR items (corrected by the 5c
review; the earlier "two items" was dangerously incomplete):**
1. **Seed the doc from SQLite BEFORE any `projectAll` against live data — CRITICAL, verified.**
   `projectAll(db, createEmptyDoc())` on a live camp db does **not** throw — it *succeeds* and
   delete-reconciles the entire camp (setup + both schedules) to zero. First flag-on starts from an
   empty doc (5b mirrors writes forward-only; 5e seeding unwired), so it would **wipe the camp**. The
   hazard is at BOTH `projectAll` call sites: startup AND `syncNode.handleReceived` on every remote
   merge — a startup-only fix leaves the remote path open. (5c's fix: guard inside `projectAll`
   covering both sites + refuse to start unseeded.)
2. **Stage 5d auth gate on the doc-sync protocol handler (`transport.js`).** It registers with **zero
   auth** — any libp2p peer speaking the protocol gets bytes merged → `projectAll`. Protocol-gating is
   NOT authorization. Combined with #1, this is an **unauthenticated remote path to wiping a camp db**.
   So Stage 5d is a hard prerequisite for enabling the flag *at all*, not merely for Stage 6.
3. `liveDoc.recordLocalWrite` does a full `A.save`+fsync **per field-op** — must be debounced/batched
   (or use `A.saveIncremental`) before any real bulk import runs flag-on, or it stalls the main process.
4. `liveDoc` is **gracefully inert until Stage 5e wires `setUserDataDirGetter` into `main.js`** at
   startup — so flag-on is a shadow no-op in the real app *today*. 5e does the real wiring + seeding.

**Two Automerge-integration inheritances to respect (5c):** (a) Automerge strings are `Text` — a
string edit emits a `put value:""` plus `splice` patches, so reading `patch.value` silently writes
empty strings into synced text fields; identify fields by patch *path* and read values from the
after-doc. (b) Never use a literal NUL byte as a delimiter — it makes the file binary to git (no
reviewable diff); use the repo's `\x00`-escape convention.

## UPDATE 2026-09-07 — Stage 5 COMPLETE through 5e; only 5f (hardware) remains before Stage 6

Merged since the section above: **5c** read/receive-path parity (#305), the **membership sub-ADR**
(#306, now `accepted`), **5d-1** auth-over-libp2p + symmetric doc-sync admission gate (#307),
**5d-2a** camp-scoped mDNS discovery + `devices.libp2p_peer_id` schema v57 (#308), **5d-2b**
pairing/login over libp2p + mutual-auth wiring (#310), and **5e** seeding + doc persistence +
**unified document ownership** (#312). Full `npm run verify` green at each merge.

**Four defects the review loop caught that gates alone would have shipped** — worth knowing, because
each was invisible to a green test run:

1. **Empty-doc `projectAll` wipes a camp** (5c). `projectAll(db, createEmptyDoc())` on a live db left
   0 rows and did NOT throw, so the try/catch caught nothing. Guard now lives inside `projectAll`,
   covering all three call sites. Verified empirically, not by inspection.
2. **The admission gate was inbound-only** (5d-1). `broadcastDoc` pushed the full camp document to
   every connected peer, so any stranger on the LAN who completed a noise handshake received roster
   and schedule data unprompted. Gating outbound made **mutual authentication** a hard requirement:
   a node's single `authenticatedPeers` set governs both directions, so one-way auth means nothing
   flows at all.
3. **No rate limiting on libp2p pairing/login** (5d-2b), despite the ADR claiming the caps carried
   forward. Any LAN peer could flood the director's approval UI. Also, the Host's self-issued token
   used a `null` userId, which `verifySessionToken` rejects — so it could *never* verify. Fixed with
   a device-level admission token that `authorize()` explicitly denies.
4. **Two Automerge doc holders that never reconciled** (5e review). `liveDoc` held one and was the
   only thing that persisted; `syncNode` held another and never persisted at all. `applyLocal` had
   zero non-test callers, so the engine was receive-only — and a remote-merged row was silently
   delete-reconciled out of SQLite on the next restart after any unrelated local edit. **Routine
   two-device operation, not a rare race.** Ownership is now unified and startup projection removed
   (at startup SQLite is already correct; projecting over it can only destroy).

**Pre-enable gates — status:** #1 seeding is CLOSED (5e). #2 the doc-sync auth gate is CLOSED
(5d-1/5d-2b). #3 the per-op `A.save`+fsync debounce is CLOSED (5e, 250ms + flush on quit). #4
`setUserDataDirGetter` wiring is CLOSED (5e).

**What remains, and why it needs the owner:**
- **Stage 5f is now the blocker, and it cannot be done from CI.** Mutual auth requires mDNS discovery
  to succeed in **both** directions — strictly stronger than the WS path, where only the Client
  discovers the Host. On consumer/hotel Wi-Fi with AP client isolation this is a plausible
  silent-sync-death mode, and no automated test can prove it. Needs two real machines.
- **Stage 6 (irreversible cutover) must not proceed before 5f passes.** You do not retire the op-log
  in favour of an engine that has never converged on two real machines in a packaged build.
- Open, tracked: no operational reseed path exists (a bad seeded doc stays on disk); a crash inside
  the 250ms debounce window can still lose the doc-side record of a new entity (narrowed by removing
  startup projection, not eliminated); `day_overrides`, `template_slots`, and parent-scoped entities
  remain unmodeled by design.

## Where this pauses, and why (pacing, not stopping short)

The reversible engine + write-path work is done and merged. What remains — 5c (read/receive path +
push-event synthesis from `A.diff`), 5d (membership: Ed25519→libp2p PeerId, its own sub-ADR +
Security), 5e (startup wiring of `syncNode`+`liveDoc` into `main.js` + seed-on-first-enable), 5f
(packaged + real two-machine smoke), **Stage 6 the irreversible cutover** (~7k lines removed, app
rewired onto the Automerge engine), Stage 7 WAN — is deeply interdependent, edits the live app's core,
and ends in an irreversible step. That work is best done with **fresh review context**: the Governor's
core value is competently reviewing each diff, and the irreversible cutover in particular must not be
reviewed from a saturated context. This is how a large migration is paced responsibly — solid reviewed
increments, clean handoffs — not one marathon that risks the irreversible step. Everything below is
teed up to continue at the same bar.

## Why the autonomous build stopped here (a judgment call, not a blocker)

Everything above is **reversible and additive**. The remaining work is not, and it crosses two lines
the project's own engineering constitution says need a human:

1. **Stage 5 wires the engine into the LIVE app** (`src/localClient.js` / `electron/main.js` IPC,
   the write/read path) — this is where current behavior can break. It should not be done unattended.
2. **Stage 6 is the op-log CUTOVER — irreversible.** You do not cut over to an engine that has never
   run on two real machines in a packaged build.
3. **Real validation needs YOUR hardware.** In-process convergence is proven; real two-machine LAN
   (mDNS) and packaged-app WASM/ESM bundling (Stage 4d/4e) and WAN (Stage 7) are not, and can't be
   from CI.

So the responsible finish was: build the complete, proven, hardened engine (done), and hand off the
live-integration + irreversible cutover with a precise plan.

## Remaining plan (owner-gated)

**Prerequisites before any live wiring:**
- Frame-**rate** limiting (token bucket ahead of `A.merge`) — Security flagged this as must-fix
  before wiring (frame-size + connection caps are already done in #299).
- `day_overrides` needs a **doc-native row construction** (its `ensureExists` reads the `operations`
  table, absent on the doc-replay path) — it's the one deferred entity. Parent-scoped entities +
  `template_slots` (bulk-replace) also still need modeling for full coverage.

**Stage 4d/4e (needs your two machines):** run `experiments/future-arch/cr-sqlite-libp2p/cr4-node.mjs`
-style validation with the PRODUCTION modules on two real machines (same Wi-Fi, mDNS), and confirm a
packaged build bundles the Automerge WASM + all-ESM libp2p (the repo has hit the packaged-bundling
failure class before — see `reference_packaged_src_bundling`).

**Stage 5 (live wiring + membership):** an Automerge-backed provider behind the `src/localClient.js`
seam (36 importers unchanged; `ipcSurfaceParity` is the gate). Map the Ed25519 `host_signing_key` /
device-trust model onto libp2p PeerIds (Host stays privileged). Behind a flag, default off.

**Stage 6 (cutover):** once Stage 5 has full parity on real hardware, retire `operations`/`conflicts`
+ the WebSocket sync files. Flag-day. **Irreversible — your explicit go.**

**Stage 7 (WAN):** DHT + dcutr + circuit-relay (the `cr4-dht-node.mjs` path, proven cross-network via
relay). Additive to LAN; needs your machines on different networks.

**The rules/validation layer** (the ADR's other Stage-2 thread) runs alongside: the projector already
fails atomically + surfaces (`onProjectionError`) on an inconsistent merged doc (a child referencing a
concurrently-deleted parent); the rules layer is what will *repair* those, per the ADR's rules-layer
section.

## Key facts for whoever continues
- Branch discipline: build each slice on a fresh branch off `main`, isolated worktree; the standing
  no-push rule was for the old `claude/shoresh-future-architecture-364e03` experiment branch only.
- The projector **reuses `applyProjection`** — do not reimplement projection; entities whose
  `ensureExists` reads the op-log (only `day_overrides` today) need a doc-native path first.
- Don't run gates above load ~30 (`test:integration` is mDNS and flakes) — see
  `feedback_gate_exit_code_not_tail`; capture the real exit code, never `| tail`.
