---
title: "Documentation staleness audit and high-priority refresh"
document_type: ticket
status: completed
task_class: documentation-governance
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
resolved_by: docs/work/2026-09-28-documentation-staleness-inventory.md
archive_when: "The single inventory (docs/work/2026-09-28-documentation-staleness-inventory.md) covers the ENTIRE live doc corpus (every tracked *.md outside docs/archive/** and legacy/**, each finding citing doc line + contradicting code/current truth) AND every confirmed refresh across ALL agent-read and descriptive tiers has landed on main; the two parked ARCHITECTURE_STANDARD items (O1/O2) are resolved per the 2026-09-28 owner ruling with O1 confirmed by the security agent"
---

# T294 — Documentation staleness audit and high-priority refresh

## Why

The owner is concerned that documentation across the repo has drifted from reality and that agents
are making decisions off stale docs. Recent WAN/sync work shipped a lot (join-secret hardening,
v2 encrypted rendezvous record, the WAN-connectivity hardening-ladder ADR) — `PLATFORM_STATE.md`
and related descriptive docs likely lag it.

## Success predicate

1. A documented, **prioritized** inventory of stale/contradictory docs exists, each finding citing
   the doc line **and** the contradicting code or current truth.
2. The high-priority refreshes (agent-read priority tier) have actually landed on `main`.

Priority order = docs agents actually read to act:
`CLAUDE.md` → `docs/current/**` (esp. `PLATFORM_STATE.md`, `WHERE_DATA_LIVES.md`) →
`docs/governance/**` → `SECURITY.md` → ADRs and READMEs.

## Non-goals / ground rules (from CLAUDE.md, MUST honor)

