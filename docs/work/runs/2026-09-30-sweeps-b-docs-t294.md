---
task: "Sweeps PR B (board q-small-sweeps-batch): PLATFORM_STATE schema_migrations de-duplication, ADR implementation_state enum normalisation, and dated disposition notes on T294/T171/T195"
document_type: run
date: 2026-09-30
round: 1
status: in-progress
task_class: documentation-governance
governing_docs:
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets:
  - docs/work/tickets/T294-documentation-staleness-audit-and-refresh.md
  - docs/work/tickets/T171-finish-the-consolidation-move-and-harden-gate-sh.md
  - docs/work/tickets/T195-preference-import-service.md
related_specs: []
related_adrs: []
selected_agents: [Governor, Maker, Code Reviewer, Red Hat, Verifier, Grader]
omitted_agents:
  - agent: Architect
    reason: no-predicate
    note: "docs-only; no persistent data shape, no contract other code calls, nothing irreversible"
  - agent: Designer
    reason: not-applicable
    note: "no UI surface touched; footprint is docs/**"
  - agent: Tester
    reason: not-applicable
    note: "no runtime behaviour changes; nothing a director could exercise in the app"
  - agent: Security
    reason: no-predicate
    note: "no auth, secrets, PIN, IPC, transport or packaging surface in the diff"
deterministic_checks:
  - "npm run check:governance"
  - "npx vitest run test/governance.test.js scripts/check-governance.test.js"
  - "npm run agents:check"
  - "implementation_state value-set enumeration across docs/adr/*.md"
  - "PLATFORM_STATE version-fact diff (no vNN fact lost in the merge)"
human_gates: []
verdict: null
completion_evidence: []
archive_when: "PLATFORM_STATE.md holds exactly one schema_migrations bullet carrying every version fact from the two prior bullets with a true, marked current-version claim; every docs/adr/*.md implementation_state is one of not-started / in-progress / implemented with the mapping recorded here; T294/T171/T195 carry their dated disposition notes; and this branch has landed on main."
---

# Run: Sweeps PR B — docs-only governance sweep (T294 b/c, T294 a note, T171 note, T195 hand-back)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** an agent or human reading `PLATFORM_STATE.md` sees one schema-migration
history, not two near-identical ones that disagree about the current version; and the ADR corpus
reports implementation progress in one vocabulary, so `docs/work/INDEX.md` and the closed-state
gate mean the same thing everywhere. Three board sub-items that turn out not to be actionable by
this worker carry a dated note saying so, instead of being silently dropped.

**Success predicate:**

1. `docs/current/PLATFORM_STATE.md` contains exactly one `**schema_migrations**` bullet, and every
   version fact present in either of the two prior bullets (v19–v78, including the v67 paragraph
   that lived only on the second bullet) is still present in it; its current-version claim is true
   against `CURRENT_SCHEMA_VERSION` in `electron/db/localDb.js` (83), and every existing
   `<!-- doc-fact:… -->` marker in the file is preserved byte-for-byte.
2. The set of `implementation_state` values across `docs/adr/*.md` is exactly
   `{not-started, in-progress, implemented}` — no underscore variants, no trailing parentheticals,
   no out-of-enum words. Every discarded nuance survives as a line in that ADR's body. No ADR
   `status` changes.
3. `docs/work/tickets/T294-…`, `…/T171-…`, `…/T195-…` each carry a dated one-line note recording
   the disposition described below.
4. `npm run check:governance` exits 0 with no blocking findings and no new advisory finding beyond
   the pre-existing `platform-state-stale`; the governance test files pass; `npm run agents:check`
   passes; `docs/work/INDEX.md` is regenerated.

**What does not count as done:**

- Dropping, summarising away, or "consolidating" any `vNN` version fact to make the merged bullet
  shorter. The bullet is allowed to be long.
- Deleting a nuance-bearing `implementation_state` value (`partial`, `deferred-build`,
  `edits-applied-remeasurement-deferred`, or a parenthetical) without preserving what it said in
  the ADR body.
- Changing any ADR `status`, editing `WORK_RECORD_STANDARD.md`, or editing `README.md`.
- Clearing the pre-existing `platform-state-stale` advisory, or running `/update-state`.
- A commit subject that claims closure (`closes`/`fixes`/`completes`) — `checkClosureClaimWithoutId`
  is blocking and nothing here closes a ticket.
