---
task: "Sweeps PR B (board q-small-sweeps-batch): PLATFORM_STATE schema_migrations de-duplication, ADR implementation_state enum normalisation, and dated disposition notes on T294/T171/T195"
document_type: run
date: 2026-09-30
round: 2
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
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: "docs-only; no persistent data shape, no contract other code calls, nothing irreversible"
  - agent: designer
    reason: not-applicable
    note: "no UI surface touched; footprint is docs/**"
  - agent: tester
    reason: not-applicable
    note: "no runtime behaviour changes; nothing a director could exercise in the app"
  - agent: security
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

Filled in from Maker's report and confirmed by Verifier's enumeration. 59 ADR files touched
(one, `2026-09-08-flat-record-shape.md`, pre-existed with embedded NUL bytes unrelated to this
change — `git diff` reports it "Binary files differ"; confirmed with `grep -a` and a byte-offset
diff that only the `implementation_state` line changed).

| Old value | New value | Count | Closed-state change? |
|---|---|---|---|
| `not_started` | `not-started` | 13 | no (already not closed either way) |
| `shipped` | `implemented` | 11 | **yes** — all 11 carry `status: accepted` |
| `in_progress` | `in-progress` | 8 | no |
| `proposed` | `not-started` | 8 | no |
| `planned` | `not-started` | 5 | no |
| `complete` | `implemented` | 3 | **yes** — all 3 carry `status: accepted` |
| `not started` | `not-started` | 2 | no |
| `existing — retroactively documented` | ~~`implemented`~~ → `in-progress` (round 2 correction) | 1 | **no, on re-check** — Constraint 4's mandated inline code comment is absent from `electron/main.js` (`grep -c` for either required phrase returns 0); round 1's `implemented` was a false closure, caught by Red Hat |
| `existing pattern — policy now explicit` | `implemented` | 1 | **yes** |
| `edits-applied-remeasurement-deferred` | `in-progress` | 1 | no |
| `completed` | ~~`implemented`~~ → `not-started` (round 2 correction) | 1 | **no, on re-check** — the ADR's own line 20 says `**Status: ACCEPTED — design only, no code written yet.**` and its target files (`electron/sync/syncClient.js`/`syncServer.js`) do not exist in this tree; round 1's `implemented` was a false closure, caught by Red Hat |
| `deferred-build (direction ratified; build deferred per owner decision)` | `not-started` | 1 | no |
| `implemented (2026-09-01; scripts/mcp/{server,tools}.js + tests, launchable via \`npm run mcp\`)` | `implemented` | 1 | **yes** (raw string did not equal `implemented` before) |
| `partial (part 1 …merged; part 2 …not started)` | `in-progress` | 1 | no |
| `not-started (part 1 — the binder; part 2 — atomic multi-row import)` | `not-started` | 1 | no |

Post-change enumeration (round 1): `implemented` 72, `in-progress` 22, `not-started` 46 (sums to 140,
matching the pre-change 132 + the 8 parenthetical/free-text singles). Zero `status` fields touched
(`git diff origin/main..HEAD -- docs/adr \| grep '^[+-]status:'` and the working-tree equivalent
both return nothing).

**Round 2 correction to the above:** two of the 18 "newly-closed" ADRs below were false closures
(see the mapping-table rows above and the Round 2 section). Post-round-2 enumeration:
`implemented` **70**, `in-progress` **23**, `not-started` **47** (still sums to 140; zero ADRs added
or removed, two moved between buckets — one to `not-started`, one to `in-progress`). Value-set is
still exactly `{not-started, in-progress, implemented}`.

**Regression check:** confirmed zero ADRs moved from a prior exact `implementation_state: implemented`
to anything else (a script diffed old/new values per file and filtered for that direction — 0 matches
in round 1; the two round-2 corrections below are moves OFF `implemented`, made deliberately after
this sweep's OWN round-1 mapping put them there in error, not reversions of a pre-existing `main`
value).

**Newly-closed ADRs, corrected for round 2** (all `status: accepted`, `implementation_state` now
exactly `implemented`, previously not exactly that string) — **16 total**, down from round 1's 18:

