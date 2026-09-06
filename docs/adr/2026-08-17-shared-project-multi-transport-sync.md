---
title: "ADR: Shared-project model over a multi-transport, referee-less sync engine"
document_type: adr
status: superseded by docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
authority: normative
implementation_state: in_progress
date: 2026-08-17
decided: 2026-08-17
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: []
depends_on_external: []
related_discovery: [experiments/future-arch/ARCHITECTURE_REPORT.md, experiments/future-arch/RECOMMENDED_ARCHITECTURE.md, experiments/future-arch/IDENTITY_MODEL_SKETCH.md, experiments/future-arch/RELAY_OPERATIONS_SKETCH.md, experiments/future-arch/SYNCTHING_SPIKE.md, experiments/future-arch/PEER_DISCOVERY_RESEARCH.md, experiments/future-arch/NAT_TRAVERSAL_RESEARCH.md, experiments/future-arch/README.md, experiments/future-arch/run.cjs, experiments/future-arch/propagation.cjs]
program: shoresh-future-architecture
---

# ADR: Shared-project model over a multi-transport, referee-less sync engine

> **Superseded by `docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md` (2026-09-06).**
> The owner subsequently chose Automerge + libp2p over the Syncthing-based engine recommended
> below (see that ADR for the decision and rationale). Syncthing itself is not deleted from
> consideration — held, not killed, per the owner's optionality principle — but it is no longer
> the primary route. This document is left intact as the historical record of that evaluation.
>
> **Status (as originally accepted): ACCEPTED (product-owner, 2026-08-17). Implementation in progress at S1.**
> Accepted as the target architecture on the isolated `claude/shoresh-future-architecture-364e03`
> branch. Owner decisions D1 (integrity-only v1), D2 (person-with-devices identity), and D3
> (owner-resilience: nudge hard, don't hard-block) are locked. This branch is **not** merged to
> `main`; the eventual implementation may be rebased/rebuilt against a newer Shoresh later. The
> staged path (S0–S5) is the build plan; S1 (transport seam) is underway.

## Context

Shoresh is a local-first Electron + SQLite app. Today, multiple computers collaborate over a LAN
using a **Host/Client** model: one computer runs a WebSocket server (the Host) that assigns the
authoritative order to changes, adjudicates conflicts, and mints security tokens; other computers
(Clients) sync to it. Every meaningful change is already a small, field-level **operation**
(`electron/ops/`), uniquely identified, idempotent on retry (`client_write_id`), with genuine
conflicts recorded (not dropped) in a `conflicts` table.

The owner wants the longer-term mental model to be **"a camp project behaves like a shared
collaborative document"** (the Teams + Word/Excel analogy): many authorized people work on one
project — **Camp Achva — Summer 2027** — through Shoresh's screens (setup, schedule, map, staff);
changes propagate when peers are reachable; it works offline; and it must **not** depend on an
always-available internet connection. An explicit design principle: do **not** assume the answer is
"build a cloud backend." A hypothesis to test was that a plain **shared folder** (OneDrive/Dropbox/
Drive/Syncthing/NAS) could be the transport, with Shoresh knowing only a filesystem path and no
provider-specific code.

We investigated the real code and ran two disposable experiments (see `related_discovery`).

### What the investigation established (evidence, not opinion)

1. **The operation engine is already ~80% of a shared-document engine** and is **transport-neutral**
   — `electron/ops/*` takes plain operation objects and a database, and touches no socket. Idempotency,
   conflict recording, and delivery acknowledgment (`op_applied_ack` watermark on the WebSocket path)
   already exist.
2. **A referee-less model converges.** A ~250-line prototype (`run.cjs`) replaced the Host's
   authoritative ordering with a **logical clock + deterministic last-writer-wins**, surfacing genuine
   concurrent edits as recorded conflicts. It passed **24/24** scenarios: A→B, B→A, multi-change
   convergence, offline→reconnect catch-up, duplicate delivery, out-of-order arrival, restart,
   partial/torn-file skip, and a true concurrent conflict (both nodes converge to the same value AND
   record the same conflict).
3. **A shared folder is a reliable *asynchronous* transport, not a live one.** Measured on two real
   machines over OneDrive: operations crossed with zero loss and in order — but delivery was slow and
   bursty, a background download stalled it, and the provider's own "synced ✓" indicator was **wrong**
   (claimed done while files had not uploaded). Root cause is structural: a folder cannot *push*; each
   peer polls a sync-client queue it does not own or observe.
4. **No one's live collaboration is built on passive folder sync — Microsoft's included.** Word's
   real-time co-authoring runs over a **live server connection**, separate from the OneDrive folder.
   The folder is only the durable copy at rest. Live requires a channel the app controls.
5. **Provider-agnosticism is correct and cheap.** With an append-only, immutable, **uniquely-named**
   one-file-per-operation journal (write-temp-then-rename), no provider ever faces a filename collision
   or a deletion to propagate, so provider quirks stop mattering. Shoresh needs **zero** provider code.
6. **A rebuild-from-package proof holds.** A second prototype (`run-project.cjs`, `project.cjs`, spec in
   `PROJECT_PACKAGE_SPEC.md`) modelled the project as a portable `.shoresh` package (project.json + an
   immutable journal), with SQLite outside it as disposable engine. **19/19**, including: two independent
   engines converge, and **a SQLite deleted entirely rebuilds from the package alone to a byte-identical
   state hash** — reconstruction is deterministic. This closes the ADR's original reconstructability unknown.
7. **Direct device-to-device connection cannot be a requirement on managed networks (2026-08-19 field
   test).** Two machines on the *same subnet* (`.157`/`.159`) could not even ICMP-ping each other: 100%
   packet loss. On a managed/org (JCC) network this is normal — Wi-Fi client isolation and/or a locked-down
   work-computer firewall block unsolicited *inbound* and device-to-device traffic, and **the user can
   neither change it nor should be asked to** (the founding constraint: a director needs no networking
   knowledge). What such networks *do* allow, universally, is *outbound* connections (browser, OneDrive,
   email all rely on it). Therefore the only live path that works with **zero user configuration** is one
   where **both machines dial *outward* to a shared relay** — which is exactly why Google Docs, Figma,
   Slack, Zoom, and Syncthing's fallback all work that way. Direct LAN can only ever be a silent
   optimization, never a requirement.
8. **Embedded, tuned Syncthing delivers live sync across networks — proven (2026-08-19).** On the
   *same* two machines (different WiFis, work laptop firewall blocking inbound, no admin) where
   OneDrive lost 20/20 pings and direct TCP got 100% packet loss, Syncthing connected via its
   **relay** (both dialing outward) and, with the filesystem-watcher delay tuned from its 10s
   default to 1s, delivered changes at **~47 ms one-way, 0 missed, in order — live**. Untuned it was
   ~12 s (still reliable). This validates: (a) the relay-primary transport strategy; (b) that a
   mature open-source engine (Syncthing) supplies the whole direct-LAN + NAT-traversal + encrypted-
   relay stack, so Shoresh need not build it; (c) that it can be **embedded and driven invisibly**
   (its REST API is the integration surface). See `experiments/future-arch/SYNCTHING_SPIKE.md`.
9. **Discovery + NAT-traversal research refines the transport ordering to direct-first (2026-08-19).**
   Two cited research reports (`PEER_DISCOVERY_RESEARCH.md`, `NAT_TRAVERSAL_RESEARCH.md`) establish:
   (a) *discovery ≠ connection* — locating a peer and reaching it are separate layers, and the relay
   question lives in the connection layer; (b) LAN discovery is free/serverless (Shoresh's mDNS already
   does it); cross-network discovery needs one tiny self-hostable *lookup* server, which is NOT a relay;
   (c) direct connection works for the **majority** across networks via hole-punching (Tailscale ~90%
   direct, libp2p 70%±7% measured, WebRTC ~15–20% relay), so **direct is primary, not the relay** — the
   earlier "relay primary" framing over-generalized from evidence #8's single worst-case machine;
   (d) an un-punchable **minority** (symmetric NAT, CGNAT, locked-down firewalls — incl. the owner's work
   laptop) genuinely needs a relay fallback, so "no relay at all" costs those peers live cross-network
   sync (async-only); (e) prior LAN pairing permanently removes *identity* from the cross-network path
   but not *reachability* — a rendezvous is still needed in the moment. Net: direct-first with a
   matchmaker-first relay fallback; the actual direct-vs-relay split for specific staff can only be
   *measured*, not predicted.

## Decision

Adopt, as the target architecture, a **shared-project model backed by a referee-less, multi-transport
operation-sync engine**, with **local SQLite as the permanent source of truth on every device**.

1. **The project is the durable thing, not any one database.** A camp project has identity/metadata, a
   schema version, a periodic checkpoint, and a journal of operations. Each device holds a full local
   SQLite working copy, reconstructable from checkpoint + journal.

2. **Operations flow through a transport seam.** One narrow interface (send-operations /
   receive-operations / acknowledge) that the rest of the app is blind to. Shoresh selects the best
   available transport automatically, and — critically — **never requires the user to configure a
   network, firewall, or port** (founding constraint + the 2026-08-19 field test, evidence #7).
   The order below is **direct-first, relay-as-fallback** (refined by the discovery + NAT-traversal
   research, evidence #9 — this supersedes an earlier "relay is the primary live path" framing that
   over-generalized from testing with a single worst-case machine):
   - **DIRECT connection is the PRIMARY live path — and it works across networks, not just on a LAN.**
     Two peers that know each other (paired once, ideally on a LAN — trust is then permanent) connect
     directly: instantly on a shared LAN (~23ms, field-measured), and across different networks via
     NAT hole-punching, which succeeds for the **majority** of real networks (Tailscale ~90% direct;
     libp2p 70%±7% measured; WebRTC only ~15–20% need a relay). Direct is sub-second and needs no data
     middleman. This is the path most peer pairs use most of the time.
   - **A tiny rendezvous/signaling point is structurally required for the cross-network case** — to
     let peers learn each other's *current* address and coordinate the hole-punch. This is a **lookup +
     matchmaker**, NOT a data relay: for a successful punch it exchanges a handshake and steps out of the
     path ("matchmaker, not middleman" — Tailscale DERP, libp2p DCUtR). Cross-network discovery cannot be
     fully serverless (two NAT'd peers with no shared broadcast domain can't find each other alone), but
     this piece is minimal and self-hostable.
   - **The RELAY is a FALLBACK for the un-punchable minority, not the primary path.** A real, stubborn
     minority of networks genuinely cannot be traversed — symmetric NAT, CGNAT (>17% of home, >90% of
     cellular/hotspot), and locked-down enterprise firewalls (the owner's work laptop is in this minority;
     it relayed even on a hotspot). For those peers only, the matchmaker becomes a full data-relay. It
     holds no camp data (sealed/encrypted envelopes), is not an authority, and is Syncthing's free pool or
     an org self-host. **Whether to run a relay at all is an open product decision** (see Risks): live for
     everyone (keep the fallback relay) vs. live-for-the-majority + async-for-the-minority (drop it).
   - **Recommended concrete implementation for all of the above: embed Syncthing** (evidence #8). It IS
     this exact stack — local + global discovery, NAT hole-punching, encrypted relay fallback — in one
     mature open-source engine, bundled and driven invisibly (no separate app, no cloud Shoresh runs).
     Field-proven at ~47ms via relay to the exact machine that couldn't be punched. Shoresh tunes it
     (watcher delay low) and orchestrates pairing through its member identity. The transport seam keeps it
     swappable (a native WebRTC/ICE or WebSocket+relay stack could replace it) without touching the rest.
   - **The shared folder is the ASYNC backstop.** Append-only, immutable, uniquely-named operation files
     for when no live path is reachable (a peer offline, or the relay dropped, or a relay-less design meets
     the un-punchable minority). Slow, bursty, lossless; zero infrastructure. Never the live path.

3. **Ordering is referee-less.** Devices agree via a logical clock + deterministic last-writer-wins;
   genuine concurrent edits are recorded as conflicts and resolved by a human (the existing model).
   This removes the requirement for a permanent Host.

4. **Delivery is confirmed by Shoresh, never by the transport.** Because a provider's "synced" status
   can lie, the receiving Shoresh emits its own "applied through change #X" acknowledgment (extending
   the existing `op_applied_ack` watermark to the folder transport as a marker file). The UI's
   "shared ✓" derives from that, not from the pipe. **Losing a durable operation is the one
   unacceptable outcome.**

5. **Shoresh contains no provider-specific code.** It speaks operations over a filesystem path or a
   socket; OneDrive/Dropbox/Drive/Syncthing/NAS remain entirely outside the app.

6. **A full cloud backend is explicitly deferred.** It has not earned its complexity against what this
   local-first, three-transport design delivers.

7. **Identity is a signed membership ledger rooted in owner keys — no Host notary** (see next section).

## Identity & permissions (Host-less)

Full sketch: `experiments/future-arch/IDENTITY_MODEL_SKETCH.md`. Summary of the decided design:

- **Two separate gates.** *Folder access* (who can see the raw bytes) is the camp's job via their
  sync provider, **outside Shoresh**. *Membership* (who can author valid changes, at what role) is
  Shoresh's job. Shoresh is not a file-access system.
- **Identity = a person, with multiple devices enrolled under them** *(decision D2)*. Each device
  holds its own Ed25519 keypair whose private half never leaves it; the PIN unlocks that key locally.
  A change is verified *device key → person → role*. Roles attach to the person.
- **Root of trust = owner keys + a signed genesis record** created when the camp is made. The project's
  true identity is the fingerprint of that signed genesis; a folder cannot forge it without the owner's
  private key.
- **Membership is a signed, replicated ledger** riding the normal operation stream: person-level
  entries (`ADD`/`REVOKE`/`PROMOTE`, owner-signed) and device-level entries (`ENROLL`/`REVOKE device`,
  signed by that person's existing device or an owner). Every laptop replays it to compute current
  members/roles/devices — offline, no server.
- **Every change is signed and verified on arrival**; changes from non-members or revoked keys are
  rejected. Authority travels with the change, which is what makes a dumb folder a safe transport.
- **Roles:** owner / editor / viewer. No permission matrix.
- **Secrecy deferred** *(decision D1)*: integrity + attribution now (signed, not encrypted); optional
  member-only encryption later if a camp needs it.
- **Owner resilience** *(decision D3)*: multiple-devices-per-person covers device loss; for a lone
  director Shoresh **nudges hard** to enroll a second owner-device / co-owner / recovery key but
  **does not hard-block** setup.

**Honest limits (carried, not solved):** `REVOKE` is forward-looking and not instant (fine for
"staffer left," not a live-insider defense); removing a member in Shoresh does **not** remove their
*folder* access — Shoresh must prompt the director to also close that; and losing the whole owner-person
(single owner, single device, gone) bricks administration though others keep working — hence the D3 nudge.

## Consequences

**Positive**
- Reuses the existing operation engine, conflict model, and LAN WebSocket server — evolution, not rebuild.
- Preserves local-first and offline: SQLite stays authoritative; every transport is optional; nothing is lost.
- Delivers the owner's experience (offline, async multi-site, LAN-live, near-live remote via relay) without
  vendor lock-in or a mandatory cloud database.
- Matches how real products actually achieve live collaboration (durable copy + app-owned live channel).

**Negative / costs**
- New pieces to build and test: the transport seam, the folder transport + its acks, referee-less ordering,
  a portable-project + rebuild-from-scratch path, a schema-version handshake, and (for live-remote) a relay.
- Operation-log growth is unbounded today; needs checkpoint-and-compact before multi-season use.
- Batching required for the folder transport (one file per burst, not per keystroke) — measured: OneDrive
  chokes on storms of tiny files.

## Alternatives considered

- **Plain shared folder as the *only* transport (the original hypothesis).** Rejected as the *live* path:
  cannot push, cannot be trusted for timing, provider status lies. **Kept** as the async backstop.
- **Full cloud backend (database in the cloud).** Rejected/deferred: violates the "must earn its complexity"
  principle and the no-mandatory-internet requirement; the three-transport design meets the need without it.
- **A shared SQLite database file in a synced folder.** Rejected outright: concurrent opens over Dropbox/SMB
  corrupt the file. Only the append-only journal + checkpoints may ever live in the folder.
- **Heavyweight CRDT framework (Automerge/Yjs) or cr-sqlite.** Not adopted now; field-level last-writer-wins
  with human conflict surfacing already meets the stated need. **`cr-sqlite` recommended for a head-to-head
  spike** before any custom convergence code is finalized, as it may remove a class of future bugs.

## Risks and open questions (must resolve before build)

- **Identity & permissions** — *addressed;* see the Identity & permissions section (person-level membership
  ledger, owner-rooted, D1–D3 decided). Residuals are the honest limits noted there (revocation lag,
  folder-vs-membership gap, lone-owner-person loss), all judged acceptable for a camp's threat model.
- **Rebuild-from-scratch** — *proven feasible* by the `.shoresh` package prototype (evidence #6: delete the
  SQLite, rebuild from the package alone, byte-identical hash). Not yet a routine *in the app*, and some
  current-app state (migration backfills, identity) still lives only in tables — folding those into the
  journal is the remaining build work.
- **Schema/version drift.** No handshake today; two app versions can exchange operations. Must gate sync.
- **Unbounded log growth / folder full of tiny files.** Needs checkpoint-and-compact and operation batching.
- **OPEN PRODUCT DECISION — does a relay exist at all? (owner deliberating, 2026-08-19.)** Refined by
  evidence #9: direct connection is primary and works for the majority; a relay is only a fallback for the
  un-punchable minority. The choice: **(a) live-for-everyone** — keep a matchmaker-first relay fallback (a
  small internet-reachable point; Syncthing's pool or org self-host; holds no camp data); or **(b)
  live-for-the-majority + async-for-the-minority** — drop the relay, letting un-punchable peers (incl. the
  owner's work laptop) sync only asynchronously via the folder. This is the crux decision the owner is
  thinking through; it determines whether any relay infrastructure exists. Note: even option (b) still
  needs the tiny cross-network *discovery/signaling* lookup (not a relay) for direct connections to form.
- **Live-latency over a folder: settled — it isn't live.** Field-tested: OneDrive is bursty, stalls, serves
  files unreliably (unhydrated placeholders), and misdelivered 20/20 tiny pings between two machines. The
  folder is async-only; live is the relay's job, not a provider's.

## Staged path if accepted (each stage reversible, each teaches something)

- **S0 — Measurement.** Two-machine propagation on OneDrive + Syncthing; decides whether "live over a folder"
  is ever on the table. *(Instrument built: `propagation.cjs`.)*
- **S1 — Transport seam.** Route operations through one interface; WebSocket becomes its first implementation.
  No behavior change.
- **S2 — Folder-journal transport (async).** Append-only files + checkpoints + acknowledgment markers.
- **S3 — Referee-less ordering.** Logical clock + last-writer-wins + conflicts into the existing resolve UI.
- **S3.5 — Identity & membership.** Per-device keypairs, person-level signed membership ledger rooted in
  owner keys, sign-and-verify on every change, three roles, the D3 owner-resilience nudge. Foundational for
  trusting the relay and folder transports (a change is only accepted if it's from a current member).
- **S4 — Portable project + rebuild + schema gate.** A project a fresh install can open and reconstruct;
  refuse mismatched schema versions.
- **S5 — Connection stack: direct-first, relay-as-fallback (refined by evidence #9).** Discovery
  (LAN mDNS — have it; cross-network tiny lookup) → direct hole-punched connection (primary, majority of
  networks) → relay fallback for the un-punchable minority (matchmaker-first). Embedding Syncthing supplies
  this whole stack. Whether the fallback relay is provisioned at all is the OPEN PRODUCT DECISION above
  (live-for-everyone vs. live-for-the-majority + async-for-the-minority) — S5's shape depends on it.

## Confidence

High that the operation engine is reusable, that referee-less convergence works (24/24), that a `.shoresh`
package can rebuild SQLite exactly (19/19), and that a relay both peers dial outward to is the only live path
that works with zero user configuration on the managed networks Shoresh runs on (field-proven 2026-08-19). The
relay is a small relocation of code Shoresh already runs (its LAN WebSocket server), moved to a reachable spot
and stripped to forwarding. Medium/open on compaction policy and on the operational question of who runs the
relay. The recommendation to defer a full cloud *database* backend remains high-confidence: a data-less relay
is not that — it holds no camp state and the local SQLite stays authoritative.
