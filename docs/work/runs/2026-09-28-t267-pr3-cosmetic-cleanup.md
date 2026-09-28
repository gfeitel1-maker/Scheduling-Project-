---
task: T267 PR3 — cosmetic rename cleanup (discharge T293 findings B, G, H); no behavior change
document_type: run
date: 2026-09-28
round: 1
status: in-progress
task_class: documentation-governance
governing_docs:
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_tickets: [docs/work/tickets/T267-fixed-recurring-event-identity-model.md]
related_specs: [docs/work/specs/2026-09-28-fixed-recurring-activity-vocabulary.md]
related_adrs: [docs/adr/2026-09-26-fixed-recurring-event-identity-model.md]
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: "No new persistent shape, contract, or architectural decision. PR3 is pure comment/identifier cleanup; the data model is settled and shipped (PR1 #560, PR2 #597)."
  - agent: designer
    reason: not-applicable
    note: "No UI/visual/animation surface. The user-facing 'event' vocabulary naming (T293 Finding A / ADR Open Question 1) is owner-gated and explicitly OUT OF SCOPE for PR3."
  - agent: tester
    reason: not-applicable
    note: "No director-facing behavior or copy changes. PR3 touches code comments, stale version tags, and (conservatively) internal identifiers only. The existing suite passing unchanged is the proof of no-behavior-change, per ADR PR3 gate."
  - agent: security
    reason: not-applicable
    note: "No auth, PIN, secret, IPC channel, LAN protocol, or packaging change. No new attack surface. Comment/label edits only."
deterministic_checks: [agents:check, check:governance, licenses:check, build, security, integration, lint, test]
human_gates: []
verdict: null
completion_evidence: []
archive_when: T267 ticket resolved (this is the final PR of the three-PR plan)
---

# Run: T267 PR3 — cosmetic rename cleanup

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, updated as agents return.

## Brief

