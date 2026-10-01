---
task: Retired WebSocket Host/sync vocabulary — sweep the remainder T311 left behind (comment and doc prose only)
document_type: run
date: 2026-10-01
round: 1
status: escalated
task_class: documentation-governance
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_tickets:
  - docs/work/tickets/T311-retired-ws-host-comment-sweep.md
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: "No persistent data shape, no contract, no reversibility tradeoff — comments only."
  - agent: designer
    reason: not-applicable
    note: "No UI surface touched; the only src/ edits are comment lines."
  - agent: tester
    reason: no-predicate
    note: "Zero behaviour change by construction; there is nothing a director could observe."
  - agent: security
    reason: not-applicable
    note: "No auth, secret, PIN, transport, IPC or packaging surface changed; comment bytes only. NOTE: the run surfaced one finding (transport.js's first-pairing admitPeer argument losing its parity comparison) that may warrant Security's judgement as a follow-up — see Findings carried forward #4. Nothing was changed there beyond re-framing the retired comparison."
deterministic_checks:
  - "no-executable-change diff proof (per-file, all .js/.jsx/.mjs/.sql touched)"
  - "npx eslint electron src scripts test"
  - "npm run build"
  - "npm run check:governance"
  - "npx vitest run electron/db/rollback/bareEqualityRollback.guard.test.js electron/db/rollback/rollbackIdentity.guard.test.js no-literal-nul.test.js test/governance.test.js + every *.test.js the sweep touched"
  - "independent re-run of the before/after framing audit"
human_gates: []
verdict: ESCALATE (Verifier PASS on the deterministic layer; Grader FAIL on comment truth)
completion_evidence:
  - "espree token-stream comparison, base 4096f670 vs HEAD 307fda09: files=30 nonIdentical=0 parseErrors=0"
  - "npx eslint electron src scripts test: 0 errors, 26 pre-existing warnings"
  - "npm run build: exit 0"
  - "npm run check:governance: 0 blocking, 1 advisory (platform-state-stale, pre-existing)"
  - "guard tests 55/55; all 10 touched test files 282/282"
  - "framing audit re-run matched the AFTER table exactly; plant A caught as UNFRAMED"
archive_when: the remainder sweep has merged and no further retired-vocabulary board item is open
---

# Run: retired WS Host/sync vocabulary — the remainder

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

Board item `q-retired-vocab-sweep-remainder`; owner ruling 2026-10-01, verbatim: "yes". No ticket
number was allocated and none is to be (board note). No `closes T<n>` in any commit.

## Brief

**Product outcome:** a reader — human or agent — who opens any file under `electron/`, `src/`,
`scripts/` or `test/` and meets the words `syncServer.js`, `handleSubmitOp`, `sendMissedOps`,
`sendFullSyncIfFirstPairing`, `authorizeWs`, `handleBulkReplace`, `submit_op`, `op_applied`,
`acquire_lock`, `full_sync` or `syncClient` can tell at that point whether they are reading about
live code or about an architecture the app retired at the Stage 6 cutover. T311 established the
convention on 31 files; this run finishes the set.

**Success predicate:** after the sweep the framing audit reports **zero UNFRAMED matches** outside
the two deliberately excluded files (`scripts/check-governance.js`,
`scripts/checkDocFileRefs.test.js`) and `docs/current/PLATFORM_STATE.md`'s historical regions; every
LIVE-IDENTIFIER match is listed in this record together with the definition that proves it live; the
no-executable-change proof is empty for every file touched; all named gates exit 0.

**What does not count as done:**

- Deleting a comment to drive the count to zero when that comment carried a reason
  (`WORK_RECORD_STANDARD.md` §2 — never delete reasoning).
- A rewritten comment that is free of the old words but says something false about the code.
- Any non-comment byte changed: a string literal, a template literal, a JSX text node, SQL DDL, or
  a test title.
- Re-framing a mention that is actually describing something **live** as though it were retired.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `WORK_RECORD_STANDARD.md` (this record), `TESTING_STANDARD.md` (gate scoping) |
| Mandatory gates | lint, build, `check:governance`, the named guard tests, plus the task-specific no-executable-change proof |
| Human gate | none — comment/doc only, no schema, no behaviour, no security surface |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | not-applicable — no data shape, contract, or irreversible tradeoff |
| Designer | no | not-applicable — no UI surface; `src/` edits are comment lines only |
| Maker | yes | writes the audit script, then the rewrites, commit per directory |
| Code Reviewer | yes | spot-check 20 rewritten comments for TRUTH, not just absence of the old words |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no-predicate — zero behaviour change by construction |
| Security | no | not-applicable — no auth/secret/transport/IPC/packaging change |
| Red Hat | yes | the live/retired mis-framing trap is exactly its hunt |
| Grader | yes | scores the opinion reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Census before the sweep

Pattern: `sendMissedOps|sendFullSyncIfFirstPairing|authorizeWs|handleBulkReplace|submit_op|op_applied|acquire_lock|full_sync|syncClient|syncServer\.js|handleSubmitOp`
over `electron/ src/ scripts/ test/` (`*.js *.jsx *.mjs *.sql`), minus the two excluded files.

