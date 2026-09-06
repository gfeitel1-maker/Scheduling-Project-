---
title: "Design: Stage 4 — libp2p transport spike, LAN-only"
document_type: design
status: proposed
authority: informative
date: 2026-09-06
related_adr: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
related_discovery:
  - experiments/future-arch/ENGINE_SELECTION.md
  - experiments/future-arch/cr-sqlite-libp2p/test-cr4-live.mjs
  - experiments/future-arch/cr-sqlite-libp2p/cr4-node.mjs
  - experiments/future-arch/cr-sqlite-libp2p/cr4-dht-node.mjs
  - experiments/future-arch/cr-sqlite-libp2p/test-libp2p.mjs
program: shoresh-future-architecture
---

# Design: Stage 4 — libp2p transport spike, LAN-only

> Feeds a Maker + Security/Red Hat/Verifier loop. Does not authorize Stage 5/6/7. Scope is exactly
> what the ADR's Stage 4 line names: *"libp2p transport spike, LAN-only first (mDNS discovery +
> Automerge's own sync protocol over a libp2p stream), replacing `discovery.js` and a minimal slice
> of `syncServer.js`/`syncClient.js`, proving parity with today's LAN-only Host/Client flow before
> attempting DHT/dcutr WAN traversal."* WAN (DHT/dcutr/relay) is Stage 7 — out of scope here, noted
> only where the module boundary must not foreclose it.

## Candidate approaches considered

Closed case for the top-level choice — the ADR and `ENGINE_SELECTION.md` already converged on
libp2p as the transport, with two proven prototype shapes (`cr4-node.mjs` mDNS-interactive,
`test-cr4-live.mjs` in-process headless) and a rejected alternative (cr-sqlite, demoted on
maturity). Re-litigating transport choice is not this design's job. Divergence is applied instead
to the one genuinely open technical question this stage must decide: **which sync protocol carries
the document across the wire.**

1. **Full-document exchange** (`A.save`/`A.merge`, exactly what `test-cr4-live.mjs` does). Send the
   entire compressed Automerge binary on every change and on every new connection; the receiver
   merges it in. Assumption: document size stays small enough (single-camp schedule data, not a
   multi-tenant dataset) that resending the whole thing is cheap.
2. **Automerge's incremental sync protocol** (`generateSyncMessage`/`receiveSyncMessage`, one
   `SyncState` per peer-pair). Peers exchange head/diff messages until converged, sending only what
   the other side is missing. Assumption: document will grow large enough, or peers will be
   reconnecting often enough on constrained LAN bandwidth, that the diff matters.
3. **Automerge's incremental sync, but only for the reconnect/catch-up path, full-doc for first
   pairing.** A hybrid: new peer gets `A.save()` once (equivalent to today's `sendFullSyncIfFirstPairing`
   first-sync semantics), subsequent live edits go through the incremental protocol. Assumption:
   the two paths already exist conceptually in the current WS protocol (`catchup.js`'s
   full-sync-vs-missed-ops split) and mapping onto that seam.

Rejected: (2) alone, for this stage — it is the more "correct" long-term choice but is unproven
here (no prototype exercised it; `SyncState` is a mutable per-connection object that needs its own
lifecycle management alongside libp2p's connection lifecycle, which is new surface, not just a
protocol swap) and the ADR's own framing is "prove parity with today's flow" first, not "build the
most scalable version." (3) is the right shape for Stage 5+ (it mirrors `catchup.js`'s existing
full-sync/missed-ops split almost exactly) but is more machinery than a transport *spike* needs to
prove the point Stage 4 exists to prove. See "Sync protocol choice" below for the recommendation
and confidence.

## Approach

### Module shape

New directory: `electron/sync/automerge/` (sibling to the existing WS files, not nested under
`electron/automerge/` — that directory is the *document* layer, pure and Electron/IPC-free by its
own file-header convention; this is *transport*, which owns Node/libp2p process concerns and does
not belong mixed into the pure layer).

