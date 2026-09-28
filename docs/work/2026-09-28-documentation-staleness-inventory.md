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
- **`docs/current/WHERE_DATA_LIVES.md`** counts (schema v78, 51 tables) consistent with unchanged schema.
</content>
</invoke>