- docs/adr/2026-07-24-bulk-replace-seq-fix.md (was `shipped`)
- docs/adr/2026-07-24-centralized-authorization-layer.md (was `shipped`)
- docs/adr/2026-07-25-append-only-audit-event-log.md (was `shipped`)
- docs/adr/2026-07-25-device-trust-revocation.md (was `shipped`)
- docs/adr/2026-07-28-explicit-userdata-directory.md (was `shipped`)
- docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md (was `shipped`)
- docs/adr/2026-07-28-schedule-flag-findings-reshape.md (was `shipped`)
- docs/adr/2026-08-04-repository-layer-policy.md (was `existing pattern — policy now explicit`)
- docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md (was `complete`)
- docs/adr/2026-08-19-roots-census-and-persistent-inspector.md (was `complete`)
- docs/adr/2026-08-21-mcp-ingestion-server.md (was `implemented (2026-09-01; …)`)
- docs/adr/2026-09-03-compound-cell-interpretation.md (was `shipped`)
- docs/adr/2026-09-09-field-provenance-in-the-document.md (was `complete`)
- docs/adr/2026-09-15-opinion-report-dispatch-provenance.md (was `shipped`)
- docs/adr/2026-09-16-anchor-scope-single-resolver.md (was `shipped`)
- docs/adr/2026-09-16-index-survival-across-table-rebuilds.md (was `shipped`)

Removed from the round-1 list (false closures, corrected in round 2, see below):

- docs/adr/2026-08-04-project-lifecycle-authorization-exemption.md — now `in-progress`
- docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md — now `not-started`

None of the 16 remaining moves the ADR to a *less* closed state — no escalation triggered. See the
Round 2 section for the `check:governance` re-run confirming neither correction surfaced a new
`status-drift` finding.

Seven ADRs carry a nuance line in the body (not eight, as the brief's count anticipated — the count
of distinct nuance-bearing values in the `NUANCE PRESERVATION` list sums to 7, not 8; `completed`,
also singled out in the census, is a pure synonym per the MAPPING rule and needed none):
`2026-09-30-elective-run-durability.md`, `2026-09-30-format-agnostic-setup-import.md`,
`2026-08-21-mcp-ingestion-server.md`, `2026-08-04-project-lifecycle-authorization-exemption.md`,
`2026-08-04-repository-layer-policy.md`, `2026-08-09-agent-quality-waste-metric-and-quality-floor.md`,
`2026-08-20-facility-topology-foundation.md`.

## Round 2

Red Hat reviewed round 1 (commits `207a6acc…ebed9e4e`, branch `claude/sweeps-b-docs-t294`) and found
that the `→ implemented` half of the mapping created **false closed states**:
`scripts/check-governance.js`'s `isClosed()` treats `status: accepted` + `implementation_state:
implemented` as closed, permanently suppressing the `status-drift` gate for an ADR mapped that way.
Converting a visible vocabulary mess into an invisible false-closed state is worse than leaving it
visibly messy. Each finding was independently re-confirmed against the code before acting on it, not
taken on Red Hat's word:

1. **`docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md`** — round 1 mapped
   `completed` → `implemented` as a pure synonym. Confirmed the ADR's own line 20 reads
   `**Status: ACCEPTED — design only, no code written yet.**`, and confirmed via `ls electron/sync/`
   that its target files (`syncClient.js`, `syncServer.js`) do not exist — retired by the Stage 6
   Automerge cutover. Corrected to `not-started`; nuance line added recording the old value, the
   contradiction, the retirement, and an open question (not decided here) of whether `status:
   superseded` is the honest disposition — that is a human architecture-judgement gate
   (`CONSTITUTION.md` Art. IV), not a mapping change.
2. **`docs/adr/2026-08-04-project-lifecycle-authorization-exemption.md`** — round 1 mapped
   `existing — retroactively documented` → `implemented`. Confirmed the exemption policy and the
   `authorize()` boundary are genuinely in place, but Constraint 4 (its own lines ~44–51) mandates a
   specific two-line inline comment in `electron/main.js` that is absent: `grep -c
   'project-lifecycle-authorization-exemption' electron/main.js` → `0`, `grep -c 'trusted
   local-device operation' electron/main.js` → `0`; only a generic block header exists at
   `electron/main.js` ~2809. Corrected to `in-progress`; nuance line added. `electron/main.js` was
   not edited — that fix is `src/`-adjacent and outside this docs-only worker's footprint.
