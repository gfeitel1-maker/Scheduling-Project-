---
title: "T294 documentation staleness inventory"
document_type: discovery
status: active
created: 2026-09-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T294-documentation-staleness-audit-and-refresh.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
---

# T294 — Documentation staleness inventory

Prioritized, code-confirmed inventory of stale/contradictory documentation, produced 2026-09-28 by
four parallel auditors across disjoint doc domains (descriptive/current, governance/standards,
security, ADR/README). Each finding cites the doc claim **and** the contradicting code or current
truth. Priority tier follows the docs agents actually read to act:
`CLAUDE.md` → `docs/current/**` → `docs/governance/**` → `SECURITY.md` → ADRs/READMEs.

Root cause of most findings: the recent WAN/sync work (T286 ephemeral join-secret hardening,
T287 v2 encrypted rendezvous record) and, further back, the Stage-6 WebSocket→libp2p/Automerge
cutover, were not swept through the descriptive and standards layers.

**Status legend:** LANDED = refresh merged to `main`; OPEN = tracked follow-up; OWNER = escalated,
must not be resolved by an auditor/Governor (doc-vs-standard-vs-code three-way contradiction under
`CONSTITUTION.md` Article IV).

---

## P0 — agent-read tier, actively misleads a decision

| # | Doc claim | Contradicting truth | Fix | Status |
|---|---|---|---|---|
| A1 | `docs/current/PLATFORM_STATE.md` "Security posture" para: the ephemeral join secret is "designed in ADR ... **proposed, not yet implemented**" | `electron/sync/joinCode.js` — `mintJoinSecret` (random, never campId-derived), `CODE_CHARS=10`/`CODE_BYTES=7` = 50 bits, scrypt-tagged rendezvous (N=32768,r=8,p=1); shipped T286, PR #581 on `main` | State the join secret is implemented (T286): ephemeral, random, window-scoped, 50-bit, scrypt-tagged. WAN wiring (Slice C / T211) is the parked remainder | LANDED |

## P1 — agent-read tier, stale but not actively decision-breaking

| # | Doc claim | Contradicting truth | Fix | Status |
|---|---|---|---|---|
| A2 | `docs/current/PLATFORM_STATE.md` "Security posture" para: WAN blockers include "**40-bit non-rotating join code**" as an open must-fix | `electron/sync/joinCode.js:8-52` documents replacing the old `base32Crockford(sha256(campId)[:5])` (~40-bit, permanent) with a 50-bit random rotating ephemeral secret | Mark blocker #1 closed by T286; leave LAN-sized rate limits + unsigned builds as still-open WAN preconditions | LANDED |
| C1 | `SECURITY.md` "A camp token is a bearer credential (T155)" (lines ~476-491): "Nothing binds it to the libp2p peer id ... a valid token replayed from a different machine is admitted"; "cannot close this as it stands ... fresh peer id on every process start" | `electron/auth/connectionAuth.js:92-104` (`bindOrVerifyPeerIdentity`, TOFU, mismatch → 4405); `electron/sync/automerge/syncNode.js:473` wires it live with the Noise-proven `fromPeerId`; `electron/auth/deviceIdentity.js:33-45` + `device_identity_key` (schema v67) = the persistent per-device libp2p key. Shipped T162. Doc already documents the fix at its own lines 73-102 — it holds both accounts | Rewrite 476-491 to reflect T162 (token bound to stable PeerId on TOFU basis, mismatch → 4405); mark the old reasoning `_Prior:` | LANDED |
| B1 | `docs/governance/standards/TESTING_STANDARD.md:21-39` "It runs these **six** steps"; gate table lists 7 rows and omits `licenses:check` | `scripts/verify.js` `VERIFY_STEPS` has **8** steps: agents:check, check:governance, **licenses:check**, build, security, test:integration, lint, test. Standard declares itself the single owner of the gate list "derived from" verify | "six"→"eight"; insert `licenses:check` row after `check:governance`; renumber so table order matches `VERIFY_STEPS` exactly | LANDED |
| B2 | `docs/governance/standards/ARCHITECTURE_STANDARD.md:82` "One device is the Host: it runs the **WebSocket server** ..." | No WebSocket server exists (zero `WebSocketServer`/`ws://` non-test hits under `electron/`,`src/`); transport is libp2p/Noise (`electron/sync/automerge/`). Rest of sentence (Host holds Ed25519 key in `host_signing_key`, `ensureHostSigningKey` `electron/auth/localAuth.js:277-305`) is accurate | Replace "runs the WebSocket server" with the current libp2p sync server + Noise mutual-auth transport. Mechanism-name refresh only; the Host/Client asymmetry rule is intact | LANDED |

