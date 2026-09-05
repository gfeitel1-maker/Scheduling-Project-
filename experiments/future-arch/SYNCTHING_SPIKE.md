# Spike: embedding Syncthing as Shoresh's invisible sync engine

**Conceptual, isolated, experiment-only. Not wired into the app.** The owner wants
Syncthing *wired into Shoresh* — not a separate app a camp director installs and pairs by
hand. This spike proves the model: **Shoresh launches and fully controls a hidden Syncthing
process programmatically, and the user never sees it.** It also lets us measure Syncthing's
real across-network speed on the two machines that just failed a direct connection.

## What the spike must prove (the two real unknowns)

1. **Invisible control.** Shoresh can start Syncthing as a child process with its own config,
   drive it entirely through Syncthing's local REST API (create the shared folder, add the
   other device, read sync status), and shut it down — with **no Syncthing window, tray icon,
   browser UI, or manual pairing** ever shown to a user. If a script can do this, the Electron
   main process can do the same.
2. **Across-network speed.** Does Syncthing deliver changes between two computers on *different
   WiFis* (via its relay, since direct just timed out), and **how fast** — is it the "few
   seconds" that feels live enough for turn-taking, or slower?

## How this maps to real embedding (what the spike stands in for)

| Spike (this experiment) | Real Shoresh embedding |
|---|---|
| You download the Syncthing binary, pass `--bin` | The binary is **bundled** in the app's resources, per platform |
| A `.cjs` script spawns + controls it | Electron **main process** spawns + controls it (same REST API) |
| You copy device IDs between machines once | Shoresh **exchanges device IDs through its own member-onboarding/identity flow** — invisible |
| The shared folder is a temp dir | The shared folder is Shoresh's **`.shoresh` package journal** dir |
| You read status in the terminal | Shoresh surfaces "synced ✓ / syncing…" in **its own UI** |

Everything the spike does over the REST API is exactly what the app would do — the API is the
integration surface, so proving it here proves the embed is viable.

## Steps (two machines on different WiFis)

**Prereq:** get the Syncthing binary on each machine (download from syncthing.net/downloads —
it's a single self-contained executable; or `brew install syncthing` on Mac gives one on PATH).
No install of the *app*, just the binary — which is exactly what "bundled inside Shoresh" means.

1. **Machine A** — start a Shoresh-controlled Syncthing and print A's device id:
   ```bash
   node syncthing-spike.cjs run --bin <path-to-syncthing> --home ./st-a --folder ./shoresh-sync-a
   ```
   It prints `MY DEVICE ID: XXXX-....`. Leave it running. Copy that id.
2. **Machine B** — same, giving A's id as the peer:
   ```bash
   node syncthing-spike.cjs run --bin <path> --home ./st-b --folder ./shoresh-sync-b --peer <A's device id>
   ```
   It prints B's device id. Copy it.
3. **Back on Machine A**, stop (Ctrl-C) and relaunch adding B as the peer (mutual pairing —
   in the real app Shoresh automates this exchange; here we do it by hand once):
   ```bash
   node syncthing-spike.cjs run --bin <path> --home ./st-a --folder ./shoresh-sync-a --peer <B's device id>
   ```
4. Both sides now print a periodic status line: whether the peer is **connected** (and via
   **relay** vs direct) and the **folder completion %**. Wait for "connected".

## Measure the speed (reuse the instrument you already have)

Point `propagation.cjs` at each machine's Syncthing folder (`shoresh-sync-a` / `shoresh-sync-b`):
```bash
# Machine B:
node propagation.cjs pong --dir ./shoresh-sync-b --poll 250
# Machine A:
node propagation.cjs ping --dir ./shoresh-sync-a --n 15 --interval 2000 --poll 250 --tail 60000
```
This is directly comparable to the OneDrive run (which gave 20/20 MISSED). Read Machine A's
one-way median and MISSED count. Interpretation for "feels live":
- **≤ ~1–3 s, 0 missed:** near-real-time — very likely feels live for turn-taking. Syncthing is the transport.
- **> ~5 s or misses:** slower than hoped; reconsider a native realtime relay for the live case.

## RESULTS — run 2026-08-19 (Mac + locked-down Windows work laptop, different WiFis)

Measured with the standard Syncthing app (GUI), paired across two **different networks**,
connection type **Relay**, on a work computer whose firewall blocks inbound (no admin).

| Config | One-way median | Missed | Verdict |
|---|---|---|---|
| Default Syncthing (`fsWatcherDelayS=10`) | **~12,000 ms** (12 s) | 0 / 15 | async — but reliable & in order |
| Tuned (`fsWatcherDelayS=1`) | **~47 ms** | 0 / 15 | **feels LIVE** |

**The entire 12s → 47ms difference was one setting** — the filesystem-watcher batch delay.
Default Syncthing batches 10s (tuned for backup); set to 1s it's a live channel. An embedded
Shoresh would set this automatically (the driver in `syncthing-spike.cjs` already does).

Head-to-head, same scenario (two different networks, firewalled work machine):
- **OneDrive:** 20/20 MISSED, timeouts, unreadable placeholders. ❌
- **Direct TCP:** 100% packet loss (work firewall blocks inbound). ❌
- **Syncthing (tuned, via relay):** ~47ms one-way, 0 missed, in order. ✅ **live**

Both spike unknowns answered **yes**: invisible control is feasible (the GUI's REST API is the
same surface the app would drive), and the across-network speed is live when tuned. Caveat: 47ms
was this relay at this moment — relay latency varies with location/load, so it won't always be
this low; production would likely self-host relays for consistency. But it proved live IS
achievable across networks, on a locked-down machine, with no cloud Shoresh runs.

## Honest unknowns / caveats this spike will expose

- **Syncthing is file-sync, so expect *seconds*, not the 23 ms of a direct socket.** The spike
  measures whether "seconds" is fast enough for you. It will not be sub-second across networks.
- **The relay is still an internet intermediary** (Syncthing's free encrypted pool, or org
  self-host) — unavoidable across NAT, but not a cloud *you* run, and it can't read the data.
- **Some very locked-down networks block even Syncthing's relay/discovery ports.** If the peer
  never connects, that's the finding for that network (an org self-hosted relay on a known
  port/HTTPS may be needed).
- **Binary version differences:** Syncthing's CLI flags shifted across versions (`syncthing`
  vs `syncthing serve`). The driver tries the modern form; if start fails, see its comments.
- **This driver is written from Syncthing's documented REST API but has NOT been run against a
  live binary here** (no binary/second machine in this environment). Treat first run as part of
  the spike; adjust per any API/flag drift you hit and tell me.

## The decision this informs

If invisible control works **and** the across-network speed feels live enough, embedding
Syncthing is the concrete, principle-consistent path to real-time-ish across networks: no
separate app, no cloud Shoresh runs, encrypted, open source, self-hostable relay. If speed
disappoints, the transport seam (S1) lets us swap in a native WebSocket + realtime relay for
the live case without rewriting Shoresh — so either way this is a bounded, reversible probe.