- 73 files, 244 raw matching lines.
- 43 of those files were **not** touched by T311's sweep commit `b7236c28` (~96 matching lines);
  the other 30 were, so most of their matches already sit inside `_Prior:` blocks.
- 7 matching lines are **not** comments at all: six `it()`/`describe()` titles and nothing else.
  Those are string literals in executable code and are therefore out of scope for a comment-only
  change. See "Findings carried forward".

### The audit script

Read-only, not committed (it is a measurement tool, not product code). It lives in
the run's scratchpad:

```
node <scratchpad>/framingAudit.mjs . --json <scratchpad>/after.json
```

run from the worktree root. It classifies every matching line on two independent
axes, which is the thing a `grep -c` cannot do:

- `lineKind` — `FULL-COMMENT` / `TRAILING-COMMENT` / `NON-COMMENT`. Only
  `FULL-COMMENT` is editable under the zero-executable-change rule, so the **work
  list is `UNFRAMED ∧ FULL-COMMENT`**, not UNFRAMED alone.
- `framing` — `LIVE-IDENTIFIER` / `FRAMED` / `UNFRAMED`, first match in that order.

Framing window: the **enclosing comment block** (the maximal run of consecutive
full-comment lines, or the `/* … */` block) wherever the match sits in a comment
line; a ±3-line window otherwise. The script prints which it used per match
(`block:79-84` vs `window:…`), so the choice is auditable rather than asserted.

Two corrections were made to the detector **before** the BEFORE run, both found by
checking a surprising result instead of recording it:

1. **Markers wrapped across a line break were missed.** `schema.sql` reads
   `A device row existing no` / `-- longer implies it may log in`; joined raw, that
   contains `no\n  -- longer`, never `no longer`. The window is now stripped of
   comment leaders and whitespace-collapsed before matching.
2. **`prior:` rather than `_prior:`** in the marker list. `_Prior:` contains it, so
   every site the brief meant still matches, and it additionally matches T311's own
   convention inside `schema.sql`, which writes a bare `(prior: X, gone)` because
   markdown underscores read badly in SQL. Nothing else was widened — `gone` and
   `vestigial` are deliberately **not** markers.

Without those two fixes, four `schema.sql` sites T311 had **already framed
correctly** reported UNFRAMED, and a sweep would have churned them — in the one
file whose line count is pinned. This is the detector being wrong, not the prose.

### Audit tables — BEFORE and AFTER

Totals over `electron/ src/ scripts/ test/` (`*.js *.jsx *.mjs *.sql`), minus the
two excluded files:

| | files | raw lines | LIVE | FRAMED | UNFRAMED | **work list** |
|---|---|---|---|---|---|---|
| BEFORE | 73 | 251 | 39 | 161 | 51 | **39** |
| AFTER | 64 | 238 | 52 | 179 | 7 | **0** |

Raw count barely moves (251 → 238) and that is expected: a `_Prior:` block quotes
the old text, so the retired words stay on the page by design. Framing is the
metric. The 7 residual UNFRAMED are all `NON-COMMENT` — string literals in
executable code, listed under "Findings carried forward".

The owner's pre-measurement was 73 files / **244** raw lines; this script counts
**251**. The file count agrees exactly; the 7-line difference is a counting-rule
difference, not a disagreement about what matches, and 7 is also the number of
non-comment matches — the most likely explanation is that the owner's count
excluded them. Recorded rather than reconciled away.

Per-file, for every file with any BEFORE UNFRAMED (30 files):

