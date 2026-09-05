# Future-architecture experiments (disposable)

These are **throwaway probes**, not app code. They import nothing from `electron/`
or `src/`. Purpose: prove or disprove specific assumptions behind a "shared
collaborative document" model for a Shoresh camp project. Delete freely.

## 1. Host-less op-log over a shared folder — `oplog.cjs` + `run.cjs`

Question: if we drop the always-on **Host** that assigns order today, and let peers
exchange operations through a plain shared folder, do two SQLite databases still
**converge** under duplicates, reordering, offline gaps, restarts, partial writes,
and genuine conflicts?

The one substitution being tested:
- Host-assigned `seq` → **Lamport logical clock + deterministic tiebreak**
- Host adjudication → **Last-Writer-Wins by `(lamport, device_id)`**, with genuine
  concurrent edits **recorded as conflicts** (never silently dropped).

Run:
```bash
node experiments/future-arch/run.cjs
```
Result: **24/24 pass.** A→B, B→A, multi-change convergence, offline-then-reconnect
catch-up, duplicate delivery (idempotent), out-of-order arrival, app restart,
torn/partial file skipped, and a true concurrent conflict that **converges on both
nodes to the same value AND records the same conflict pair on both**.

## 2. Shared-folder propagation instrument — `propagation.cjs`

Provider-agnostic. Knows nothing about OneDrive/Dropbox/Drive/Syncthing/NAS — you
point it at a folder some provider keeps in sync and run one role per computer.

Detection is by **directory polling** (default 50ms), because `fs.watch`/FSEvents
is unreliable on synced/network filesystems — the real app would have to poll too.
The poll interval is a known additive floor, reported in every result.

**Ping/pong** measures a **round trip on the initiator's single clock**, so the
number is immune to clock skew between machines (one-way ≈ RTT/2):
```bash
# on computer B (responder):
node experiments/future-arch/propagation.cjs pong  --dir "<shared folder>"
# on computer A (initiator):
node experiments/future-arch/propagation.cjs ping  --dir "<shared folder>" --n 50 --interval 500
```

Local baseline (one machine, plain temp dir — the **instrument floor**, not a cloud
number): `bash experiments/future-arch/run-baseline.sh` → one-way median ~14ms,
0 missed, 0 out-of-order, dominated by the 25ms poll.

### Two-machine protocol (the real test — needs a second computer)
1. On both machines, install the same synced folder provider and let it fully sync
   an empty folder, e.g. `.../OneDrive/shoresh-proparch/`.
2. Machine B: run the `pong` role pointed at that folder. Wait for "watching".
3. Machine A: run the `ping` role pointed at the *same synced path* on A.
4. Read A's summary: median/p95/worst RTT, one-way estimate, **MISSED**, duplicates.
5. Repeat with `--interval 100` (rapid changes) and `--n 200`.
6. Offline test: disconnect B's network mid-run, reconnect after 60s, confirm the
   backlog of pongs eventually arrives (measures store-and-forward, not liveness).

Interpretation the owner asked for:
- one-way median **≤ ~500ms** → could feel *live-ish*
- **≤ ~3s** → good for *near-live*
- **> 3s, or any MISSED** → treat as **asynchronous** transport only; live
  collaboration then needs a separate direct transport (WebSocket/relay).

### Provider compatibility (measured here, one machine)
Against the real `~/Library/CloudStorage/OneDrive-Personal` folder, the tmp-then-
rename discipline worked cleanly: 5/5 files written, renamed, read back; **0
leftover `.tmp` files**. So OneDrive at least tolerates the atomic-write pattern.
Whether it *syncs* `.tmp` files to peers (wasting bandwidth) or reorders renames
across machines is part of the two-machine test above.

### Field test — measured, two machines (2026-08-17)
Setup: a Mac + a Windows PC, **same** OneDrive-JCCNV (work/org) account, folder under
`Desktop` (Known-Folder backup), both on the same WiFi.
- **Correctness: pass.** All 30 pings crossed Mac → PC through the folder alone,
  received **in order, 0 out-of-order, 0 lost** (`answered=30`).
- **Latency: asynchronous / bursty.** Round trips did not complete within ~120s;
  delivery arrived in a burst; new files had not propagated minutes later **even
  though both OneDrive clients reported "backed up and synced."** The provider's own
  "synced" status is NOT real-time-trustworthy.