3. **T294 dated note premise** — round 1's note rested on "`INTERNET_TRANSPORT_SIGNOFF` is still
   false", which is stale: T288 replaced that coarse boolean with a per-capability registry,
   `TRANSPORT_CAPABILITIES` (`electron/sync/automerge/transportCapabilities.js`, confirmed by reading
   the file directly, not the relayed summary). `discovery` has a `signoff` dated 2026-09-28; the
   other nine capabilities (`relay`, `dcutr`, `webrtc`, `websockets`, `webtransport`, `quic`,
   `kadDht`, `bootstrap`, `upnp`) are still `signoff: null` — the brief's summary named six of these
   nine; the file itself has ten capabilities total (nine `signoff: null`), confirmed by reading it directly rather than the summary. The note's conclusion (README WAN item not
   actionable) survives, but the corrected note now cites the real mechanism instead of a retired
   boolean, per the Round 2 edit in `docs/work/tickets/T294-documentation-staleness-audit-and-refresh.md`.
4. **Systematic re-check** — every ADR round 1 moved to `implemented` (18, derived fresh from
   `git diff origin/main..HEAD -- docs/adr`, not from the round-1 count on trust) was grepped for
   `design only`, `no code written`, `not yet`, `unbuilt`, `not implemented`, `deferred`, `TODO`, and
   any `**Status:**` line. Results:
   - Findings 1 and 2 above (already corrected).
   - **`docs/adr/2026-09-16-anchor-scope-single-resolver.md`** — its own line 19 reads `**Status:**
     proposed 2026-09-16 — **blocked** on T180 and T182 landing on main`, which on its face
     contradicts `implemented`. Checked further: `docs/work/tickets/T180-…`, `T182-…`, and
     `T183-…` (the related consolidation ticket) are all `status: completed`, and the resolver
     module the ADR describes, `src/engine/anchorScope.js`, exists in this tree. So the underlying
     work landed after this line was written; the line is a **stale body status line that
     undersells the current build state** (the opposite direction from findings 1/2, which
     overstated it), not a false closure. `implementation_state: implemented` is left unchanged —
     it is factually correct — and this is recorded as a carried-forward finding below rather than
     edited, since updating the body's own H1 status prose is a content correction beyond this
     round's mapping/nuance-line scope.
   - The four ADRs Red Hat named as citing the deleted `syncClient.js`/`syncServer.js` without
     making a contradicting claim about their own build state — `2026-07-24-bulk-replace-seq-fix.md`,
     `2026-07-24-centralized-authorization-layer.md`, `2026-07-25-device-trust-revocation.md`,
     `2026-07-28-first-pairing-domain-sync-and-template-identity.md` — confirmed present
     (`grep -l 'syncClient.js\|syncServer.js'` matches all four). Left `implemented` alone per the
     brief's instruction; carried forward below.
   - The remaining 12 ADRs (`2026-07-25-append-only-audit-event-log.md`,
     `2026-07-28-explicit-userdata-directory.md`, `2026-07-28-schedule-flag-findings-reshape.md`,
     `2026-08-04-repository-layer-policy.md`, `2026-08-06-inferred-activity-rules-at-ingest.md`,
     `2026-08-19-roots-census-and-persistent-inspector.md`, `2026-08-21-mcp-ingestion-server.md`,
     `2026-09-03-compound-cell-interpretation.md`, `2026-09-09-field-provenance-in-the-document.md`,
     `2026-09-15-opinion-report-dispatch-provenance.md`, `2026-09-16-index-survival-across-table-rebuilds.md`)
     had no contradicting hits, or hits that on inspection describe a named edge case, an explicit
     out-of-scope exclusion, or ordinary migration mechanics rather than a claim that the ADR itself
     is unbuilt (e.g. field-provenance's "deferred integration scenario 18" names a separately-tracked
     exit criterion, not this ADR's own state). No changes made to these.

## Round 2 corrections

Two factual corrections applied after Round 2 closed — not a round 3. Each was flagged independently
by two reviewers (Verifier/Code Reviewer on one, Red Hat on the other) and independently re-confirmed
by Governor against source before being applied as a correction rather than reopened as a new round:

1. **Capability count.** `docs/work/tickets/T294-documentation-staleness-audit-and-refresh.md`'s
   2026-09-30 corrected disposition note and this run record's Round 2 §3 both said "nine
   capabilities" for `TRANSPORT_CAPABILITIES`. Direct enumeration of
   `electron/sync/automerge/transportCapabilities.js` shows ten (`discovery`, `relay`, `dcutr`,
   `webrtc`, `websockets`, `webtransport`, `quic`, `kadDht`, `bootstrap`, `upnp`), of which one
   (`discovery`) carries a `signoff` and the other nine are `signoff: null`. Both documents corrected
   to ten / nine; the nine-name parenthetical itself was already correct and is unchanged.
2. **ADR nuance line stopped one layer shallow.** `docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md`'s
   round-2 nuance line correctly established `not-started` for this ADR's own decision (stub-seed +
   `op_applied_ack` watermark, never built) but did not say whether the underlying FK-drop concern is
   still an open risk. It is not: `electron/automerge/historyLedger.js`'s `appendReceivedOps` resolves
   the same concern today by a different mechanism (skip-and-warn), confirmed by reading that function
   directly. A line was added recording this so a reader does not mistake `not-started` for "the
   problem is unhandled." `implementation_state` and `status` were not touched.