| file | B:LIVE | B:FRAMED | B:UNFR | B:work | A:LIVE | A:FRAMED | A:UNFR | A:work |
|---|---|---|---|---|---|---|---|---|
| `electron/auth/localAuth.test.js` | 0 | 0 | 4 | 4 | 0 | 2 | 0 | 0 |
| `electron/db/rollback/v35_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/db/rollback/v42_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/db/rollback/v43_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/db/rollback/v44_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/db/rollback/v45_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/db/rollback/v51_down.js` | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `electron/fixtures/electiveAcceptanceCamp.js` | 0 | 0 | 1 | 1 | 1 | 1 | 0 | 0 |
| `electron/ops/campMapsRegistries.test.js` | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `electron/ops/electivesRegistries.test.js` | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `electron/ops/materializeImportedVersion.js` | 0 | 0 | 7 | 2 | 6 | 0 | 0 | 0 |
| `electron/ops/materializeImportedVersion.test.js` | 0 | 0 | 2 | 2 | 1 | 1 | 0 | 0 |
| `electron/ops/projectionRepair.js` | 0 | 0 | 1 | 1 | 0 | 1 | 0 | 0 |
| `electron/ops/projectionRepair.test.js` | 0 | 0 | 2 | 2 | 0 | 3 | 0 | 0 |
| `electron/ops/projections.test.js` | 0 | 0 | 1 | 1 | 0 | 1 | 0 | 0 |
| `electron/ops/projectionsCoverage.test.js` | 0 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| `electron/ops/restore.test.js` | 0 | 2 | 1 | 1 | 0 | 3 | 0 | 0 |
| `electron/ops/specialDaysRegistries.test.js` | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `electron/sync/automerge/joinSession.js` | 0 | 1 | 2 | 2 | 0 | 3 | 0 | 0 |
| `electron/sync/automerge/joinSession.test.js` | 0 | 0 | 2 | 2 | 0 | 2 | 0 | 0 |
| `electron/sync/automerge/syncNodeRemoteOps.test.js` | 0 | 0 | 2 | 1 | 0 | 0 | 1 | 0 |
| `electron/sync/automerge/transport.js` | 0 | 0 | 1 | 1 | 0 | 1 | 0 | 0 |
| `electron/sync/rateLimit.js` | 0 | 0 | 2 | 2 | 0 | 1 | 0 | 0 |
| `src/hooks/useDeviceMode.js` | 0 | 0 | 1 | 1 | 0 | 1 | 0 | 0 |
| `src/hooks/usePendingConflicts.js` | 0 | 2 | 2 | 2 | 1 | 2 | 0 | 0 |
| `src/screens/ConflictsScreen.test.jsx` | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `src/screens/ScheduleScreen.jsx` | 0 | 0 | 3 | 3 | 3 | 1 | 0 | 0 |
| `src/screens/ScheduleScreen.test.jsx` | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 |
| `src/screens/conflictsNotice.js` | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 |
| `test/integration/scenarios/14-corrupt-payload.automerge.js` | 0 | 0 | 2 | 2 | 0 | 2 | 0 | 0 |

### Six sites the audit did NOT find — false FRAMED

The marker window suppresses a real finding when an **unrelated** marker sits
inside the same comment block. These six were found by reading every file T311
never touched and checking its FRAMED verdicts by hand, not by trusting the
script, and all six were fixed:

| site | the marker that falsely framed it | what it actually meant |
|---|---|---|
| `electron/db/rollback/v46_down.js` | `no longer` | "code which no longer references either table" |
| `electron/db/rollback/v53_down.js` | `retired`, `no longer` | the **overlay subsystem** was retired, not syncClient.js |
| `electron/ops/deleteWeek.js` | `deleted` | the module's whole subject is deleting a week |
| `electron/automerge/parentScoped.test.js` | `historical` | "unbounded **historical growth** over a season" |
| `electron/automerge/docNativeEnsureExists.test.js` | `stage 6` | framed a different, neighbouring claim |
| `electron/automerge/campDocument.js` | `removed`,`no longer`,`deleted` | a long block discussing other removals |

This is the same over-suppression T311's own commit message recorded ("a
standalone 'Stage 6c' frames an unrelated neighbouring claim"). **The audit's zero
is necessary, not sufficient** — it proves no UNFRAMED remains, not that every
FRAMED verdict is honest. The hand-check of the never-touched files is what covers
the second half, and it is the part a re-run will not reproduce.

## Live identifiers (must NOT be framed as retired)

Each proved by reading the definition site, not inferred. These are the sites
where getting it backwards would have been the worst outcome of the run.

| identifier | status | proving site | disposition |
|---|---|---|---|
| `syncClient` | **LIVE** — a local variable, not the deleted module | `electron/main.js:383` `let syncClient = null`, assigned at `981`/`1009` to `createLocalWriteClient`, defined at `electron/sync/localWriteClient.js:69`; called at `1353`/`1455` | never framed as retired; kept wherever it names this variable |
| `op-applied` / `onOpApplied` | **LIVE** IPC event and preload method | `electron/preload.js:16-19` (`ipcRenderer.on('shoresh:op-applied', …)`); returned surface at `electron/sync/localWriteClient.js:153` | `op_applied` (underscore) corrected **to** this spelling wherever it meant the live event |
| `syncClient.onOpConflict` | **LIVE** | `electron/main.js:414-415` | `src/hooks/usePendingConflicts.js:87` left untouched |
| `syncClient.write()` statuses | **LIVE** | `electron/main.js:1353`, `1455` | `src/screens/conflictsNotice.js:1` left untouched |
| `syncClient` as a **parameter name** | **LIVE** — this module's own signature | `electron/ops/materializeImportedVersion.js:43` | JSDoc `@param` left untouched; renaming it would be an executable change |
| `wireOpApplied` | **LIVE** | `electron/main.js:387` | named in the rewritten ScheduleScreen chain |
| `LOGIN_MIN_INTERVAL_MS`, `PAIRING_RATE_MS` | **LIVE** under libp2p | consumed at `electron/sync/automerge/authGate.js:322` and `:269`, imported at `:42` | `rateLimit.js` rewritten to its live consumer, **not** framed as retired |
| `repairProjectionForEntity` | **LIVE**, exactly one caller | `scripts/mcp/tools.js:542` | caller census corrected; the second caller it claimed is genuinely gone |
| `syncServer.js`, `syncClient.js` | **GONE** | `find electron src scripts test -iname 'syncServer*' -o -iname 'syncClient*'` → empty | framed `_Prior:` |
| `applyRemoteOp`, `submit_op`, `full_sync`, `handleSubmitOp`, `sendMissedOps`, `sendFullSyncIfFirstPairing`, `authorizeWs`, `handleBulkReplace`, `acquire_lock` | **GONE** — no non-comment definition anywhere | pattern grep over all four roots returns only comments and test titles | framed `_Prior:` |

