---
task: T292 — self-maintaining openable workbook of the camp's data (spec slices S1 + S2)
document_type: run
date: 2026-09-28
round: 1
status: in-progress
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/current/WHERE_DATA_LIVES.md
  - SECURITY.md
related_tickets: [docs/work/tickets/T292-database-document-view.md]
related_specs: [docs/work/specs/2026-09-28-t292-database-document-view.md]
related_adrs:
  - docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
selected_agents: [governor, designer, maker, verifier, security, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: "Spec section 3 doubles as the mini-ADR for where the hook lives (op-apply/projection seam); owner approved with recommendations. No new stored data shape, no changed contract — a read-only consumer of listEntities() plus filesystem IO. Architect concerns folded into the Maker brief and covered on risk by Red Hat."
  - agent: tester
    reason: no-predicate
    note: "Deliverable is a file on disk written by the main process, not an in-app screen (non-goal: no button, no grid). No director-facing UI to evaluate; correctness is deterministic (unit + integration) and adversarial (Red Hat)."
deterministic_checks: [npm run verify]
human_gates: []
verdict: null
completion_evidence: []
archive_when: "S1 + S2 shipped on branch claude/T292-database-document-view with a green gate and Grader pass; leaves docs/work/ when the owner confirms the file behaviour against the spec."
---

# Run: T292 — Camp data record, a self-maintaining openable workbook

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, updated as agents return.

## Brief

**Product outcome:** A director always has one file on their computer —
`~/Documents/Shoresh/<camp> data.xlsx` — that shows the camp's data as a
workbook, one sheet per thing, always current, with no button and no action.
Created when a camp first exists; refreshed automatically on every data change.

**Success predicate:** (spec §1) From the moment a camp exists the file exists
with no director action; after any camp-data change it reflects it on next open
(writes coalesced, not one-per-op); one sheet per director-facing entity with
human columns (app words, FKs as names, formatted dates/times), **no plumbing**
(ids, `*_id`, timestamps, bookkeeping/auth) and **credentials structurally
unreachable**; every cell through `aoaToSanitizedSheet`; a refresh failure never
blocks the real edit (best-effort, retried).

**What does not count as done:** an in-app grid or a download button (both
explicitly rejected); the enrichment round-trip (`exportWorkbook.js` — hidden
`shoresh_id`/`Status`/`_shoresh_meta` baseline); anything that can throw into or
block the op/write path; any sheet that emits an `id`/`*_id`/`client_write_id`/
credential/bookkeeping column.

## Task class and what it pulls in

`architecture` — attaches to the op-apply/projection seam and does filesystem IO
on every change.

| | |
|---|---|
| Standards | ARCHITECTURE_STANDARD, TESTING_STANDARD, DESIGN_STANDARD (§4 curation), SECURITY.md (no-leak seam), WHERE_DATA_LIVES (projection is a copy) |
| Mandatory gates | `npm run verify` (8 steps), `npm run check:governance`, `npm run index:work` |
| Human gate | none (owner already approved the spec + recommendations) |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing (this run, flat/direct — well-scoped, approved spec) |
| Architect | no | not-applicable — spec §3 is the mini-ADR; no new data shape/contract |
| Designer | yes | §4 sheet + column relabel vocabulary, empty states (DESIGN_STANDARD) |
| Maker | yes | build S1 pure builder + S2 refresh hook, test-first at the no-leak seam |
| Code Reviewer | yes | plan/spec fidelity + maintainability |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no-predicate — deliverable is a file, no in-app UI to evaluate |
| Security | yes | no-leak seam (credentials unreachable), sanitizer routing |
| Red Hat | yes | non-blocking best-effort, coalescing never drops last change, atomic write |
| Grader | yes | consolidated score from the review reports |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| npm run verify | pending | |
| check:governance | pending | |
| index:work | pending | |

## Verifier verdict

pending

## Grader score

pending

## Findings carried forward

pending

## Decision

pending
