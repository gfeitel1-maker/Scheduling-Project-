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
