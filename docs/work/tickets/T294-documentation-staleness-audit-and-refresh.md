---
title: "Documentation staleness audit and high-priority refresh"
document_type: ticket
status: in-progress
task_class: documentation-governance
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
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

## Known limit at close — escalated to owner, NOT resolved

Two `docs/governance/standards/ARCHITECTURE_STANDARD.md` **substantive-rule** contradictions are doc/standard/code three-way conflicts. Per the standard-not-overridden-by-code rule they are the owner's call (`CONSTITUTION.md` Article IV), captured in the inventory as O1/O2 and deliberately left unedited here:

- **O1** — §4/§5 "mutating **WebSocket** handlers call `authorize()`": no WebSocket handlers exist; remote changes arrive as Automerge merges authorized at the connection boundary. (Its known HIGH residual is already tracked by the accepted `users` auth-field ADR.)
- **O2** — §2 op-log is "**replayable across devices**": op-log is now a device-local history ledger; replication is Automerge.

Lower-tier follow-up (not blocking): README P2 WAN note when the Tier-4 internet-transport gate flips. ADR layer audited clean.
