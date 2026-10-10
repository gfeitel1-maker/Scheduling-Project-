---
ticket: T362
document_type: ticket
title: LAN-reserved pending slots - cap public sources at 64 of 256 pre-Noise pending connections so an internet scan can never block same-LAN sync
status: in-review
created: 2026-10-09
archive_when: "merged to main and the LAN-always-has-slots property is pinned by scannerPendingSlots.test.js"
task_class: security-auth
parent: T359
governing_docs: [docs/adr/2026-10-09-router-port-mapping-on-rung-1.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T359-router-port-mapping-rung-1.md]
---

# T362 - LAN-reserved pending slots

Success predicate: while 64 distinct public sources hold pending connections, a LAN dial to the same node still succeeds. Principle (keeper ruling): LAN is the base; an internet scan must never block same-LAN sync.

Non-goals: changing MAX_PENDING_PER_SOURCE (2), the 5s upgrade timeout, or the T340 un-admitted cap.

## Defect

T359 slice 5's real-libp2p test showed that 64 public sources fill libp2p's global `maxIncomingPendingConnections` (64), and while full a LAN dial is refused too, because libp2p's cap sits in front of the limiter's private-source exemption.

## Change

- `MAX_INCOMING_PENDING_CONNECTIONS` 64 -> 256 (`transport.js`).
- `connectionRateLimiter.js`: new `MAX_PUBLIC_PENDING_TOTAL = 64`; `allow()` denies a public source when the live public pending total is already 64. It reuses the existing `pendingByIp` accounting, so release on upgrade and on TTL expiry is the same code path. LAN, loopback and unknown sources are exempt as before, so at least 192 slots are never reachable by public sources.

## Interaction with other limits

- `maxConnections` (200) counts established connections, not pending ones, so 256 pending cannot push past it; a pending connection becomes one only after Noise.
- T340 un-admitted cap = `maxConnections - reservedFloor` = 168 applies after upgrade and is unchanged. The public pending sub-cap (64) is below it, so a scan cannot reach it through the pending path.
- Worst case simultaneous sockets: 256 pending + 200 established = 456, but the 192 non-public pending slots are reachable only from a private network.

## Headroom

Method: a Node 22 script opened 256 loopback TCP connections in one process and counted `/dev/fd` entries and RSS before and after. Result: 508 fds for 256 connections (2 per connection because both ends were in-process, so 1 per server-side socket) and about 4.3 MB RSS for both ends (about 8 KB per socket). libp2p adds per-connection upgrade state (multistream and Noise buffers); not measured here, estimated at under 100 KB each, so 256 pending is under about 30 MB and public-reachable worst case (64) under about 8 MB, against an Electron main process in the hundreds of MB.

File descriptors: shell `ulimit -n` on this machine is 1048576, but `launchctl limit maxfiles` reports a soft limit of 256 for macOS GUI-launched processes. Worst case 456 sockets plus db and app files would exceed 256 if the packaged app really ran at that soft limit. I believe Chromium raises RLIMIT_NOFILE at startup but did not verify it (no packaged-app run allowed under the light-work rule). Windows sockets are not bound by a small fd table (default limit is in the thousands). Realistic load: a LAN camp of a few dozen devices and a public scan capped at 64 pending, about 100 to 250 sockets. 256 is safe on Windows and on macOS if Electron lifts the soft limit; recommended follow-up (not heavy, not blocking): log `process.getrlimit`-equivalent (`ulimit -n` in the packaged app) once at sync start. If it is 256, lower the public sub-cap to 32 and the global cap to 128.

## Evidence

Tests in `electron/sync/automerge/scannerPendingSlots.test.js` (real libp2p) and the limiter unit test in the same file:
1. 64 distinct public sources fill the sub-cap; a LAN dial succeeds. Red with the global cap back at 64 (LAN dial refused).
2. A 65th public source is refused while full. Red with the sub-cap removed.
3. Per-source cap of 2 still holds (existing test).
4. Slots are released after the 5s timeout (real and deterministic-clock tests).