## P2 — lower priority / additive

| # | Doc claim | Contradicting truth | Fix | Status |
|---|---|---|---|---|
| A3 | `docs/current/PLATFORM_STATE.md`: T287 v2 encrypted rendezvous record undocumented (zero mentions of `rendezvousAddressKey`/`encryptedAddressBody`) | `electron/sync/automerge/rendezvousRecord.js:15-34,117-205` — VERSION=2, AES-256-GCM address body keyed via HKDF from `camps.rendezvousAddressKey`. Path still parked (not imported by production discovery), so no live behavior misdescribed | Add a current note that the rendezvous record is now v2 with an encrypted address body (still parked pending WAN wiring) | LANDED |
| C2 | `SECURITY.md:35` WAN blocker "a 40-bit non-rotating join code" | Same as A2 (`electron/sync/joinCode.js`) | Note blocker addressed by T286; cite the WAN ladder ADR | LANDED |
| D1 | `README.md:29,48` "no cloud backend ... not designed for public internet hosting" | Correct for *enabled* behavior; merged WAN scaffolding (v2 rendezvous, ADR) is held behind the Tier-4 `INTERNET_TRANSPORT_SIGNOFF` guard | No action now; add a WAN note if/when Slices C-F flip the Tier-4 gate | OPEN |

## OWNER DECISION — doc/standard/code three-way contradiction (NOT resolved here)

These are standards whose **substantive rule** no longer maps onto the code. Per `CLAUDE.md` /
`GOVERNANCE_INDEX.md` a standard is not overridden by code — refreshing the rule is an owner
decision under `CONSTITUTION.md` Article IV, not an editorial refresh.

| # | Standard rule | Code reality | The question for the owner |
|---|---|---|---|
| O1 | `ARCHITECTURE_STANDARD.md:57,78` — "Mutating IPC handlers **and mutating WebSocket handlers** call `authorize()`" | No WebSocket handlers exist. `authorize()` runs on IPC handlers; remote changes arrive as **Automerge merges**, authenticated at the *connection* boundary (`electron/sync/automerge/authGate.js`, `mutualAuth.js`, `electron/auth/connectionAuth.js`), not per-message | Is this a pure terminology refresh, or a real gap in the "every camp-data mutation is authorized" invariant under CRDT sync where an authenticated peer's merges are trusted at connection level? (Note: this invariant's known HIGH residual is already tracked by the accepted `users` auth-field ADR.) |
| O2 | `ARCHITECTURE_STANDARD.md:31-35 §2` — every write appended to `operations` is "what makes writes idempotent under retry **and replayable across devices**" | Op-log is no longer the replication mechanism (no `replayOps`/`opDelivery`/`broadcastOp`); replication is Automerge; `operations` is a device-local history ledger (Trash/Restore/history). Local half (append, idempotent via `client_write_id`, project) still true | Should §2 drop the "replayable across devices" clause, or should the "all mutations go through the op-log" invariant be restated for the CRDT model? |

---

## Domains audited clean

- **`README.md` + `docs/adr/**`** (Domain D): no P0/P1. All documented commands exist in `package.json`; all referenced paths resolve; architecture description current; ADR supersession handled in-prose; no ADR has wrong status/superseded-by metadata. Only the D1 P2 future-note above.
- **Governance path/reference integrity**: 14 referenced ADRs/docs/scripts resolve; CONSTITUTION agent roster (13 agents) matches `.claude/agents/`.
- **`SECURITY.md` numeric parameters**: scrypt N=2^16/r=8/p=1, lockout 5/30s, admin-6/staff-4 PIN floor, parameter clamping — all verified against `electron/auth/localAuth.js`. No stale Supabase/RLS-as-current description anywhere.
- **`docs/current/WHERE_DATA_LIVES.md`** counts were themselves stale (see the comprehensive pass below); the phase-1 note that they were "consistent" was wrong and is corrected there.

---

# Comprehensive whole-corpus pass (2026-09-28, owner directive)

Seven auditors swept the ENTIRE live doc corpus — every tracked `*.md` outside `docs/archive/**` and `legacy/**` (707 files), split into disjoint domains. Historical work-record trees (tickets, runs, handoffs, specs, evidence, architecture-reports) are historical-by-design and their frontmatter/status integrity is machine-enforced by `check:governance` (clean); they are not staleness-rewrite targets. Findings below; every contradiction was confirmed at code file:line. `Status`: LANDED (which PR) / OWNER (escalated) / NOTED (corpus-consistency, deferred to safeguards phase).