- Touching `scripts/`, `src/`, or `electron/`.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `WORK_RECORD_STANDARD.md` (frontmatter enums, closed-state predicate, "never delete reasoning to satisfy a field"); `CONSTITUTION.md` Art. I (code outranks descriptive prose; a standard is not amended to match the corpus) |
| Mandatory gates | `npm run check:governance`; `test/governance.test.js`; `scripts/check-governance.test.js`; `npm run agents:check`; `npm run index:work` regeneration |
| Human gate | none — no architecture change, no security tradeoff, no standard amendment, no agent-roster change |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `no-predicate` — no persistent shape, no contract, nothing irreversible |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | writes the doc edits |
| Code Reviewer | yes | spec fidelity: no version fact lost, every ADR mapping defensible |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — no runtime behaviour to exercise |
| Security | no | `no-predicate` — no auth/secret/IPC/transport/packaging surface |
| Red Hat | yes | which normalisation silently flips an ADR's closed-state or misrepresents it |
| Grader | yes | calibrated score from the review reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Sub-item disposition

| Sub-item | Disposition |
|---|---|
| T294 (b) duplicated `schema_migrations` bullet | **Done here** — merged to one bullet. |
| T294 (c) ADR `implementation_state` vocabulary | **Done here** — normalised to the three-value enum. |
| T294 (a) README WAN note | **Not actionable** — conditioned on the Tier-4 gate flipping; `INTERNET_TRANSPORT_SIGNOFF` is still `false` and `README.md` carries no WAN text to correct. Dated note in T294 only. |
| T171 launchd plist repoint | **Already discharged** — the plist already execs the on-main consolidation script; the only residual is a slug literal in the owner's out-of-repo `~/Library/LaunchAgents` plist. Dated note in T171 only. |
| T195 "no longer on the sheet" marker | **Handed back** — requires `src/ingest/**`, a seam this worker may not touch. Dated note in T195 routing it to the import-seam worker. |

## Baseline (pre-change, measured 2026-09-30 at 3ceee575)

- `npm run check:governance` → exit 0, 1 advisory finding: `platform-state-stale`. This is the
  reference the post-change run must match exactly.
- `CURRENT_SCHEMA_VERSION = 83` (`electron/db/localDb.js:42`); `PLATFORM_STATE.md:735` carries
  `<!-- doc-fact:schema_version value=83 -->` and is the file's only doc-fact marker. Both duplicate
  bullets claim `(currently **v78**)` with **no** marker — an unmarked stale claim, not a marked fact.
- `implementation_state` value census across `docs/adr/*.md`, 20 distinct raw values:
  `implemented` 54, `not-started` 16, `not_started` 13, `in-progress` 12, `shipped` 11, `proposed` 8,
  `in_progress` 8, `planned` 5, `complete` 3, `not started` 2, and one each of
  `partial (part 1 … part 2 … not started)`, `not-started (part 1 — the binder; part 2 — atomic
  multi-row import)`, `implemented (2026-09-01; scripts/mcp/{server,tools}.js …)`,
  `existing — retroactively documented`, `existing pattern — policy now explicit`,
  `edits-applied-remeasurement-deferred`, `deferred-build (direction ratified; build deferred per
  owner decision)`, `completed`.

## ADR mapping table

Filled in from Maker's report and confirmed by Verifier's enumeration.

| Old value | New value | Count | Closed-state change? |
|---|---|---|---|
| | | | |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npm run check:governance` | | |
| `npx vitest run test/governance.test.js scripts/check-governance.test.js` | | |
| `npm run agents:check` | | |
| implementation_state value-set enumeration | | |
| PLATFORM_STATE version-fact diff | | |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

- The pre-existing `platform-state-stale` advisory is untouched by design, and `PLATFORM_STATE.md`
  still describes no migration above v78 even though the code is at v83. That gap belongs to a
  `/update-state` pass, not to this sweep.
- Open point (owner unavailable, self-answered): `docs/adr/2026-09-17-wan-rendezvous-seam.md` remains
  `status: proposed` while a later accepted ADR treats it as accepted (T294's own D3 note). This run
  does not touch any ADR `status`, so the question stays open for the owner.

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
