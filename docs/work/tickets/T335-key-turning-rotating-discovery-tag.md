---
ticket: T335
document_type: ticket
title: Key-turning — rotating discovery tag derived from the signed T331 revocation set (DHT prerequisite)
status: completed
created: 2026-10-03
archive_when: "the discovery tag is a pure function of the signed T331 revocation set wired into mDNS discovery, an unsigned revoke entry cannot move the production tag (wired-layer test), and the LAN restart-bounded limitation is documented in SECURITY.md/PLATFORM_STATE with live rotation carried as a hard T334 acceptance criterion"
task_class: security-auth
parent: ""
governing_docs: [docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md]
related_prs: []
---

# T335 — Key-turning: rotating discovery tag (WAN DHT prerequisite)

## Context

Prerequisite for the WAN DHT slice (T334). The accepted WAN ladder ADR
(`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`) makes the owner's "key turning" —
automatic-on-revocation discovery-tag rotation — the thing that keeps the public DHT brute-force-safe
and cuts a removed device off from discovery. That rotation was never shipped: T329's unsigned
`camp_epoch` attempt failed security review and was frozen; T331/T332 built the *signed* revocation
witness (`camp_authority_log`) but not the discovery-namespace rotation (zero production callers).
Design: `docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md`.

## What it does

The discovery tag = `HMAC(campDhtSecret, hash(sorted(currentRevokedDeviceIds)))` — a pure function of
the signed, causal T331 revocation set (`currentRevokedDeviceIds` on `authorityReplay.js`, gated by
the same `createVerifiedEntryTrust` signature verification the projector uses). No rotation *event*,
no unsigned field — structurally avoiding the T329 F1/F2 failure class. A revoked device, cut off from
sync by T331's gates, has a frozen replay and cannot compute the new tag. Wired into mDNS discovery.
Opens NO Tier-4 capability (LAN/document-layer).

## Accepted limitation (organizer ruling 2026-10-03)

LAN/mDNS rotation is **restart-bounded**: a running device keeps its startup tag until process
restart (`@libp2p/mdns` captures `serviceTag` by value; no stable API to restart the instance). Bounded
by T331 auth (a revoked device is refused admission regardless of tag) — an obscurity/liveness gap on
LAN, not an auth hole, and NOT the cross-network cut-off. **Live rotation is a hard acceptance
criterion of T334** (the DHT slice). Documented in `SECURITY.md` Known limitations + `PLATFORM_STATE.md`.

## Acceptance

- Pure-function derivation + the wired-layer forgery test (an unsigned revoke does not move the
  production tag) + the determinism/frozen-device/signed-only-moves-it tests — all green.
- Finding-1 signature gate threaded through the production call site; Finding-2 restart-bounded limit
  documented in all three places; the T334 live-rotation requirement recorded.
- Full hard gate (Security + Red Hat on the revocation/discovery seam) + Grader PASS.