### Every ambiguous `op_applied`, and the decision made

`op-applied` (hyphen) is the live IPC event; `op_applied` (underscore) was the
retired WS wire message. Each site was decided by reading what the comment
claims, per the brief's rule that a comment describing something LIVE gets
corrected to the live name rather than framed as retired.

| site | decision | why |
|---|---|---|
| `src/screens/ScheduleScreen.jsx:471-472` | **LIVE** → corrected to `op-applied`; only the "server broadcasts" middle framed prior | describes the renderer event this `useEffect` subscribes to |
| `src/hooks/usePendingConflicts.js:78` | **LIVE** → `op-applied` | names the live reconciliation fetch |
| `src/screens/ScheduleScreen.test.jsx:306` | **LIVE** → `op-applied` | the event that fires `loadAll()` in the running app |
| `src/screens/ScheduleScreen.test.jsx:601` | **LIVE** → `op-applied` | the comment itself says "same path as the real `shoresh:op-applied` IPC event" |
| `electron/sync/automerge/syncNodeRemoteOps.test.js:4` | **LIVE** → `shoresh:op-applied`-shaped | `docDiffEvents.js:3` describes exactly this shape as what `shoresh:op-applied` consumers parse |
| `electron/ops/projectionRepair.test.js:7` | **RETIRED** → framed `_Prior:` | names "a real op_applied **message**" in a sentence about the deleted `applyRemoteOp` and a test file that no longer exists |
| `electron/sync/rateLimit.js:19` | **RETIRED** → framed `_Prior:` | "op_applied **broadcasts**" — a WS fan-out that has no successor |

The split is 5 live / 2 retired, and in every case the deciding evidence was the
surrounding claim, not the token.

### One correction to the brief

The brief requires `electron/db/schema.sql` to be **exactly 1676 lines**. It is
**1882**, and was 1882 on `origin/main` before this run — the file has grown since
T311 pinned it at 1676. Nothing here touched it: after the detector fix it had
**zero** work items, and `git diff -- electron/db/schema.sql` is empty. The
constraint's intent (do not shift the five live `schema.sql:NNN` citations) is
satisfied absolutely, by not editing the file at all. The 1676 figure is stale and
should not be carried into the next brief.

## Gates

All diffs pinned to the branch base **`4096f670`**, not `origin/main` — origin/main gained
`55d7ebb3` (#689) mid-run and would have shown ten unrelated files as spurious diffs.

| Gate | Result | Evidence |
|---|---|---|
| no-executable-change diff proof | PASS | 30 `.js/.jsx/.mjs/.sql` files, 0 non-comment changed lines. Prefix filter **plus** an independent parser-level close of its blind spot: `espree` 10.4.0 token-stream comparison of base vs HEAD, `files=30 nonIdentical=0 parseErrors=0`, with a sentinel injection confirming the comparison can fail. No `{/*` or `*/}` delimiter line changed. `electron/db/schema.sql` absent from the diff, 1882 lines |
| `npx eslint electron src scripts test` | PASS | exit 0 — 0 errors, 26 pre-existing `react-hooks/exhaustive-deps` warnings on untouched screens |
| `npm run build` | PASS | exit 0 |
| `npm run check:governance` | PASS | 0 blocking, 1 advisory (`platform-state-stale`, pre-existing and not caused by this sweep) |
| named guard tests + touched test files | PASS | `bareEqualityRollback.guard` + `rollbackIdentity.guard` + `no-literal-nul` (repo root) + `test/governance`: 55/55. All 10 touched test files, derived from the diff rather than from the Maker: 282/282 |
| audit re-run (independent) | PASS, bounded | Matched the AFTER table on all six numbers (64 / 238 / 52 / 179 / 7 / 0); the 7 residual UNFRAMED are all non-comment string literals. **Non-vacuity:** plant A (unframed retired mention, on a scratch copy) was correctly caught UNFRAMED, so the audit can fail; plant B (retired mention in a block holding a framing marker present for an unrelated reason) was classified **FRAMED** — measured confirmation of the false-FRAMED weakness, not a refutation of it |

**No `npm run gate` stamp exists for this run** — the brief forbade `npm run verify`, so the PASS
above is an assembly of nine individual exit codes rather than one commit-bound artifact. That is
the pattern memory `feedback_never_assemble_a_gate_verdict` warns about. It did not change the
verdict here, and CI remains the gate of record.

## Verifier verdict

**PASS** — on the deterministic layer only. Every machine-checkable claim in the success predicate
traces to a check that was run and read. Four disclosures stated rather than absorbed: (1) the
literal predicate says "zero UNFRAMED" while the measured value is 7, all non-editable string
literals — referred to Grader as a wording question and read by Grader as satisfied on its own
terms; (2) the worktree `node_modules` is empty and all gates resolved up to the main checkout's,
mitigated by confirming this branch's `package.json`/`package-lock.json` are byte-identical to
main's and untouched by the sweep; (3) plant B shows the audit's green means "no UNFRAMED editable
comment remains *as this detector defines framing*", which is strictly weaker than "every retired
mention is correctly framed"; (4) the full suite and `test:integration` were not run (excluded by
brief), with the zero-token-change proof offered as the reason no runtime behaviour can differ.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