## Gates

Round 1 results shown where unchanged; round 2 re-ran every gate after the two corrections and the
INDEX regeneration.

| Gate | Result | Evidence |
|---|---|---|
| `npm run check:governance` | PASS (re-run, round 2) | exit 0; only the pre-existing `platform-state-stale` advisory (unchanged from baseline); zero blocking findings; **no new `status-drift` finding** despite two ADRs moving OUT of closed state — confirmed no branch commit subject references either corrected ADR as complete |
| `npx vitest run test/governance.test.js scripts/check-governance.test.js` | PASS (re-run, round 2) | 120/120 tests passed (81 + 39) |
| `npm run agents:check` | PASS (re-run, round 2) | all 13 generated profiles + manifest byte-identical to committed `.claude/agents/*.md` |
| implementation_state value-set enumeration | PASS (re-run, round 2) | `grep -h '^implementation_state:' docs/adr/*.md \| sed … \| sort \| uniq -c` → `70 implemented`, `23 in-progress`, `47 not-started` — exactly the three enum values, nothing else; reflects the two round-2 corrections (72→70 implemented, 22→23 in-progress, 46→47 not-started) |
| `git diff origin/main..HEAD -- docs/adr` piped to `grep -E '^[+-]'` matching `status/date/authority/title:` | PASS (round 2) | empty — zero of those four frontmatter fields touched anywhere in `docs/adr/` |
| PLATFORM_STATE version-fact diff | PASS (round 1, untouched in round 2) | every `v<NN>` token (regex `\bv\d{1,3}\b`) present in either old bullet is present in the merged bullet (`comm`/set-diff shows empty "missing" set); only additions are `v79`/`v83` from the new current-version claim, both expected |

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
- **`docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md` carries a stale
  `RESOLVED` banner.** Its line 15 reads `**RESOLVED 2026-08-16 — fixed via
  [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md]…, merged with owner sign-off**`
  and cites integration scenario 24 (`test/integration/scenarios/24-device-fk-seeding-and-watermark.js`)
  as proof, with `status: completed`. Both halves verified directly: the cited scenario file does not
  exist (`ls test/integration/scenarios/24-device-fk-seeding-and-watermark.js` → no such file), and the
  ADR it cites as the fix now reads `implementation_state: not-started` (this run's own correction,
  above). No gate catches this: a ticket's "fixed via [ADR]" banner is never cross-checked against that
  ADR's `implementation_state`. Not fixed here — T85 is outside this docs-only worker's authorized
  footprint (T294/T171/T195 only), and two other Governors are working in parallel on other tickets.