```
electron/sync/automerge/
  transport.js       # node lifecycle: start/stop, mDNS, protocol handler, send/broadcast
  discovery.js        # thin libp2p-mDNS wrapper — NOT a rename of the existing electron/sync/discovery.js
  wireProtocol.js      # encode/decode framing + the one PROTO string, isolated for testing without a real node
  transport.test.js
  wireProtocol.test.js
```

`electron/sync/discovery.js` (Bonjour-based) is **not deleted or edited in this stage** — see
"Reused vs. new." The existing `syncServer.js`/`syncClient.js` continue running the WS protocol,
untouched, behind the still-active flag from Stage 1. Stage 4's code is new and additive, exercised
by its own tests; it is not wired into `main.js`'s live handler bodies yet — that wiring, and the
flag that chooses between WS and libp2p transport at runtime, is Stage 5/6 territory (the ADR's
hard-cutover decision means there is no dual-write window to design for, but Stage 4 itself is
still "prove the transport works," not "cut the app over").

**`transport.js` exported API** (the deep-module interface Maker implements against):

```js
// Start a libp2p node for this device. mDNS-advertises AND discovers on the
// same call — LAN peering doesn't need a separate Host/Client role at the
// libp2p layer (see "Host stays privileged" below for why the ROLE persists
// one layer up, not here).
export async function startTransport({ campId, deviceId, onDocReceived }) → TransportHandle

// TransportHandle:
{
  peerId: string,                          // libp2p PeerId, stringified
  getPeers: () => string[],                 // connected peer ids
  broadcastDoc: (docBytes: Uint8Array) => Promise<void>,   // send current doc to all connected peers
  sendDocTo: (peerId: string, docBytes: Uint8Array) => Promise<void>,
  stop: () => Promise<void>,
}
```

`onDocReceived(bytes, { fromPeerId })` is the one callback a caller supplies; `transport.js` never
touches Automerge (`A.load`/`A.merge`) or SQLite itself — it hands raw bytes up. The caller (a
thin glue module built in this same stage, or Stage 5's real wiring) is responsible for:

1. `A.merge(currentDoc, A.load(bytes))`
2. If the merged doc's heads changed, call `projector.projectAll(db, mergedDoc)` (existing,
   Stage-1/5-proven function — this stage does not add a new projection path).
3. Persist the merged doc (`saveDoc`) to whatever on-disk store Stage 1 already uses for the
   Automerge binary.
4. Re-broadcast to other connected peers except the sender (mirrors `test-cr4-live.mjs`'s
   `peer.broadcast(connection.remotePeer)` except-self pattern) — required so a 3+ peer LAN mesh
   propagates without needing every peer directly connected to every other peer.

This callback-up, no-Automerge-knowledge-inside-transport.js shape is deliberate: `transport.js` is
testable with plain byte arrays (no Automerge fixture needed for its own unit tests), and the
Automerge-merge-then-project sequence — the part with real domain consequences — lives in one
place the Security/Red Hat reviewers can find without reading libp2p internals.

**Protocol-gating** (`wireProtocol.js`): registers exactly one protocol string,
`/shoresh/automerge/1.0.0`, via `node.handle(PROTO, handler)`. This is both the framing boundary
and — per the prototype's own fixed bug (`ENGINE_SELECTION.md` line 126: *"briefly broadcasting the
doc to random DHT peers"*) — the security gate: a peer that never dials this exact protocol string
never receives a document, full stop. `wireProtocol.js` owns the length-prefixed encode/decode
(`it-length-prefixed` + `it-pipe`, exactly as `test-cr4-live.mjs` does) so this framing logic has
its own unit tests independent of a live two-node connection.

### Sync protocol choice

**Recommend full-document exchange (`A.save`/`A.merge`) for Stage 4, matching the proven
prototype exactly.** Confidence: high for Stage 4 specifically; medium-low that this stays the
right choice once Stage 5 widens to every camp-scoped entity and the document grows.