**Product outcome:** The residual vocabulary debt left after PR1 (table rename +
`activity_id`) and PR2 (id-based resolution cutover, #597) is discharged so no code
comment lies about the merged reality. Specifically the three T293-audit findings
PR3 owns: **B** (comments that still deny `activity_id` exists / claim resolution
is by name), **G** (residual "anchor" identifiers, *cosmetic portion only*), **H**
(stale v75 schema version tags that misdescribe the v77 reality).

**This PR changes NO behavior.** No schema migration, no engine-logic change, no
persisted value, no IPC channel, no stored nav/screen key. If a "rename" would
alter runtime behavior or stored state, it is NOT PR3 — leave it and record why.

**Success predicate:**
1. Finding B discharged: every remaining comment asserting "there is no
   `activity_id` column" or "an anchor references its activity BY NAME" is corrected
   to the merged id-based reality. (PR2 already fixed `anchorActivityLink.js` and
   `ingest.js` headers; residue confirmed in `freeChoiceActivities.js:10-11`,
   `schema.sql:~553`, `buildSchedule.js:206`.)
2. Finding H discharged: the stale `activity_id` version tag at `schema.sql:775`
   ("v75 here") is corrected to **v77** (verified: `localDb.js:34-35`, the
   `activity_id` migration is v77). The `catalog_role` "v75" tag is CORRECT
   (catalog_role genuinely shipped at v75/T266) and stays.
3. Finding G discharged conservatively: purely-cosmetic "anchor" identifiers
   (comments, test descriptions, internal-only variable names) are aligned to
   "fixed event"/"recurring event" vocabulary WHERE renaming carries no
   migration/persistence/routing risk. Everything load-bearing is left and recorded.
4. `npm run verify` is fully green (all 8 gates). `npm run check:governance` clean.
5. A grep confirms no NEW `anchor_activities` reference outside migration history,
   rollback scripts, and historical ADR/spec text.

**What does NOT count as done / MUST be left (record why):**
- **`type:'anchor'`, `is_anchor`, `anchorId`, `template_slots.anchor_id`** —
  load-bearing persisted/runtime values (T293 Finding G names these explicitly).
  Renaming = data-shape change. LEAVE.
- **Nav/screen keys `anchors` and `fixedevents`** (`src/screenKeys.js:15`,
  `navSections.js:72-73`, `readiness.js:93,174`, `rootMapNav.js`, screen
  `onNavigate('anchors')` call sites) — routing keys threaded through the SCREENS
  map, the readiness/census spine, and root-map nav. Not DB-persisted, but renaming
  is behavior-adjacent (routing + census keying) and cross-cuts the separately
  ticketed T293-b/Finding E readiness work. LEAVE; not cosmetic.
- **`anchor_activities` string literals in migration machinery** (`localDb.js`
  v42/v51/v65/v71/v73/v77 blocks + `anchorEventsTable()` helper; `schema.sql`
  historical-rename comments) — these MUST name the old table because that is what
  the table was called at those versions / because the v77 rename block's
  `ALTER TABLE anchor_activities RENAME TO fixed_events` operates on it. LEAVE
  (ADR PR3 gate: "outside rollback/, migration history, and historical ADR text").
- **Module filenames `anchorScope.js` / `anchorActivityLink.js`** — renaming files
  is wide import churn for zero behavior gain and risks touching many test imports;
  out of the "smallest safe cleanup" mandate. LEAVE unless Maker finds a purely
  local, low-churn win; record the decision either way.
- The user-facing "Recurring Events"/"Fixed Events"/"Event" display labels —
  owner-gated (T293 Finding A / ADR OQ#1). LEAVE.

## Task class and gates

`documentation-governance` spanning a touch of `scheduling-engine`/`database-sync`
(comments live in the engine and schema). Stricter gate list taken: **full
`npm run verify`** (all 8 steps, incl. `check:governance`, integration, and the
full `test` suite). `check:governance` is a first-class friend here — a descriptive
doc naming a renamed path would fail it.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing + synthesis (main loop, flat dispatch — small scope) |
| Architect | no | no predicate (settled, shipped model) |
| Designer | no | no UI surface; naming owner-gated |
| Maker | yes | the comment/identifier edits; test-first if any code identifier changes |
| Code Reviewer | yes | spec-fidelity: confirm cosmetic-only, no behavioral drift |
| Verifier | yes | deterministic full-gate evidence |
| Red Hat | yes | a "cosmetic" rename touching schema/engine identifiers is exactly where a silent behavior change hides |
| Tester | no | no director-facing behavior/copy change |
| Security | no | no auth/IPC/secret/protocol/packaging surface |
| Grader | yes | Phase 7 calibrated score from the reviewer reports |

## Rounds

### Round 1

Maker corrected the three worklist sites (freeChoiceActivities.js, schema.sql catalog_role
comment, schema.sql v75→v77 tag, buildSchedule.js:205) — all comment-only. Committed `ccf5b0f5`.
Review panel (Code Reviewer + Red Hat, foreground) then found the round-1 fix was **accurate but
incomplete and partly re-introduced a subtler falsehood**:

- **Code Reviewer (MEDIUM×2, LOW):** the corrected comments conflate two independent suppressions.
  The free-choice exclusion (`isFreeChoiceActivity`, freeChoiceActivities.js) is keyed by
  `catalog_role`; the anchor-duplicate exclusion (`anchoredActivityIdsByGroupDay` →
  `resolveAnchorActivityIds`, buildSchedule.js) is keyed by `activity_id`. Round-1's "both
  suppressions resolve through that id" is false — the row stays for two reasons via two different
  keys.
- **Red Hat (HIGH, MEDIUM, LOW):** Finding B not exhaustively discharged. Two more now-false sites
  survive: `src/ingest/buildPlan.js:391-392` ("resolves its activity BY NAME") and
  `src/engine/buildSchedule.test.js:41-55` (comment claims "fixed_events has never had activity_id /
  no activity link / by NAME / exclusion never fires" while the fixture two lines below sets
  `activity_id: 'lunch'` — internally self-contradictory post-PR2).

Governor independently verified the mechanism (buildSchedule.js:177 `resolveAnchorActivityIds`
returns `[activity_id]`; freeChoiceActivities.js `isFreeChoiceActivity` reads `catalog_role`), and
found two further stale sites in the same sweep: `buildSchedule.js:93-94` and `:243-244` ("keyed by
NAME") are also false. All are Finding B comment residue. Both reviewers correct → RETRY round 2.

### Round 2

Maker re-dispatched with the exact accurate mechanism and the full site list.