- **Roughly a dozen `implemented` ADRs cite the deleted `electron/sync/syncClient.js` /
  `electron/sync/syncServer.js` in the present tense**, beyond the four already named in Round 2's own
  finding above (which covered only the 18 ADRs round 1 moved to `implemented`). Measured fresh across
  *every* ADR: `grep -rl 'syncClient\.js\|syncServer\.js' docs/adr/ | xargs grep -l
  'implementation_state: implemented' | wc -l` → **16**. Red Hat read three of these
  (`docs/adr/2026-07-25-device-trust-revocation.md:65`, `docs/adr/2026-09-08-libp2p-join-flow.md:156`,
  `docs/adr/2026-08-16-locations-optional-map.md` at several lines) and confirmed present-tense
  citations of files that no longer exist. Their decisions did ship — these are stale citations inside
  historical/implemented documents, not false closures. The blind spot: the round-2 phrase-list
  re-check (`design only`, `no code written`, `not yet`, `unbuilt`, `not implemented`, `deferred`,
  `TODO`, `**Status:**`) only asks "does this prose admit incompleteness," never "does this cited file
  still exist" — so a confidently-worded `implemented` ADR citing a deleted file passes it clean. Not
  fixed here — same footprint reason as above.

### Added in round 2

- **Four ADRs cite the deleted `syncClient.js`/`syncServer.js`** without making a contradicting claim
  about their own build state, so `implementation_state: implemented` was left unchanged for each:
  `docs/adr/2026-07-24-bulk-replace-seq-fix.md`, `docs/adr/2026-07-24-centralized-authorization-layer.md`,
  `docs/adr/2026-07-25-device-trust-revocation.md`,
  `docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md`. A stale file citation is
  not a false closure, but a future reader following one of these citations into `electron/sync/`
  will not find the file. Rewriting four ADR bodies to repoint the citations is out of scope here.
- **`docs/current/PLATFORM_STATE.md:846` asserts "No file under `electron/sync/automerge/rendezvous*.js`
  is imported by any running path."** Red Hat reported this is now false; independently confirmed:
  `electron/sync/automerge/syncStarter.js:33` reads
  `import { readRendezvousConfig, createRendezvousDiscovery } from './rendezvousClient.js'`, and the
  import is live code (used at line 294/297, gated on `rendezvousConfig.enabled`, not dead/commented).
  This is a fact `PLATFORM_STATE.md` gets wrong today and belongs to the `/update-state` pass, which
  is explicitly out of scope for this docs-only sweep — recorded here so it is not silently dropped.
- **Constraint 4's mandated inline comments are unmet in `electron/main.js`** (see Round 2, finding 2
  above) — a `src/`-adjacent code change (editing `electron/main.js`), out of this worker's footprint.
  Needs a Maker pass against `electron/main.js` around line 2809.
- **Open question: should `docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md` be
  `status: superseded`?** Its design targets a retired WebSocket sync layer and was never built. This
  sweep corrected only `implementation_state` (to `not-started`) and explicitly did not touch
  `status` — that is a human architecture-judgement call under `CONSTITUTION.md` Art. IV, recorded
  here for the owner.
- **`docs/adr/2026-09-16-anchor-scope-single-resolver.md`'s own H1 status line is stale** (reads
  "proposed 2026-09-16 — blocked on T180 and T182 landing on main") even though T180/T182/T183 are
  all `status: completed` and the resolver module (`src/engine/anchorScope.js`) exists —
  `implementation_state: implemented` is correct and was left unchanged, but the body's own prose
  was written before the work landed and was not updated afterward. Unlike the four stale-citation
  ADRs above, this ADR's staleness runs in the direction of *understating* its own progress, not
  overstating it — flagged here rather than silently correctable, since editing the H1 status
  sentence is a body-content change beyond this round's mapping/nuance-line scope.

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
