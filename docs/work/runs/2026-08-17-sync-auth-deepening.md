---
task: sync/auth layer deepening — C1 (extract reliable-delivery/catch-up submodule), C4 (keyed ack registry), C3 (single device-trust predicate)
document_type: run
date: 2026-08-17
round: 1
status: in-progress
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-08-17-sync-auth-layer-deepening.md, docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md, docs/adr/2026-08-16-client-reauth-on-restart.md, docs/adr/2026-07-25-device-trust-revocation.md, docs/adr/2026-07-24-centralized-authorization-layer.md]
selected_agents: [governor, architect, maker, code-reviewer, verifier, security, red-hat, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: pure internal refactor across electron/sync and electron/auth — no rendered surface, no screen/component/interaction change.
  - agent: tester
    reason: not-applicable
    note: behavior-preserving by design (no functional change) — there is no new director-facing behavior for a director's-eye evaluation to judge. Verifier's deterministic gates plus the integration suite are the correctness evidence for this task.
deterministic_checks: [test, lint, build, integration]
human_gates:
  - "Architecture change: this ADR proposes a new module boundary (opDelivery.js, catchup.js) and new shared functions (deviceTrustStatus, deviceTrustReason) — Article IV 'architecture change without an accepted ADR' gate. ADR accepted 2026-08-17, with owner's directed C3-harmonize change layered on."
  - "Security/auth task class (C3): any change touching the device-trust gate re-query pattern requires Security sign-off per GOVERNANCE_INDEX.md's security-auth row, even though this ADR's explicit design goal is zero behavior change."
  - "database-sync/concurrency span (C1/C4): touches the op-log delivery watermark's internal resolver-storage shape — GOVERNANCE_INDEX.md's concurrency row calls for Red Hat review on any change adjacent to write-ordering/replay semantics, even though C1/C4 do not change ordering or replay themselves."
verdict: null
completion_evidence: []
archive_when: "All three approved candidates (C1, C4, C3) are implemented as three separate, sequentially merged PRs per the ADR's slice decomposition; every characterization test named in the ADR's Test strategy section passes with assertion bodies unchanged (Slices 1-2) or with the mandatory fail-first before/after pair plus unchanged assertions elsewhere (Slice 3); the integration suite and full deterministic gate set are green on each slice's own branch before merge; Security has signed off on Slice 3 (device-trust predicate + harmonize) confirming zero change to any of the four call sites' allow/deny outcomes, and confirming the reason-label/close-code change is confined to exactly the reachable revoked-but-never-authorized state at authorize.js/handleAuthenticate per the ADR's harmonized precedence; and the ADR's status remains accepted with implementation_state: implemented in the same commit that closes the final slice."
---

# Run: Sync/auth layer deepening (C1 + C4 + C3)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** None directly visible to a camp director — this is a pure internal-quality
initiative. The outcome is for the *next* engineer (human or agent) who has to change sync/auth code:
`electron/sync/syncServer.js` shrinks from a 1216-line file that silently owns a watermark invariant
alongside its dispatcher/handler responsibilities to a smaller dispatcher-only file, with the
watermark logic isolated in its own tested module (`catchup.js`) and the device-trust gate expressed
once instead of copied four times with one silent divergence among the copies.

**Success predicate:** Ticket's own `archive_when` (frontmatter, above) — three slices land. Slices 1–2
(C1/C4) are provably behavior-preserving by their own characterization tests, with zero change to any
wire message, any schema, or any observable outcome. Slice 3 (C3) is provably deny-preserving at all
four device-trust call sites (the *allow/deny* outcome is unchanged for every combination) and makes
exactly one intentional, tested, reviewed change: the reason label at `authorize.js`/`handleAuthenticate`
harmonizes to the canonical (revoked-wins) precedence for the reachable `revoked-but-never-authorized`
state, confirmed UX-neutral per the ADR's acceptance addendum.

**What does not count as done:** Any slice that changes an *allow/deny* outcome (a device that used to
be denied is now allowed, or vice versa) — that would be a correctness regression, which this
initiative explicitly does not authorize. A combined single PR for C1+C4 — the ADR's slice
decomposition (Slices 1 and 2, separately) is deliberate, not a suggestion. Harmonizing the
device-trust reason precedence *without* the mandatory fail-first characterization test (ADR Test
strategy §3) — the change itself is directed by owner acceptance, but landing it silently, without the
before/after test pinning both the old and new reason for the affected call sites, does not count as
done.

## Architect design (this document's companion)

Design, divergent-ideation record (three candidate module shapes for C1/C4), and the ADR itself are in
`docs/adr/2026-08-17-sync-auth-layer-deepening.md` (status: accepted, 2026-08-17, with the C3-harmonize
change described below). Summary for this run record:

- **C1** — extract `electron/sync/syncServer.js` lines 28–362 (`send`, `sendWithAck`,
  `waitForFullSyncAck`, `sendFullSyncIfFirstPairing`, `currentMaxOpSeq`, `waitForApplyAck`,
  `sendMissedOps`) into two new, layered files: `electron/sync/opDelivery.js` (leaf transport
  primitives) and `electron/sync/catchup.js` (the watermark-owning protocol logic, depends on
  `opDelivery.js`). No cycle. `handleAuthenticate` stays in `syncServer.js`, importing both.
- **C4** — replace the single-resolver-on-`ws` fields with a genuinely keyed `Map<op_id, resolve>`
  for apply-acks (the wire message already carries `op_id` as a correlator) inside `catchup.js`,
  exposed via `resolveApplyAck(ws, opId)`/`resolveFullSyncAck(ws, result)`. Full-sync-ack stays
  single-slot internally — `full_sync_applied` carries no correlator on the wire, so a keyed registry
  cannot dispatch it correctly without a protocol change, which is out of scope.
- **C3** — one new `electron/auth/deviceTrust.js` exporting `deviceTrustStatus(db, deviceId)`
  (raw `{found, authorized, revoked, row}` booleans, unchanged query) and `deviceTrustReason(trust)`
  (**new**, one canonical precedence — revoked wins over not-authorized), adopted by all four existing
  call sites (`authorize.js`, and `syncServer.js`'s `handleAuthenticate`/`handleLogin`/`renew_token`).
  The ADR found a reachable, genuine divergence in the pre-refactor code (`revokeDevice` never requires
  prior authorization, so a never-approved-then-revoked device hits `authorize.js`/`handleAuthenticate`
  reporting "not authorized" while `renew_token` reports "revoked"). **Owner acceptance (2026-08-17)
  directed this divergence to be harmonized, not preserved:** the canonical ordering matches
  `renew_token`'s pre-existing precedence, so only `authorize.js` and `handleAuthenticate` change their
  reason label (and, at `handleAuthenticate`, close code 4403 → 4404) for that one reachable state; the
  allow/deny outcome is unchanged at all four sites; and the change is confirmed UX-neutral —
  `src/hooks/useDeviceMode.js` already maps both 4403 and 4404 to the identical director-facing message.
- **Critical finding:** T85's `isReauthenticate` guard (`syncServer.js:452`) survives C4 unchanged —
  two independent reasons, either sufficient alone (the unkeyable full-sync-ack; a final-`UPDATE`
  race on `last_synced_seq` that a correctly-keyed apply-ack registry does not by itself serialize
  away). Recommendation: do not touch `isReauthenticate` in any slice.
- **Slice decomposition:** three slices, not the two originally floated (C1+C4 combined) — Slice 1
  (C1, pure move, zero behavior change), Slice 2 (C4, registry shape change, scoped to the
  now-isolated `catchup.js`), Slice 3 (C3, independent, security-sensitive). Recommended order 1→2→3,
  each its own PR, each independently revertible.

## Task class and what it pulls in

`security-auth` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `SECURITY.md` · `ARCHITECTURE_STANDARD.md` · ADRs `2026-07-24-centralized-authorization-layer`, `2026-07-25-device-trust-revocation` |
| Mandatory gates | test · lint · build · **integration (mandatory, per the `database-sync`/`concurrency` span — see below)** |
| Human gate | **any change to an accepted tradeoff / architecture change without an accepted ADR** — satisfied: ADR accepted 2026-08-17, including the owner's directed C3-harmonize change |

This task also spans `database-sync`/`concurrency` (C1/C4 touch the op-log delivery watermark's
internal resolver storage). Per `WORK_RECORD_STANDARD.md` §4, a task spanning two classes takes the
**stricter** gate list from both: `database-sync`/`concurrency`'s own recommendation (Red Hat review on
anything adjacent to write-ordering/replay semantics) applies to Slices 1–2 even though neither slice
changes ordering or replay itself — only where the resolver bookkeeping lives.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing; will decide slice sequencing/parallelism and whether each slice gets its own ticket (open question flagged to Governor in the ADR) |
| Architect | yes | this document's companion ADR — verified all three candidates against current source, designed the module boundaries, resolved the isReauthenticate question |
| Designer | no | not-applicable — no rendered surface (see `omitted_agents`) |
| Maker | yes | implements each slice once the ADR is accepted, one slice at a time per the recommended sequence |
| Code Reviewer | yes | maintainability + plan-alignment on each slice's diff — specifically: is Slice 1 truly verbatim, does Slice 2's registry match the ADR's keyed design, does Slice 3 keep all four call sites' *allow/deny* conditions unchanged while applying the harmonized reason precedence exactly where the ADR specifies (and nowhere else) |
| Verifier | yes | always — the only deterministic evidence source; integration suite mandatory for this task class |
| Tester | no | not-applicable — behavior-preserving by design, no new director-facing behavior to evaluate (see `omitted_agents`) |
| Security | yes | mandatory for security-auth task class; must specifically verify Slice 3's four call sites are *allow/deny*-outcome-identical pre/post-refactor, and that the reason-label/close-code change is confined to exactly the reachable revoked-but-never-authorized case at `authorize.js`/`handleAuthenticate`, per the mandatory fail-first characterization test |
| Red Hat | yes | recommended for the database-sync/concurrency span; should specifically re-attack Slice 2's keyed apply-ack registry for any new interleaving hazard, and confirm Slice 1's move introduces no ordering change |
| Grader | yes | consolidates the above into a single pass/fail read, per slice |

Every one of the ten appears here.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| ADR written | done | `docs/adr/2026-08-17-sync-auth-layer-deepening.md`, status `accepted` |
| ADR acceptance | done | Owner accepted 2026-08-17 with one directed change to C3: harmonize the device-trust reason precedence (revoked wins) instead of preserving the divergence. See ADR acceptance note + Approach §C3. |
| Slice 1 (C1) implementation | done | commit `155cb13` — verbatim move to `opDelivery.js` + `catchup.js`; `syncServer.js` 1215→891 lines |
| Slice 2 (C4) implementation | done | commit `2f993e9` — keyed `Map<op_id,resolve>` apply-ack registry in `catchup.js`; full-sync-ack single-slot behind `resolveFullSyncAck`; `isReauthenticate` byte-unchanged |
| Slice 3 (C3) implementation | not started | |
| Slice 1 — test / lint / integration | pass | `syncServer.test.js` 58/58, integration 25/25, lint 0 errors, governance clean; solo full suite 3054 pass. Landed PR #91 (`647ce36`), gate report `sync-auth-c1-r1.json` |
| Slice 1 — Security review | pass | 5/5 — byte-verbatim confirmed line-by-line; `handleAuthenticate`/auth/trust unchanged; no secret crosses the new module boundary |
| Slice 1 — Red Hat review | pass | Resilience 5/5 — cross-module `ws`-state correlation, module-scope captures, watermark math, T85/T87 guards all verified intact; no scope creep |
| Slice 1 — Code Reviewer | pass | Ready — faithful verbatim move, only the two ADR-specified exports added, no cycle, no dead imports |
| Slice 2 — test / lint / integration | pass | `syncServer.test.js` 61/61, solo full suite 3081 pass, integration 25/25, lint 0 errors, governance clean. Gate report `sync-auth-c4-r1.json` (Grader PASS 4.6) |
| Slice 2 — Security review | pass | 5/5 — per-`ws` registry isolation, no unbounded Map growth (client can't drive registration; entries self-delete on timeout), no auth boundary touched |
| Slice 2 — Red Hat review | pass | Resilience 4/5 — keyed Map fixes clobber only for DIFFERENT op_ids; same-op_id case (overlapping runs share one watermark) still clobbers but is inert (isReauthenticate-gated). Fix round: honest comments + ADR scoping + known-limitation test |
| Slice 2 — Code Reviewer | pass | Ready — matches ADR sketch; concurrency test load-bearing; asymmetry (full-sync-ack single-slot) intentional; no scope creep |
| Slice 3 gates (test/lint/integration, Security sign-off, Red Hat, Code Reviewer) | not started | |

## Verifier verdict

Not yet run — no slice implemented.

## Grader score

Not yet run — no slice implemented.

## Findings carried forward

- **Resolved by owner acceptance (2026-08-17):** the device-trust reason divergence (should a device
  that is both never-authorized and revoked report "revoked" or "not authorized"?) is harmonized to
  "revoked wins," matching `renew_token`'s pre-existing precedence. Only `authorize.js` and
  `handleAuthenticate` change; the allow/deny outcome is unchanged at all four call sites; the change
  is confirmed UX-neutral (`useDeviceMode.js` already folds both affected close codes to one message).
  Maker must land this behind the mandatory fail-first characterization test in the ADR's Test
  strategy §3 — not silently.
- **No ticket exists for this initiative**, unlike C2/T88 which had its own ticket (a live bug, not a
  pure refactor). Governor to decide whether each slice warrants its own ticket for tracking.
- **Non-goal, explicitly out of scope:** a `full_sync`/`full_sync_applied` wire correlator, which would
  let C4's keyed-registry pattern extend fully to the full-sync-ack case. Would require its own ADR if
  ever pursued — not a side effect of this initiative.

## Decision

ADR accepted by owner 2026-08-17, with one directed change: harmonize the C3 device-trust reason
precedence (revoked wins) instead of preserving the divergence — see ADR acceptance note and Approach
§C3. Governor to route Maker through Slices 1→2→3 per the recommended sequence; Slice 3 must land with
the mandatory fail-first characterization test (ADR Test strategy §3) and its own Security review pass.