- **Descriptive docs describe what IS** (CLAUDE.md, docs/current/**): where a doc disagrees with
  code, the CODE is right and the doc is stale — refresh the doc.
- **A standard is NOT overridden by code.** A standard/code contradiction is a **gap to report**,
  not license to amend either. Surface it for an owner decision.
- **`docs/archive/**` and `legacy/**` are historical** and must stay historical — do NOT rewrite
  history in ADRs/archive.
- When a sentence names something in order to say it is **GONE**, mark it historical
  (`_Prior:` / strikethrough / `doc-refs:historical`) rather than deleting.

## Method

Governor owns per the owner's engineering-workflow defaults: fan out parallel subagents across
non-overlapping doc domains (descriptive/current, governance/standards, security, ADR/README),
audit concurrently, converge on a single prioritized inventory, then land high-priority refreshes
in small reviewable PRs, each merged on green.

## Gates

`npm run index:work` · `npm run check:governance` (doc-refs + status-drift) · PR + merge on green
(CI is the gate of record).

## REOPENED 2026-09-28 (owner directive)

The priority-tier pass (below) was necessary but not sufficient. Owner directed a COMPREHENSIVE
whole-corpus audit + refresh, and RULED on the two parked items (resolve, do not re-park):
O1 = stale terminology (refresh to libp2p/Automerge connection-boundary model, cite the `users`
auth-field ADR for the tracked residual, route past the security agent); O2 = stale description
(op-log is a device-local history ledger). Amending a standard is human-gated; the owner directive
is the authorization. `archive_when` widened accordingly. Phase-1 outcome retained for the record.

## Phase 1 outcome (2026-09-28, PR #586) — agent-read tier

Priority-tier predicate discharged:

1. **Prioritized, code-confirmed inventory exists** — `docs/work/2026-09-28-documentation-staleness-inventory.md`, produced by four parallel auditors across disjoint domains.
2. **Agent-read-tier refreshes landed on `main`** (PR #586, CI `verify` green):
   - `docs/current/PLATFORM_STATE.md` — join secret implemented (T286), not "proposed"; 40-bit non-rotating code marked `_Prior:`; v2 encrypted rendezvous record (T287) noted.
   - `SECURITY.md` — camp token bound to device libp2p PeerId on a TOFU basis (T162, `device_identity_key` v67); join-code blocker addressed.
   - `docs/governance/standards/TESTING_STANDARD.md` — gate list corrected to the eight `VERIFY_STEPS` (`licenses:check` was missing).
   - `docs/governance/standards/ARCHITECTURE_STANDARD.md` — Host runs the libp2p sync server, not a WebSocket server.

## Phase 2 outcome — comprehensive whole-corpus pass (2026-09-28)

Seven auditors swept the entire live doc corpus (707 tracked `*.md` outside the historical
`docs/archive/**` and `legacy/**` trees), split into disjoint domains; every contradiction
code-confirmed. Canonical inventory
(`docs/work/2026-09-28-documentation-staleness-inventory.md`) now covers the full corpus. Refreshes
landed on `main` in five domain PRs, each CI-green, each independently reviewed:

- **#590 (PR-A)** — descriptive-current: `CLAUDE.md` (DnD distance 8→5); `PLATFORM_STATE.md`
  (schema v58/v77→v78, migration enumeration v72–v78); `WHERE_DATA_LIVES.md` (counts 51→63 tables /
  36 synced / 26 SQLite-only / 33 camp entities — all deterministically verified); `KEY_RECOVERY_STORY.md`
  (device-identity-key T162 shipped v67; at-rest encryption implemented, gated off).
- **#591 (PR-B)** — `SECURITY.md` (eight not seven participant entities; syncStarter.js attribution;
  removed non-existent `renew_token`; peerIdentity.js location; pairing_pending reword) and
  `CRDT_SECURITY_GAPS.md` #3/#4 shipped-since updates.
- **#592 (PR-C)** — **O1/O2 owner-ruled amendments** (below) + DESIGN_STANDARD/WORK_RECORD_STANDARD
  type-a fixes + 3 references (slate not purple; inline editor not edit modal).
- **#593 (PR-D)** — agent bindings governor/maker/architecture-auditor/architect/designer refreshed
  for the Stage-6 sync model + DnD distance; profiles regenerated (round-trip intact).
- **#594 (PR-E)** — 5 ADR `implementation_state` corrections; `scripts/consolidation/README.md`
  (T171 completed); (maker DnD moved to PR-D).

**O1 and O2 resolved per the 2026-09-28 owner ruling** (not re-parked): O1 (ARCHITECTURE_STANDARD §4,
no WebSocket-handler auth tier — Automerge merges authorized at the connection boundary; credential
fields the one per-merge check, citing the `users` auth-field ADR + `CRDT_SECURITY_GAPS.md` for the
accepted residual) — **confirmed by the security agent** to drop no real invariant. O2 (ARCHITECTURE_STANDARD
§2, op-log is a device-local history ledger, not cross-device replay).

## Still open — escalated to owner (NOT resolved unilaterally)

- **DESIGN_STANDARD §3/§9 activity palette** — a doc/standard/code three-way conflict. The standard
  asserts a six-**distinct-hue** `ACTIVITY_COLORS` palette "live" with a hue-identity rationale; the
  code (`src/components/schedule/slotCellConstants.js:62`) ships an all-navy **monochrome lightness
  ladder** (`['#121E2B'…'#667F99']`). Per standard-not-overridden-by-code this is the owner's call:
  refresh §3/§9 to the shipped ladder, or treat the code as unauthorized drift. Left unedited.
- **`docs/adr/2026-09-17-wan-rendezvous-seam.md` status** — `proposed`, while the later accepted WAN
  ladder ADR characterizes it as accepted (D3 stands). Low-confidence historical-ADR status flip;
  left as-is pending owner confirmation of whether the whole seam decision is accepted or only D3.

Lower-tier follow-up (not blocking): README P2 WAN note when the Tier-4 gate flips; the pre-existing
duplicated `schema_migrations` bullet in `PLATFORM_STATE.md`; ADR `implementation_state` vocabulary
normalization (hyphen/underscore, `implemented`/`shipped`/`complete`) — a safeguards-phase job.

---

**2026-09-30 disposition note, corrected (sweeps PR B round 2, board q-small-sweeps-batch):** round 1's
version of this note rested on the premise "`INTERNET_TRANSPORT_SIGNOFF` is still false". Red Hat
flagged that premise as stale and it was independently re-confirmed here, against
`electron/sync/automerge/transportCapabilities.js` itself (not taken on trust). The coarse boolean is
no longer the live gate — `electron/sync/automerge/transportBoundary.guard.test.js:11` records that
T288 replaced it with a per-capability registry, `TRANSPORT_CAPABILITIES`. Of its nine capabilities,
**`discovery` has a `signoff`** — `{date: '2026-09-28', owner: 'gfeitel1', doc:
'docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md#owner-sign-off'}` — with an
`egressAllowlist` of exactly `['electron/sync/automerge/rendezvousClient.js']`; the other six
(`relay`, `dcutr`, `webrtc`, `websockets`, `webtransport`, `quic`, `kadDht`, `bootstrap`, `upnp` — all
but `discovery`) still carry `signoff: null` and stay blocked. The conclusion is unchanged: the
README P2 WAN note is still not actionable. `README.md` carries no WAN/rendezvous text to correct
(`grep -in 'wan\|rendezvous\|internet' README.md` matches only the unrelated hosting caveat at line
48 and a Wi-Fi settings path at line 108), and its line 48 claim — "this system is not designed for
public internet hosting" — remains substantively true because the one signed-off capability,
discovery, is opt-in at runtime via `SHORESH_RENDEZVOUS_URL` and unset by default, not a standing WAN
posture. Whoever picks this item up next should look for the per-capability registry's state, not a
boolean that no longer exists. Nothing else in this ticket changed.