**Average 2.0, lowest dimension 2. FAIL.** (Verifier's PASS is not a score and is not averaged.)
Code Reviewer 2, Red Hat 2; Security and Tester N/A as pre-dispatch omissions.

Grader confirmed every load-bearing reviewer finding **in the tree** and applied the brief's own
"NOT done" disqualifier — *a rewritten comment that is false* — as written. Its justification, which
is the substance of the escalation:

> The mechanical half of this sweep is the best-executed part of it — zero executable bytes changed,
> proven twice over at the diff and the parser level with a validated sentinel, no forbidden file
> touched, every plan constraint confirmed, and `rateLimit.js` is a genuinely exemplary rewrite. But
> the only product of a comment-only sweep is comment truth, and this one shipped four comments that
> are false about live code as it stands today. [...] The first and third were *added* by this sweep,
> not inherited — the previous text made no such claim — so the work replaced stale comments with
> confidently wrong ones, which is strictly worse for the next reader than the staleness it set out
> to fix.

**No `GateReport` was persisted.** `scripts/gateReportCli.js` exited 1: opinion-report provenance is
unsatisfiable for a Grader dispatched at spawn depth 2 in this harness version, because
`scripts/observeRun.js`'s two accepted resolution shapes (a `type:"user"` record with
`toolUseResult.agentId` + `status`, or a `type:"attachment"` with `attachment.type === "task_status"`)
are both absent from the dispatching transcript — 1 `toolUseResult` record and 0 `task_status`
attachments across the whole file, with the launch acks appearing only as prose. Grader declined to
call `reduceGateReport` directly to route around the guard. **The gate stack therefore cannot
currently produce its own typed record of a nested round** — an owner-visible item independent of
this feature.

> A Grader FAIL ends the loop and escalates to the user. It never becomes another round
> (`CONSTITUTION.md` Article VII, owner ruling 2026-10-01).

## Directed resolution (owner ruling)

The owner read the escalation above and issued a directed resolution rather than
authorising a round 2. Verbatim, board item `q-retired-vocab-sweep-remainder`,
2026-10-01:

> you tell them what to do with reference to the sweep of old vocab. i want this done.

The organizer's directed option, which the owner accepted, was option **(a)**: fix
the four false comments **plus** `electron/sync/automerge/syncEngineFlag.js`. "Done"
means **zero comments that describe the retired layer as live**. The seven remaining
string-literal occurrences **stay** — they are executable code, and changing them is
outside a comment-only sweep.

**This is not a round 2.** `round` stays **1**. A Grader FAIL ended the loop; what
follows is the execution of a human instruction, and the Gates table, Verifier
verdict, Grader score and Decision above are left exactly as the reviewers wrote
them.

**Base for this correction: `4fccca2e`.** The branch was rebased onto `origin/main`
before the work; the nine prior commits replayed cleanly. The framing audit was
re-run after the rebase to check whether the new main commits had changed the corpus:
they had not. Pre-rebase and post-rebase runs are **identical** — 64 files, 238 raw
matches, LIVE 52 / FRAMED 179 / UNFRAMED 7, work list **0**, and the per-(file,
bucket) multiset compares equal. The AFTER table above therefore still stands
unchanged, which is expected: all five corrected sites were already counted FRAMED
(a `_Prior:` block frames the line regardless of whether the surrounding sentence is
*true*), so correcting a false sentence cannot move a framing number. That is the
clearest statement of the audit's limit — **it measures framing, never truth** — and
is why these five were found by reading code, not by the script.

### The five edits

Each was verified by opening the code it describes, after the rebase, before a word
was written. Where the truth is "nothing enforces this", the comment now says that.