## Descriptive-current tier (PR-A)

| Doc | Stale claim | Truth (verified) | Status |
|---|---|---|---|
| `CLAUDE.md:101` | DnD `distance: 8` activation constraint | `src/screens/ScheduleScreen.jsx:239` PointerSensor `distance: 5` — the only DnD activation constraint in the schedule code; the span-extend handle uses a plain `onPointerDown` with no distance disambiguation (`SlotCell.jsx`) | LANDED PR-A |
| `docs/current/PLATFORM_STATE.md:687` | schema "v58 as of this writing" | `CURRENT_SCHEMA_VERSION = 78` (`electron/db/localDb.js:38`) | LANDED PR-A |
| `docs/current/PLATFORM_STATE.md` (two `schema_migrations` bullets) | "currently v77"; enumeration stops at v71 | v78; v72–v78 exist (localDb.js:29-37, rollbacks v73–v78) | LANDED PR-A (versions + v72–v78 added) |
| `docs/current/WHERE_DATA_LIVES.md:76` | "51 tables — 29 synced, 1 projected, 21 SQLite-only" | 63 tables (opened fresh DB), 36 synced (`MODELED_ENTITIES.size`), 1 projected-never-synced, 26 SQLite-only (`PROJECTIONS`=37) | LANDED PR-A |
| `docs/current/WHERE_DATA_LIVES.md:80` | "The 28 camp entities" | 33 (36 modeled − camps/users/tombstones) | LANDED PR-A |
| `docs/current/WHERE_DATA_LIVES.md:86` | "23 SQLite-only tables"; `device_health_events` listed twice | 26; dedupe | LANDED PR-A |
| `docs/current/KEY_RECOVERY_STORY.md:30,93` | device identity key T162 "accepted, not yet built" | shipped, schema v67 `device_identity_key` (`electron/auth/deviceIdentity.js`) | LANDED PR-A |
| `docs/current/KEY_RECOVERY_STORY.md:86` | at-rest storage-key refusal "will be updated when wired live" | implemented, gated off by default (`SHORESH_AT_REST_ENCRYPTION`, `electron/main.js`) | LANDED PR-A |

## Security tier (PR-B)

| Doc | Stale claim | Truth | Status |
|---|---|---|---|
| `docs/current/CRDT_SECURITY_GAPS.md` Gaps #3/#4 | role-enforcement / PIN-replication gaps stated without the shipped mitigation | `electron/automerge/projector.js` `upsertUsersEntity` enforces Host `auth_sig` + `cred_version` on the merge path (users auth-field ADR) | LANDED PR-B |
| `SECURITY.md:366,368,375` | "seven" participant entities | eight — `PARTICIPANT_ENTITIES` (`electron/ops/participantEntities.js:18`) incl. `elective_run_outer_snapshots` (T243/v74) | LANDED PR-B |
| `SECURITY.md:27,46` | prod bind + guard attributed to `electron/main.js` | `electron/sync/automerge/syncStarter.js:300` (T276); guard reads syncStarter.js | LANDED PR-B |
| `SECURITY.md:111` | renewal via "`renew_token` WS message" | no renewal handler exists; freshness = re-present-on-restart (`electron/auth/localAuth.js:147`) | LANDED PR-B |
| `SECURITY.md:485` | `bindOrVerifyPeerIdentity` in `connectionAuth.js` | defined in `electron/sync/automerge/peerIdentity.js`; connectionAuth.js is the caller | LANDED PR-B |
| `SECURITY.md:3,56` | "Last updated 2026-09-14"; ":56 pairing_pending phase" | later work landed; renderer phase retired (Host-side `devices.pairing_status='pending'` is real) | LANDED PR-B |

## Governance standards + references (PR-C)