- **Same-WiFi gave no speedup** because OneDrive always detours through the cloud
  (A → Microsoft → B). Same-LAN live is WebSocket's job, not a cloud folder's.
- **The provider LIED about delivery.** OneDrive reported "backed up and synced" on
  the Mac while the files had NOT actually reached the cloud. Consequence for design:
  a shared folder and its sync-status indicator can NEVER be Shoresh's proof that an
  operation was delivered. Delivery confirmation must be an **app-level acknowledgment
  written back by the receiving Shoresh** (a "seen through op X" marker in the folder),
  mirroring the WebSocket path's existing `op_applied_ack` watermark. Convergence is
  still guaranteed by the append-only design; the ack is what lets the UI say an honest
  "shared ✓" instead of trusting the provider. Losing a durable op is unacceptable, so
  this is a hard requirement, not a nicety.
- **Conclusion:** commodity cloud folders (OneDrive class) are a reliable, order-
  preserving *asynchronous* transport, and NOT a live one. Live stays on WebSocket.
  (Untested: Syncthing/NAS, which transfer directly over the LAN and may be far
  faster on the same network.)

### Field test 2 — the `.shoresh` package + direct connection (2026-08-19)
- **Reconstruction proven (local):** `run-project.cjs` — two independent SQLite engines
  converge through an immutable `.shoresh` package; delete one engine entirely and rebuild
  from the package alone → **byte-identical state hash**. 19/19. (`project.cjs`,
  `project-cli.cjs` for a by-hand two-machine run; `PROJECT_PACKAGE_SPEC.md` for the format.)
- **Direct device-to-device is blocked on a managed network:** two machines on the SAME
  subnet (`.157`/`.159`) got **100% ICMP packet loss** and TCP `ETIMEDOUT` — the org/JCC
  Wi-Fi and/or locked-down work firewall forbid device-to-device traffic, and the user
  **cannot change it** (`direct-pingpong.cjs`, pure-Node TCP; localhost baseline ~1 ms).
- **The decisive product constraint (owner):** *"I can't change it on the work computer,
  and I shouldn't have to."* Correct, and founding. Any live path that needs the user to
  touch a firewall/network is disqualified.
- **What survives:** only *outbound* connections work on such networks. So the primary live
  path is **both peers dialing OUTWARD to a relay** (a data-less switchboard). Direct LAN is
  a silent optimization when the network allows it; the folder is the async backstop. This
  is why Google Docs / Figma / Slack / Zoom / Syncthing-fallback all use a relay. The ADR
  and RECOMMENDED_ARCHITECTURE were updated to make the relay the PRIMARY live path.

### Field test 3 — Syncthing across networks, on the locked-down machine (2026-08-19)
The capstone. Same two machines, **different WiFis**, connection type **Relay**, work laptop
firewall blocking inbound (no admin). Syncthing set up via its GUI, measured with `propagation.cjs`
(see `SYNCTHING_SPIKE.md` for the full run + the embed model in `syncthing-spike.cjs`):
- **Default Syncthing:** ~12 s one-way, 0 missed (async, but reliable/in-order).
- **Tuned (`fsWatcherDelayS=1`):** **~47 ms one-way, 0 missed — feels LIVE.** The whole
  difference was one setting (the watcher batch delay).
- **Head-to-head, identical scenario:** OneDrive 20/20 MISSED; direct TCP 100% packet loss;
  **Syncthing (tuned) live.**
- **Conclusion:** real-time-across-networks IS achievable with **no cloud Shoresh runs**, on
  managed/locked-down machines (all outbound via relay), with **no separate app** (embed
  Syncthing, invisibly, and tune it). This validated the "wire Syncthing into Shoresh" path.
  Caveat: 47ms was this relay at this moment; relay latency varies — production would likely
  self-host relays for consistency. Remaining work is the embedding itself (bundle binary,
  drive via REST API, auto-pair through Shoresh identity, set watcher delay).

## Key takeaway
The **operation algebra** is transport-neutral and already lives in `electron/ops/`.
The convergence math for a Host-less, folder-based world is small and testable —
this harness is ~250 lines. What is NOT free is everything the folder can't do:
liveness, presence, and a schema-version handshake. See the architecture report.