| # | site | what it now says | the code fact |
|---|---|---|---|
| 1 | `src/screens/ScheduleScreen.jsx` | The remote route covers **small merges only**: `dispatchRemoteOps` sends one `shoresh:op-applied` per field only at or below `REMOTE_OPS_COALESCE_THRESHOLD` (20); above it, a single `shoresh:full-sync-applied`. This screen subscribes to `onOpApplied` and nothing else, so a catch-up merge from an offline device delivers no event here and no reload — named as a **real gap**, with the `syncStarter.js` hop that owns the threshold added to the chain | `startupGuard.js`'s `dispatchRemoteOps` returns after the single `full-sync-applied` send above threshold; `onFullSyncApplied` exists in `src/localClient.js` and `electron/preload.js` and is never called by this screen; the dispatch call site is `syncStarter.js`'s `onRemoteOps` handler |
| 2 | `electron/ops/deleteWeek.js` | `HOST ONLY` is marked **VOID**: nothing enforces it. The handler gates on the admin **role** alone and the delete **executes on whichever device the director is using**. Also: the op log does not replicate (appendOp's document mirror does), and nothing **broadcasts** the returned ops | `deleteWeekHandler` calls `requireAuthorized(..., 'schedule_weeks.delete')` and nothing else; no device-role gate is enforced anywhere under `electron/` or `src/`; `deleteRecord.js` records the same resolution; the handler returns only `ops_written: ops.length` |
| 3 | `electron/ops/projections.test.js` | The old consequence is **false on both live paths**, so each is named: locally the `operations` insert and `applyProjection` share one transaction, so the FK throw **rolls the op row back** — nothing is recorded; on document replay there is **no op-log insert at all** | `appendOp` runs `body()` under `db.transaction` (or the enclosing `runAtomic` boundary when nested); `operations.js` states the no-insert precondition for the projector path explicitly |
| 4 | `src/hooks/useDeviceMode.js` | `syncStarter.js`'s `onAuthRejected` handler performs the `shoresh:auth-rejected` send **itself**; `main.js` is named, in one clause, as a **separate** sender on the same channel with a different trigger (T228 locally-invalid sessions) | both sends exist and differ: `syncStarter.js`'s is inside the peer `onAuthRejected` handler, `main.js`'s is inside the `SESSION_INVALID_REASONS` branch of `requireAuthorized`. The `codeForAuthRejectedReason` mapping half of the old claim was correct and is kept |
| 5 | `electron/sync/automerge/syncEngineFlag.js` | Marked **VOID**: there is no WS layer and no second engine to fall back onto. Selecting `oplog` today means writes land in local SQLite and the op log and **nothing replicates, with no error raised** — a silent single-device island until the variable is unset and the app restarted | `appendOp` and `appendBulkReplaceOp` early-return on `isOpLogEngine()` stamping `DOCUMENT_OUTCOME='engine-off'`; `syncStarter.js` returns on `!isAutomergeEngine()` and never starts a sync node; the value is read once at import |

Edit 5 is the **owner-named addition**, not one of the four false comments, and is
committed separately for that reason. It is also the clearest case of the audit's
blind spot: `syncEngineFlag.js` **never appeared in the audit at all**, because its
retired vocabulary is the phrase "the WS layer", which is not one of the detector's
narrow identifier markers. A header can promise a deleted subsystem as a recovery
route and score clean.

No reasoning was deleted in any of the five (`WORK_RECORD_STANDARD.md` §2). Each
prior reason is carried and corrected, and the two genuinely void claims (edits 2 and
5) use T311's `⚠️ _Prior, and VOID` marker rather than the plain `_Prior:` form.

### Gates for this correction

Run in the foreground; raw output read, not assembled into a verdict.

| Check | Result |
|---|---|
| espree token-stream comparison vs `4fccca2e` | `files=31 nonIdentical=0 parseErrors=0` |
| comment-prefix proof over every changed `.js/.jsx/.mjs/.sql` | no output. The matcher carries a self-test that **rejects** a planted non-comment line and accepts all five comment forms, so a silent run is evidence rather than a possibly-broken filter — the first attempt at this script was silently inverted by a zsh pattern bug and flagged every comment line, which is how the self-test came to exist |
| `npx eslint electron src scripts test` | exit **0** — 0 errors, 26 pre-existing warnings on untouched screens |
| `npx vitest run --no-file-parallelism electron/ops/projections.test.js src/screens/ScheduleScreen.test.jsx` | exit **0** — 2 files, **126/126** passed |
| `npm run check:governance` | exit 0 — **no blocking findings**; 1 pre-existing advisory (`platform-state-stale`) |
| `git status --short` | clean |

`npm run verify` and the full `npm run test` were excluded by the brief; CI remains
the gate of record.

## Blocking findings (confirmed in the tree by Grader) — ALL ADDRESSED 2026-10-01

Each was independently opened against the code, not accepted from a report.

**Status: findings 1-4 and both half-finished headers below were corrected under the
owner's directed resolution above. They are kept in full, not deleted, because the
finding is the reasoning for the correction (`WORK_RECORD_STANDARD.md` §2) — read each
one as the diagnosis, and the "five edits" table above as what was done about it. One
item listed here was NOT in the directed scope and remains open: `projectionRepair.test.js`
still points at "applyRemoteOp's own existing catch comment" fifteen lines under a line
stating `applyRemoteOp` was deleted. The owner's option (a) named four comments plus
`syncEngineFlag.js`; this was not among them and was deliberately not swept in.**

1. **`src/screens/ScheduleScreen.jsx:471-475` — FALSE, and *added* by this sweep.** The new text
   says the remote-write path reaches the renderer because `startupGuard.js` "sends
   `shoresh:op-applied` per field" and "the event already fires naturally on both paths".
   `electron/sync/automerge/startupGuard.js:33-36` sends it per field **only** while
   `events.length <= REMOTE_OPS_COALESCE_THRESHOLD` (20); above that it sends a single
   `shoresh:full-sync-applied` and returns. `ScheduleScreen.jsx:501-508` subscribes to
   `onOpApplied` and nothing else — `onFullSyncApplied` exists (`src/localClient.js:318`,
   `electron/preload.js:36-39`) and ScheduleScreen never uses it. So the catch-up merge the
   threshold exists for produces no event and no reload. The `_Prior:` block at `:477-481` shows
   the superseded comment made no remote-path claim at all. The chain also omits the hop that owns
   the threshold, `electron/sync/automerge/syncStarter.js:323-340`.
   *Underlying product gap (not a comment fix): no renderer subscribes to `shoresh:full-sync-applied`.*
2. **`electron/ops/deleteWeek.js:7-9` — FALSE, and *added* by this sweep.** It asserts a `HOST ONLY`
   access gate and names a "surviving reason" for it. No mode gate exists:
   `deleteWeekHandler` (`electron/main.js:1906`) enforces only the admin **role**
   `schedule_weeks.delete`, and a negative search for `isHost|HOST_ONLY|hostOnly|host_mode` over
   `electron/ src/` returns only `Sidebar.jsx`'s `isHostNotSyncing` UI label. The sibling file the
   comment cites as precedent, `electron/ops/deleteRecord.js:29-34`, carries T311's **opposite**
   resolution verbatim: "the delete executes on whichever device the director is using." Cost: a
   reader concludes a joined device cannot destroy a week; any device with an admin PIN can, on the
   app's largest irreversible, non-restorable action.
3. **`electron/ops/projections.test.js:688-692` — FALSE.** "the throw leaves the op recorded while
   the exclusion silently never materializes" describes the retired mechanism's outcome. Today
   `electron/ops/operations.js:294-319` runs the `INSERT INTO operations` and `applyProjection` in
   one `db.transaction(body)()`, so the throw rolls the op row back; and on the remote path
   `operations.js:516-517` states there is no op-log insert at all. The sweep deleted the mechanism
   and kept the consequence — precisely the failure T311's own ticket warns about.
4. **`src/hooks/useDeviceMode.js:179-180` — wrong sender (HIGH; Grader kept it below BLOCKING).**
   It names `main.js` as sending `shoresh:auth-rejected` for the Host-rejection path.
   `electron/sync/automerge/syncStarter.js:399` does that send itself; `electron/main.js:179` is a
   separate, unrelated sender for locally-invalid sessions (T228). The `authRejectedSender.js`
   mapping half of the claim is correct. Grader notes that if the owner reads the disqualifier as
   *any* false sentence, this is a fourth blocker rather than a different outcome.

Two further sites the sweep left half-finished in headers it otherwise rewrote:
`electron/ops/deleteWeek.js:4-5` still reads "every delete routed through the op-log **so it
replicates**" — the exact premise `CLAUDE.md`'s op-log rule forbids, and the premise this same run
corrected 20 lines of prose about in `materializeImportedVersion.js` — and `:39` says the caller
will "broadcast" ops, which nothing does (`main.js:1917` only counts them).
`electron/ops/projectionRepair.test.js:25` still points at "applyRemoteOp's **own existing** catch
comment", 15 lines under a new line stating `applyRemoteOp` was deleted.

## The audit's construction flaw (Red Hat, confirmed)

The census pattern is an **identifier** regex, so prose-only descriptions of the retired
architecture — "the WS layer", "the WS transport", "the WS path" — were never in the 73-file corpus
at all. "Zero UNFRAMED" is literally true and understates the remaining surface. Three such claims
survive unframed and in the present tense, **two of them in files this diff edited**:
`electron/sync/automerge/joinSession.js:268`, `src/hooks/useDeviceMode.js:94`, and
`electron/sync/automerge/syncStarter.js:345` (the drifted half of a sentence
`electron/sync/automerge/syncNode.js:497-501` already frames as `_Prior:` — memory
`feedback_dedup_the_half_that_drifted`). Neither T311's 35 files nor this sweep's 30 include
`syncEngineFlag.js` or `syncStarter.js`; nothing flagged them.

**The most operationally dangerous sentence that blind spot still holds** —
`electron/sync/automerge/syncEngineFlag.js:10-13`, pre-existing and **outside this diff** — says
"the WS layer and op-log are both still present to fall back onto. Nothing is deleted until 6c/6d."
6c happened. With `SHORESH_SYNC_ENGINE=oplog`, `appendOp` early-returns at
`electron/ops/operations.js:327-331` stamping `engine-off` and never mirrors into the document, and
`syncStarter.js:124` (`if (!isAutomergeEngine()) return`) never starts a sync node. A device flipped
to `oplog` on the strength of that comment becomes a silent single-device island: writes land in
local SQLite, nothing replicates, no error is raised. This needs its own item; it must not be
smuggled into this round.

## Findings carried forward

Nothing here was fixed; each is a code, product or test change a comment sweep
must not make. Recorded per the owner's standing scope-discipline rule (board
`i-standing-scope-discipline`), not dispatched.