| Doc | Item | Status |
|---|---|---|
| `docs/governance/standards/ARCHITECTURE_STANDARD.md` O1 | "mutating WebSocket handlers call `authorize()`" → refresh to libp2p/Automerge connection-boundary model, cite users auth-field ADR for tracked residual | LANDED PR-C (owner-ruled; security-agent confirmed) |
| `docs/governance/standards/ARCHITECTURE_STANDARD.md` O2 §2 | op-log "replayable across devices" → "device-local history ledger; replication is Automerge" | LANDED PR-C (owner-ruled) |
| `docs/governance/standards/DESIGN_STANDARD.md:214` | pending-retheme list names deleted `EditModal.jsx` | LANDED PR-C |
| `docs/governance/standards/DESIGN_STANDARD.md:210` | `ANCHOR_COLOR='#A63595'` listed pending; already `var(--anchor)` | LANDED PR-C |
| `docs/governance/standards/WORK_RECORD_STANDARD.md:362` | says `check:governance` runs after lint/test; actually 2nd (cheapest-first) | LANDED PR-C |
| `docs/governance/references/{tester-standing-brief,regression-script,director-persona}.md` | "purple" anchor cells → slate (`--anchor`); "edit modal" → inline click-to-write editor | LANDED PR-C |
| **`docs/governance/standards/DESIGN_STANDARD.md:78-81,313-316` §3/§9** | doc asserts a 6-distinct-hue `ACTIVITY_COLORS` palette "live" + a hue-identity rationale; code (`src/components/schedule/slotCellConstants.js:62`) ships an all-navy monochrome lightness ladder | **OWNER DECISION** — three-way (standard rationale vs code vs the standard's own delegation clause :121-125); refresh §3/§9 to the shipped ladder, or treat code as unauthorized drift |

## Agent layer (PR-D) — edit bindings, regenerate profiles

| Binding (+ generated profile) | Stale claim | Status |
|---|---|---|
| `governor` | "LAN Host (WebSocket server)"; "op-log … replayed across devices" | LANDED PR-D |
| `maker` | "op-log … replayed across devices" | LANDED PR-D |
| `architecture-auditor` | audit scope points at deleted `syncClient.js`/`syncServer.js` | LANDED PR-D |
| `architect` | skill-wrapper example names "WebSocket message" primitive | LANDED PR-D |
| (19 of 27 agent files clean) | | — |

## ADR metadata + subdir READMEs (PR-E)

| Doc | Item | Status |
|---|---|---|
| `docs/adr/2026-08-28-persisted-reconciliation-decisions.md` | `implementation_state` not_started → implemented (shipped: `open_reconciliation_decisions` v52) | LANDED PR-E |
| `docs/adr/2026-09-08-libp2p-join-flow.md` | in_progress → implemented (`joinSession.js` wired) | LANDED PR-E |
| `docs/adr/2026-09-08-crdt-conflict-reconciliation.md` | in_progress → implemented (`reconcile.js` wired) | LANDED PR-E |
| `docs/adr/2026-09-19-per-camp-genesis-identity.md` | not_started → implemented (`campDocument.js:325` genesisDoc) | LANDED PR-E |
| `docs/adr/2026-09-26-schema-version-gate-before-merge.md` | not_started → in-progress/partial (handshake gate `syncNode.js:35` present; doc-embedded half pending) | LANDED PR-E |
| `docs/adr/2026-09-17-wan-rendezvous-seam.md` | status proposed, but the 2026-09-27 ladder treats it as accepted | **DEFERRED — owner confirmation** (NOT reconciled; low-confidence status flip on a historical ADR — is the whole seam decision accepted, or only the ladder's D3? left as-is) |
| `scripts/consolidation/README.md:10-38` | "launchd still runs the OLD copy" — false; T171 completed 2026-09-15, in-repo scripts are live, out-of-repo copies gone | LANDED PR-E |

## NOTED — corpus-consistency, deferred to the safeguards phase (not stale-vs-reality)

- **ADR `implementation_state` vocabulary drift**: the 136 ADRs use `implemented`/`shipped`/`complete`/`completed`, `in-progress`/`in_progress`, `not-started`/`not_started` interchangeably (the standard's enum is `not-started`/`in-progress`/`implemented`). Not misleading about reality, just inconsistent — a normalization + `check:governance` enum-enforcement job for the safeguards phase.
- `scripts/mcp/README.md` tools table omits the three projection-repair tools (prose mentions them) — optional.

## Audited clean / correctly-historical (no action)

`README.md`; `docs/governance/{GOVERNANCE_INDEX, constitution/CONSTITUTION, standards/TESTING_STANDARD, standards/WORKING_COPY_STANDARD}.md`; 19/27 agent files; `workers/rendezvous/README.md`, `src/assets/brand/README.md`, `design/brand-source/README.md`, `scripts/consolidation/consolidate.md`, `scripts/mcp/README.md` (bar the optional note); `experiments/future-arch/**` and `docs/superpowers/**` and the `docs/work/2026-*` explorations (all correctly point-in-time historical); no earlier WAN ADR needs a supersession flip.