Rationale:
- **Proven, not proposed.** `test-cr4-live.mjs` (6/6) and `cr4-node.mjs` (real two-machine LAN run)
  both use full-doc exchange. Stage 4's job, per the ADR, is to graduate this exact path "from
  prototype to production code path" — swapping the sync algorithm at the same time as productionizing
  the transport conflates two changes into one stage and removes the evidence base this stage is
  supposed to carry forward.
- **Automerge documents compress well and Shoresh's is small.** A camp's full schedule/setup data
  (groups, activities, tiers, days, slots for one camp session) is not a multi-tenant or
  long-history dataset; `A.save()` output for a document this size is realistically kilobytes, not
  megabytes, and LAN bandwidth is not the constraint WAN would be. This is a judgment call, not
  measured yet — **flag as evidence to gather in this stage's test slice**: the acceptance test
  (below) should log the serialized doc size after a representative Stage-1-shaped seed, so Stage 5
  planning has a real number instead of an assumption.
- **Incremental sync (`generateSyncMessage`/`receiveSyncMessage`) is real future work, not
  discarded.** It is the right choice once the document is large or peers reconnect frequently
  over a slow link (the WAN case, Stage 7, is exactly that link). Scope it explicitly as a **Stage
  5 or Stage 7 revisit**, not a silent deferral: `transport.js`'s `broadcastDoc`/`sendDocTo` API
  above is written in terms of opaque `docBytes`, not `A.save()` specifically, so swapping the
  encoding later (a `SyncMessage` instead of a full doc) does not require changing `transport.js`'s
  signature — only what the caller passes in. That is the seam this stage's API shape is protecting.

### Dependency plan

Pin exactly the prototype's proven versions (from
`experiments/future-arch/cr-sqlite-libp2p/package.json`), not "latest":