1. **Seven retired-vocabulary mentions are string literals in executable code**
   and are out of scope by construction — editing them would break the
   zero-executable-change proof. They are the residual UNFRAMED count:
   - `electron/ops/campMapsRegistries.test.js:38`,
     `electron/ops/electivesRegistries.test.js:35`,
     `electron/ops/specialDaysRegistries.test.js:28` — three identical `it()`
     titles, `'is a direct-camp-scoped entity (list() + first-pairing full_sync)'`.
   - `electron/sync/automerge/syncNodeRemoteOps.test.js:103` — `it()` title saying
     `op_applied-shaped`, while the file header one line above now says
     `shoresh:op-applied`-shaped. **The title and its own header now disagree**,
     which is the least comfortable residue of this run.
   - `src/screens/ConflictsScreen.test.jsx:66` — `describe()` naming
     `syncClient.write`, which is LIVE, so this one is merely imprecise.
   - `electron/ops/projectionsCoverage.test.js:306`, `:311` — column-documentation
     **strings** in a coverage table; `:311` says a dead column was never read
     "besides raw replication in syncClient.js", which is now a claim about a
     deleted module inside a data literal.
   Renaming a test title is a one-line change but it is executable; it wants its
   own commit under a normal (non-comment-only) brief.

2. **`repairProjectionForEntity` has no automatic trigger.** Its pre-cutover
   caller was "the automatic post-catch-up trigger in `electron/sync/syncClient.js`"
   and nothing replaced it. The only caller today is `scripts/mcp/tools.js:542`,
   behind `--allow-write`. So a projection that falls out of step on a device
   stays out of step until a human points the MCP surface at it. The comment now
   says this; whether it should be re-triggered automatically is a product
   decision. **This is the most consequential thing the sweep surfaced.**

