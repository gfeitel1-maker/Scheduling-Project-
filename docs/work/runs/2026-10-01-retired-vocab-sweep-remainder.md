---
task: Retired WebSocket Host/sync vocabulary — sweep the remainder T311 left behind (comment and doc prose only)
document_type: run
date: 2026-10-01
round: 1
status: in-progress
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
verdict: null
completion_evidence: []
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

| Gate | Result | Evidence |
|---|---|---|
| no-executable-change diff proof | | |
| `npx eslint electron src scripts test` | | |
| `npm run build` | | |
| `npm run check:governance` | | |
| named guard tests + touched test files | | |
| audit re-run (independent) | | |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

> A Grader FAIL ends the loop and escalates to the user. It never becomes another round
> (`CONSTITUTION.md` Article VII, owner ruling 2026-10-01).

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

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