| package | version | role |
|---|---|---|
| `libp2p` | `2.10.0` (pinned — v3 broke the documented stream API mid-prototype) | node runtime |
| `@libp2p/tcp` | `^10.1.19` | LAN transport |
| `@chainsafe/libp2p-noise` | `^16.1.5` | connection encryption |
| `@chainsafe/libp2p-yamux` | `^7.0.4` | stream muxing |
| `@libp2p/identify` | `^3.0.39` | peer identify (used by the prototype's `peer:identify` gate) |
| `@libp2p/mdns` | `^11.0.47` | LAN discovery — the Stage-4-relevant piece |
| `it-pipe` | `^3.0.1` | stream piping |
| `it-length-prefixed` | `^9.1.1` | message framing |
| `@automerge/automerge` | `^3.4.1` | already a dependency post-Stage-1 |

**Explicitly NOT added in Stage 4** (Stage 7 territory): `@libp2p/kad-dht`, `@libp2p/dcutr`,
`@libp2p/autonat`, `@libp2p/circuit-relay-v2`, `@libp2p/bootstrap`, `@multiformats/multiaddr`. Only
`@multiformats/multiaddr` might be needed early for logging/debugging multiaddrs even LAN-only;
Maker should add it only if a concrete need arises during implementation, not preemptively.

**Pure-JS/WASM confirmed.** `ENGINE_SELECTION.md` line 97 states `cr4-node.mjs` is "pure JS/WASM,
no native build" — Automerge's WASM core plus libp2p's all-JS transport stack. This is a materially
different risk profile from `better-sqlite3` (a native binary requiring the
`electron-rebuild`/`npm rebuild` ABI dance documented in this repo's `CLAUDE.md`): **no rebuild step
needed when switching between `npm run test` (Node/Vitest) and `npm run electron:dev` (Electron)**
for this new code. Confirm this holds under Electron's actual bundler/packager in Stage 4's own
test slice (see below) — "no native build" was proven in a standalone Node script, not yet inside
Electron's main-process bundle.

**Electron-main-process concerns to verify explicitly, not assume:**
1. **ESM.** The prototype files are `.mjs`. Confirm `electron/main.js` and the rest of
   `electron/**` are ESM already (check `package.json`'s `"type"` field) — if the Electron main
   process is currently CommonJS, `libp2p`'s packages (ESM-only, as of the versions above) need
   either a `.mjs`/dynamic-`import()` boundary or a build-step transform. This is a concrete
   go/no-go check, not a design decision — do it before writing `transport.js`, not after.
2. **WASM loading inside a packaged (not just dev) Electron app.** Automerge's WASM binary must be
   included by `electron-builder`'s file globs — the exact failure class this repo already hit once
   for plain JS (`reference_packaged_src_bundling.md`'s `build.files` gotcha) is a real risk for a
   WASM asset specifically. Add a packaged-app smoke check to this stage's acceptance criteria, not
   defer it to Stage 6.
3. **Coexistence with `better-sqlite3`.** No expected conflict (different processes of concern —
   libp2p opens sockets, better-sqlite3 opens a file handle) but both now load in the same Electron
   main process at startup; verify no port/handle contention in the existing dev/packaged split
   (`shoresh-dev` vs `shoresh` userData paths) — this is a "should be fine, confirm it," not a
   known risk.
4. **mDNS + macOS/Windows firewall prompts.** The existing Bonjour-based `discovery.js` already
   triggers a local-network-permission prompt on macOS; `@libp2p/mdns` will trigger an equivalent
   one. Not a blocker, but should not surprise the owner's two-machine validation slice (see Test
   strategy) — worth one line in that slice's runbook.

### The seam to the live app

Stage 4 does **not** wire this transport behind `localClient.js` — that is explicitly Stage 5/6
work (the ADR's "hard cutover" decision means the wiring happens once, in one clean move, after
parity is proven, not incrementally through Stage 4). But `transport.js`'s API is designed so that
wiring is mechanical when Stage 5/6 arrive:

- The renderer's `localClient.js` surface (`chooseMode`, `discoverHosts`, `login`, etc.) and
  `electron/preload.js`'s ~70 channel names are **untouched by this stage** — nothing in this
  design adds, removes, or renames an IPC channel. `ipcSurfaceParity.test.js` continues to pass
  unmodified through Stage 4 because Stage 4 doesn't touch anything it asserts on.
- `discoverHosts` (`electron/sync/discovery.js`, Bonjour) is the renderer-visible discovery call
  today (`electron/preload.js:5`). Stage 5/6 will need to decide whether `discoverHosts`'s IPC
  *handler* (in `main.js`) gets re-pointed to `transport.js`'s libp2p-mDNS peer list instead of
  Bonjour's `discoverHosts()` — same channel name and response shape (`{name, host, port}`-like),
  different backing mechanism. Stage 4 proves the backing mechanism works; it does not do this
  re-pointing.
- **Host stays a privileged signing role — this maps onto libp2p as an authorization check one
  layer above the transport, not as a libp2p-level peer-type.** At the transport layer built here,
  every libp2p peer is symmetric (any node can dial, advertise, and hold a stream) — this mirrors
  the ADR's Open Question 1 resolution exactly: libp2p transport becoming peer-to-peer does not
  make the *authority* model symmetric. `transport.js` has no concept of "Host" or "Client" at all.
  The mapping of "which peer may mint `camp` tokens" onto "which libp2p `PeerId` that is" is
  explicitly **Stage 5's job** (the ADR names this "Membership/identity... within or alongside
  [Stage 5]... because it is security-consequential and not obviously reversible"). Building that
  mapping into Stage 4's transport module would be doing Stage 5's design work inside a spike —
  avoid it. Stage 4's acceptance test therefore uses two symmetric nodes, exactly like
  `test-cr4-live.mjs`, with no Host/Client distinction — that asymmetry is intentionally deferred.

### Test strategy

**In-process, no physical hardware needed (this stage's acceptance gate):** a Vitest test
structured exactly like `test-cr4-live.mjs` but as a real test file (`transport.test.js`), asserting:
1. Two `startTransport()` nodes on `127.0.0.1` with ephemeral ports connect (via direct `dial`,
   not mDNS — mDNS needs a real network interface and is unreliable in CI/sandboxes; this is why
   the prototype's own headless test dials directly and treats mDNS as `cr4-node.mjs`'s separate,
   interactive-only concern).
2. A doc broadcast from node A reaches node B's `onDocReceived` callback with byte-identical
   content.
3. Feeding both nodes' received bytes through `A.merge` + `projector.projectAll` against two
   **separate** in-memory SQLite databases converges both databases to identical row sets — this is
   the concrete "parity with today's LAN-only Host/Client flow" acceptance criterion the ADR names,
   made mechanical: previously the WS protocol proved this with `scheduleE2E.sync.test.js`
   (existing, `electron/sync/`); Stage 4 needs its own equivalent for the libp2p+Automerge path
   before Stage 5/6 can claim parity.
4. A same-slot concurrent edit on both nodes converges and is detectable via `A.getConflicts`
   after both sides receive each other's edit (mirrors `test-cr4-live.mjs`'s existing 2 conflict
   checks) — proves the rules-layer's conflict-surfacing story (Stage 2, already built) actually
   receives real conflicting data over this real transport, not just synthetic doc merges in a unit
   test.
5. A node that never dials the `/shoresh/automerge/1.0.0` protocol (a generic libp2p peer) never
   triggers `onDocReceived` — the protocol-gating security property, made an explicit assertion
   rather than an implicit consequence of the prototype's bug fix.
6. Document size logging (see "Sync protocol choice" above) — not a pass/fail assertion, a recorded
   number for Stage 5 planning.

This whole suite runs in CI with no network dependency beyond loopback TCP — same posture as the
existing `electron/sync/*.sync.test.js` suite.

**Genuinely needs the owner's two physical machines, deferred to its own slice (4d below), not
blocking Stages elsewhere:**
- Real mDNS discovery on an actual LAN (loopback dial in the automated test does not exercise
  `@libp2p/mdns`'s real advertise/discover path — `cr4-node.mjs` already proved this once on the
  owner's hardware for the prototype, but the *production* module (`electron/sync/automerge/discovery.js`)
  is new code and needs its own confirmation run, not an inherited assumption from the prototype).
- The packaged-Electron-app WASM/bundling check (point 2 under Dependency plan) — can partly be
  done by CI (packaging a dev build and inspecting the output for the WASM asset) but a real launch
  on both target OSes (Mac/Windows) is lower-risk to confirm by hand once, per the ADR's own
  "confirm before implementation" framing for native/packaging risk.
- WAN/direct-punch validation is explicitly **Stage 7**, not Stage 4 — noted here only to state it
  is out of scope, not to imply it's owed by this stage.

### Security surface (for Security review)

- **Noise encryption**: `@chainsafe/libp2p-noise` gives every connection (including a same-LAN
  connection) end-to-end encryption by default — a strict improvement over the current WS transport,
  which the ADR's context section does not describe as using TLS on LAN. Confirm during
  implementation whether the current `ws://` LAN transport is already expected to run only on
  trusted home/camp networks (likely, given "LAN-only" framing) — if so, this is a hardening
  bonus, not a requirement being relaxed.
- **Protocol gating is the primary access control at this layer.** A node only receives Automerge
  bytes if it dials `/shoresh/automerge/1.0.0` and the receiving handler accepts the stream — this
  is necessary but **not sufficient** as camp-membership enforcement: it proves "this peer speaks
  the Shoresh wire protocol," not "this peer is an authorized device for this camp." At Stage 4,
  with no Host/Client or device-trust mapping built yet (explicitly Stage 5), **any two Stage-4
  nodes on the same LAN that both speak the protocol will merge documents with each other** — this
  is acceptable for Stage 4's spike/test scope (in-process test, not deployed) but **must not be
  mistaken for camp isolation** once real deployment is considered. Call this out explicitly in the
  Stage 4 PR/design so Red Hat and Security don't have to rediscover it: **Stage 4 proves the pipe
  works; Stage 5 makes the pipe only connect to the right peers.**
- **What must NOT be trusted from a peer at this layer:** the received doc bytes are untrusted
  input — `A.load()` on malformed/adversarial bytes must not crash the process or corrupt the
  local document; `A.merge()`'s CRDT semantics mean a malicious peer can inject garbage *fields*
  (e.g. `activities.foo.location = "malicious string"`) but cannot violate Automerge's own
  structural guarantees the way a raw SQL injection could — however, this is exactly why the
  rules/validation layer (Stage 2, already built) matters: garbage-but-structurally-valid data from
  a peer must be caught by the rules layer, or projected and surfaced as a flag, not blindly
  trusted into SQLite. Stage 4's test slice should include one adversarial-bytes case (malformed
  Automerge binary) asserting the receiving node does not crash.
- **Camp membership / auth interaction**: unresolved at Stage 4 by design (see "Host stays
  privileged" above) — flag for Security that today's Ed25519 camp-token / device-trust model
  (`electron/auth/`) has **no relationship yet** to a libp2p `PeerId`. This is a known, named gap
  (the ADR's Open Question 1 + Stage 5 membership/identity work), not an oversight to catch in this
  review — but Security should confirm the Stage 4 PR states this gap explicitly rather than
  silently, so it isn't later assumed solved.

### A staged sub-plan for Stage 4 itself

Each slice below is its own small, reversible, test-first review-loop round (per the ADR's own
"each stage is its own... slice" framing, applied one level down within Stage 4):

- **4a — `wireProtocol.js`: framing + protocol string, unit-tested with plain byte arrays.**
  No libp2p node needed for this slice's own tests (mock the stream source/sink). Smallest possible
  first cut; nothing else in Stage 4 depends on a *node* yet, just correct framing.
- **4b — `transport.js`: in-process two-node lifecycle + broadcast, headless.** Direct `dial`
  (no mDNS yet), asserting connect/send/receive/stop — the `test-cr4-live.mjs`-shaped acceptance
  test (points 1, 2, 5 under Test strategy above). This is the slice that proves the transport
  module's own API contract.
- **4c — The Automerge-merge + `projector.projectAll` hookup**, as the small glue module consuming
  `transport.js`'s `onDocReceived` callback (Test strategy points 3, 4, 6). This is the first place
  Stage 4's code touches the document/projection layer built in Stages 1-3 — isolate it as its own
  slice so a review can focus on "does this call the existing projector correctly" without also
  reviewing libp2p plumbing in the same diff.
- **4d — `@libp2p/mdns` discovery wrapper**, exercised first by a headless test (peers on loopback
  do not really need mDNS, so this slice's automated test is necessarily thin — mostly "does the
  wrapper call the right libp2p API without crashing") and then by the owner's real two-machine LAN
  run as the actual acceptance evidence, mirroring `cr4-node.mjs`'s already-proven result but for
  the production module. This slice is the one that needs the owner, and should be sequenced last
  so 4a-4c can be fully reviewed and merged on CI evidence alone first.
- **4e — Packaged-app WASM/bundling + ESM smoke check.** A narrow slice: build a dev-mode packaged
  app (or use the existing `deploy:local` smoke path) and confirm the new dependency tree loads in
  the actual Electron main process, not just under Vitest. Sequenced after 4b/4c prove the code
  itself works, so this slice is purely "does packaging carry it," not "does the code work."

## Files/modules affected

New:
- `electron/sync/automerge/transport.js`, `transport.test.js`
- `electron/sync/automerge/wireProtocol.js`, `wireProtocol.test.js`
- `electron/sync/automerge/discovery.js`, `discovery.test.js` (mDNS wrapper — distinct file from,
  and not a replacement for in this stage, the existing `electron/sync/discovery.js`)
- `package.json` — new dependencies listed above, pinned versions

Unchanged in this stage (confirmed, not assumed):
- `electron/preload.js`, `src/localClient.js`, `src/localClient.mock.js`, all 36 renderer consumers
- `electron/sync/syncServer.js`, `syncClient.js`, `catchup.js`, `opDelivery.js`,
  `electron/sync/discovery.js` (the existing Bonjour/WS files — still the live production path)
- `electron/automerge/campDocument.js`, `projector.js`, `seed.js` (Stage 1-3 outputs, reused as-is)
- `electron/ipcSurfaceParity.test.js` (should still pass, untouched, as evidence this stage didn't
  drift the IPC surface)

## Reused vs. new

**Reused (PROVEN):**
- The transport shape itself — `createLibp2p` config (tcp + noise + yamux + identify), the
  `PROTO` string, length-prefixed framing, dial/handle/broadcast pattern — copied near-verbatim
  from `test-cr4-live.mjs`, which is exactly the point: Stage 4 graduates proven prototype code, it
  does not redesign the transport.
- `electron/automerge/projector.js`'s `projectAll` (Stage 1/5) — Stage 4's glue slice (4c) calls it
  unmodified; no new projection logic is written.
- `electron/automerge/campDocument.js`'s `applyWrite`/`saveDoc`/`loadDoc` — used by the glue slice
  to load/merge received bytes; unmodified.

**New (PROPOSED, unproven until 4a-4e land):**
- Packaging the prototype's throwaway `.mjs` scripts into a real, tested, reviewed module under
  `electron/sync/automerge/` with a stable exported API (`startTransport`/`TransportHandle`) that
  Stage 5/6 can wire against — the prototype scripts have no such API, they're standalone CLIs.
  Nothing existing in `electron/sync/` covers this; the existing WS files are protocol-specific to
  the op-log/WebSocket design and are not being generalized, they're being run in parallel until
  Stage 6's cutover.
- The mDNS wrapper (`@libp2p/mdns`) as production code — the prototype exercised this interactively
  (`cr4-node.mjs`) but never as a reviewed, tested module.

## ADR required: no

This design implements Stage 4 exactly as scoped in the already-accepted
`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md` — it introduces no new persistent data
shape (the Automerge document shape is Stage 1/5's, unchanged here), changes no existing contract
(`localClient`/IPC surface is explicitly untouched), and makes no irreversible tradeoff of its own:
the sync-protocol choice (full-doc vs. incremental) is stated with rationale but is not baked into
an unchangeable wire format — `transport.js`'s API passes opaque bytes precisely so that choice
stays revisitable at Stage 5/7 without a migration. The genuinely irreversible/security-consequential
decision this whole program contains — Host-as-privileged-role mapped onto libp2p `PeerId`s — is
explicitly out of scope for Stage 4 and reserved for its own Stage 5 ADR, as the parent ADR already
states.

## Open questions for Governor

1. **Slice sequencing 4a-4e vs. a single combined PR.** This design proposes five sub-slices; Governor
   may reasonably decide 4a+4b are small enough to combine into one Maker round, or that 4d (the
   owner's hardware) should be scheduled separately from 4a-4c+4e's CI-provable work so the CI-only
   slices aren't blocked waiting on the owner's calendar. Technical shape doesn't depend on this
   call; sequencing/scheduling does.
2. **Whether to measure real document size in this stage or defer to Stage 5.** The design
   recommends logging serialized doc size as evidence during Stage 4's own test (point 6 under Test
   strategy) using whatever seed data Stage 1's tests already construct — confirm this is
   acceptable as "good enough" evidence, or whether the owner wants it measured against a more
   realistic full-camp dataset before Stage 5 planning locks in full-doc vs. incremental.
3. **Firewall/permission-prompt UX for mDNS on the owner's two machines (slice 4d)** is a product
   surface question (does a permission-denial need a director-facing error state?) that this design
   deliberately did not answer — it is out of scope for a transport spike but should not surprise
   whoever runs the 4d validation.