3. **`deleteWeek.js`'s HOST-ONLY gate has lost half its justification.** One of
   its two reasons was "a Client cannot express a multi-op atomic transaction over
   `submit_op`", which is void — every device runs the same local write path now.
   The other (a delete executing against a count the director was shown earlier)
   survives. Identical in shape to T311's finding 4 about `ingestCommit`, and the
   two should probably be judged together.

4. **`transport.js`'s first-pairing admitPeer argument has lost its parity
   comparison.** Its "WHY IT IS ACCEPTABLE" half rested on being "the same anchor
   the WS path already relies on". With that path deleted there is no live
   counterpart, so the admission now stands on the three human-anchor facts alone.
   The comment says so. Whether those three suffice is a **security** judgement
   this run did not make and had no mandate to make — it is the one finding here
   that plausibly wants the Security agent rather than the owner.

## Open points (owner unavailable 2026-10-01)

- `electron/db/schema.sql` is 1882 lines, not the 1676 the brief pins; it was
  already 1882 on `origin/main`. The file was not touched. The stale figure should
  be corrected at its source before the next brief quotes it.
- The commit attribution line: the brief asked for
  `Co-Authored-By: Claude Fable 5.1`. The session's own attribution instruction
  names `Claude Opus 5 (1M context)`, which is also the model that did the work.
  Used the accurate one; flagging rather than silently choosing.
- `origin/main` moved during the run (gained `55d7ebb3`, #689). The branch base is
  `4096f670`. The no-executable-change proof must therefore be run against
  `4096f670`, not a live `origin/main`, or #689's ten files appear as spurious
  diffs. Noted for Verifier.
- Whether the three identical `full_sync` `it()` titles should be renamed in one
  follow-up together with `syncNodeRemoteOps.test.js:103` (finding 1), or left —
  they are developer-facing text with no reader outside the test runner.
- **The gate stack cannot write its own record from a nested round.**
  `scripts/gateReportCli.js` refused to emit a `GateReport` because
  `scripts/observeRun.js` accepts only two resolution record shapes and the
  dispatching transcript contains neither (1 `toolUseResult`, 0 `task_status`
  attachments). Failing closed is the right direction, but it means no typed
  `GateReport` exists for any Governor-dispatched round at spawn depth 2. Wants
  its own item.
- Whether "a rewritten comment that is false" disqualifies on **any** false
  sentence (making `useDeviceMode.js:179-180` a fourth blocker) or only on a
  materially misleading one (leaving it HIGH). Grader flagged this as the one
  reading it would not substitute its own judgement for.
- Whether the comment-only constraint should be relaxed for a corrective round.
  Three of the four blockers are one sentence from correct and fixable as
  comments; the ScheduleScreen one also exposes a real product gap (no renderer
  subscribes to `shoresh:full-sync-applied`) that a comment cannot fix.

## Decision

**ESCALATE** — round 1, no round 2. Verifier returned PASS on the deterministic layer and Grader
returned **FAIL** (2.0 average, lowest dimension 2). Under `CONSTITUTION.md` Article VII as amended
2026-10-01 (#688) a Grader FAIL ends the loop and escalates to the user; it never becomes another
round, "regardless of how the blocker looks" — and here each blocker is one sentence from correct,
which is exactly the case the amendment names. The branch `claude/retired-vocab-sweep` is left as
eight commits at `307fda09`, unpushed, with no PR. The owner decides whether to correct the four
comments in a fresh round, revert the three files carrying them, or take the sweep as-is and queue
the corrections.

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
