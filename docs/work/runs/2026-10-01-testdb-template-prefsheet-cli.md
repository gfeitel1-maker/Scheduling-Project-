---
task: q-testdb-template-prefsheet-cli — convert CLI-shaped test files to openTemplatedDb (+ Task A: Governor binding revert to Opus)
document_type: run
date: 2026-10-01
round: 1
status: escalated
task_class: test-infrastructure
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T51-mcp-cli-ingestion.md]
related_specs: []
related_adrs: []
selected_agents: [architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: test-only performance work; no UI surface.
  - agent: tester
    reason: not-applicable
    note: no director-facing UX/visual surface; the deliverable is test-setup plumbing.
  - agent: security
    reason: not-applicable
    note: no auth/PIN/secret/IPC/LAN-protocol/packaging change; the template db is plaintext test scaffolding and the files are test-only.
verdict_detail: "Verifier PASS (deterministic); Grader BLOCKED on foreground-dispatch provenance binding — escalated, not a merit FAIL"
deterministic_checks:
  - scripts/preferenceSheetCli.test.js (vitest, exit 0)
  - scripts/ingestCli.test.js (vitest, exit 0)
  - scripts/mcp/tools.test.js (vitest, exit 0)
  - npx eslint scripts (exit 0 — orphaned-import backstop)
  - npm run agents:check (Task A — exit 0, byte-identical)
  - before/after CPU per converted file (process.cpuUsage, interleaved — NOT wall clock)
  - non-vacuity red/green per converted file on a scratch copy (cmd; echo EXIT=$?, unpiped)
  - footprint git diff --name-only origin/main
human_gates: []
verdict: PASS
completion_evidence:
  - "64/64 tests green across the three converted files (exit 0)"
  - "non-vacuity RED/GREEN demonstrated per file"
  - "npx eslint scripts exit 0; npm run agents:check exit 0 (governor model=opus)"
  - "footprint exactly 7 files; no production code touched"
  - "CPU 11.10s->8.82s (20.5%) via process.cpuUsage interleaved"
  - ".automerge temp leak closed after 077fdea9 (tmpdir count 7->7)"
  - "commits: a1795a47 (Task A), b9a3f62e (Task B), 077fdea9 (leak fix)"
archive_when: merged to main and the board item q-testdb-template-prefsheet-cli is closed
---

# Run: testdb-template conversion of the CLI-shaped test files (+ Governor binding revert)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** The CLI-shaped test files stop replaying the whole migration chain on every
test, cutting their CPU cost, without making any test vacuous and without touching production code.
Separately (Task A), the Governor agent binding is reverted to Opus 4.8 per the owner's reversal.

**Success predicate:**
- Task A — `docs/governance/agent-bindings/governor.md` frontmatter reads `model: opus`, the
  regenerated `.claude/agents/governor.md` matches, and `npm run agents:check` exits 0.
- Task B — every CLI-shaped file that CAN be safely templated is converted to `openTemplatedDb`
  with a measured CPU drop and proven non-vacuity; any file that genuinely cannot is left on
  `electron/db/testDbTemplate.js`'s must-not-convert list with a true reason; the list matches
  reality after; `npx eslint scripts` and the three test files exit 0.

**What does not count as done:** a converted test that still passes with its subject broken
(vacuous); a must-not-convert list that lies (names a file that was converted, or omits one left);
`afterEach` cleanup that drops the shared template (defeats the optimization); orphaned `os`/`path`/
`openLocalDb` imports; any change to production code (anything under `electron/ops/`, `electron/sync/`,
`src/`, or `electron/db/` other than `testDbTemplate.js`'s must-not-convert comment).

## Task class and what it pulls in

`test-infrastructure` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `docs/governance/standards/TESTING_STANDARD.md` |
| Mandatory gates | test · lint · build (scoped to the touched files + `npx eslint scripts`; whole-suite/`verify` is explicitly out of scope per the brief) |
| Human gate | none |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | settles per-file convertibility and the must-not-convert-list edits; no ADR (test-infra) |
| Designer | no | not-applicable — no UI |
| Maker | yes | performs the conversion test-first |
| Code Reviewer | yes | read-only — is any converted test now vacuous? is the must-not-convert list truthful after? |
| Verifier | yes | always — the only deterministic evidence source; owns the non-vacuity plants on a scratch copy |
| Tester | no | not-applicable — no director-facing UX/visual surface |
| Security | no | not-applicable — no auth/secret/IPC/protocol/packaging change |
| Red Hat | yes | read-only — CLI-subprocess vs open template WAL, afterEach-vs-afterAll drop, orphaned imports, pristine-migration dependence |
| Grader | yes | calibrated score; a Grader FAIL ends the loop and escalates to the worker |

Every one of the ten appears here. Omissions carry an enum reason above.

## Pre-dispatch findings (Governor)

- **Task A done** before any Task-B dispatch: commit `a1795a47`. `#697` changed only the frontmatter
  line (`opus`→`sonnet`); the body prose `**Model:** claude-opus-4-8 (Opus)` was left unchanged, so
  the revert is purely the frontmatter line. `npm run agents:check` exit 0 (byte-identical);
  `npm run check:governance` — no findings.
- **No subprocess in any of the three files.** All three explicitly document "exported functions
  called directly — no subprocess/stdio/MCP client" and the grep for `spawn|execFile|child_process|
  fork` returns nothing. So the feared "CLI subprocess vs open template WAL handle" collision cannot
  apply — the must-not-convert reason ("CLI-shaped setup, 16/8 call sites") describes the F2
  transformer declining an unfamiliar setup *shape*, not a semantic obstacle.
- **Shared shape:** each file has `bootstrapDb(dir)` → `openLocalDb(path.join(dir,'shoresh.sqlite'))`
  → raw INSERTs into camps/devices/users → `db.close()` → returns `{ dbPath, ... }`; the CLI then
  opens the closed file itself. This is exactly the seed-through-handle-then-close pattern the
  template supports (`openTemplatedDb()` returns `{ db, file }`).
- **Convert vs keep distinction:** only db-*creation* sites convert (inside `bootstrapDb`, and
  `scripts/ingestCli.test.js:130`'s standalone `openLocalDb(dbPath).close()` fresh-schema open).
  The many `openLocalDb(dbPath)` calls that *reopen an existing file* to assert counts / seed more
  must stay `openLocalDb` — so `openLocalDb` likely remains imported; `os`/`path` stay used by
  `makeTmpDir` for fixture dirs. Orphaned-import risk is therefore lower than the general case, but
  `npx eslint scripts` is the mandatory backstop.
- **One real semantic difference to check:** `openTemplatedDb` clears `device_identity` (re-minted on
  next open), whereas a fresh `openLocalDb` seeds it. bootstrapDb seeds the `devices` table (distinct
  from `device_identity`), so no test appears to depend on identity stability across bootstrap→CLI —
  Architect/Red Hat to confirm per file.
- **cleanup:** must be `afterAll(cleanupTemplatedDbs)` (it drops the cached `templatePath`); the
  existing `afterEach` dir-removal stays for fixture dirs (the template copies live in os.tmpdir, not
  in `dir`).

## Gates

| Gate | Result | Evidence |
|---|---|---|
| agents:check (Task A) | PASS | exit 0, byte-identical (pre-dispatch) |
| check:governance (Task A) | PASS | no findings (pre-dispatch) |
| scripts/preferenceSheetCli.test.js | PASS | 14 passed, exit 0 (Verifier + Governor re-run) |
| scripts/ingestCli.test.js | PASS | 12 passed, exit 0 |
| scripts/mcp/tools.test.js | PASS | 38 passed, exit 0 (post-leak-fix) |
| npx eslint scripts | PASS | exit 0, 0 errors (6 pre-existing warnings in security-gate.js/verify.js) |
| before/after CPU (per converted file) | PASS | 11.10s→8.82s total (20.5%), process.cpuUsage interleaved |
| non-vacuity red/green (per converted file) | PASS | RED/GREEN demonstrated all three (see per-file table) |
| footprint (git diff --name-only origin/main) | PASS | exactly 7 files; nothing under src/ electron/ops/ electron/sync/ or electron/db except testDbTemplate.js |
| .automerge temp leak (post-fix) | PASS | os.tmpdir automerge count before=7 after=7 (delta 0) |

## Per-file convert/leave decision

| File | Decision | Reason (Architect) | Before CPU | After CPU | Non-vacuity |
|---|---|---|---|---|---|
| scripts/preferenceSheetCli.test.js | CONVERT | no subprocess, no device_identity read, no migration/dir coupling; ops counts start 0 in both | 3.69s | 3.29s | RED/GREEN proven (break db → 14 fail; restore → 14 pass) |
| scripts/ingestCli.test.js | CONVERT | same profile; the standalone fresh-schema open at :130 also converts | 3.91s | 2.93s | RED/GREEN proven (break db → 11 fail; restore → 12 pass) |
| scripts/mcp/tools.test.js | CONVERT (w/ fix) | 19/20 sites mechanical; :708 `saveDoc(path.dirname(dbPath),...)` leaked uncleaned .automerge into os.tmpdir (Code Reviewer HIGH, reproduced) → fixed in 077fdea9 to `saveDoc(dir,...)` + `{user_data_dir:dir}`, leak closed (tmpdir automerge count 7→7) | 3.50s | 2.60s | RED/GREEN proven (break → 38 fail; restore → 38 pass) |

CPU via process.cpuUsage() interleaved under concurrent load; total 11.10s→8.82s (20.5%). Leak-closed re-verified foreground by Governor after 077fdea9.

Architect open points carried: (1) the :706 edit is a named, reviewed semantic change, not a blind substitution — recommended CONVERT-with-fix; fallback is LEAVE tools.test.js on the list with reason "doc-store path coupled to dbPath's directory (line 706)". Governor accepts the recommendation; Red Hat + Code Reviewer + Verifier scrutinize the :706 edit. (2) Pre-existing tmp-dir leak in tools.test.js elective-run describes (makeTmpDir without dirs.push) — out of scope, flagged. (3) Real call-site counts are 10 (ingestCli, incl. :130) and 20 (tools, incl. :706), not the brief's 8/16 — the rewritten testDbTemplate.js comment uses real counts.

## Verifier verdict

**PASS** — all deterministic gates green: 64/64 tests across the three files, non-vacuity RED/GREEN
per file, eslint exit 0, agents:check exit 0 (governor model=opus), footprint exactly 7 files, CPU
improved on all three (20.5% total), and (post-leak-fix, Governor re-run) the .automerge temp leak
is closed. No unresolved UNVERIFIED.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

**BLOCKED — could not produce a machine GateReport (not a merit FAIL).** `scripts/gateReportCli.js`
refuses to bind the red_hat and code_reviewer opinion reports because its provenance check
(`scripts/opinionReportProvenance.js`) requires `toolUseResult.agentId+status` or `task_status`
attachment records in the session transcript — records emitted only by **background** agent
dispatches. This Governor ran as a dispatched subagent and (per its dispatch discipline, reinforced
by the coordinator) used **foreground** sub-dispatches, which produce **zero** such records (verified:
0 of 70 user records carry toolUseResult.agentId+status; 0 task_status attachments). The opinion
reviews genuinely ran — their own subagent transcripts
`.../subagents/agent-a0befe4b2cc34b892.jsonl` (code-reviewer) and `agent-a41fc1af72b04f2dc.jsonl`
(red-hat) exist on disk — but the CLI cannot mechanically bind a foreground dispatch. A GateReport
was deliberately NOT hand-assembled around the unbound check (that is the exact fabrication the gate
exists to stop). Substantively: Red Hat found only 2 LOW nits; Code Reviewer's one HIGH was fixed
(077fdea9) and re-verified, leaving only LOW nits.

## Findings carried forward

- **GateReport CLI vs foreground dispatch (process gap, needs a human/coordinator decision).**
  `gateReportCli.js` provenance binding assumes background-dispatch resolution records. A Governor
  running as a dispatched subagent must dispatch foreground (its own discipline), so it can never
  satisfy the binding. Either (a) the binding must accept an alternative proof of a foreground
  dispatch (e.g. the dispatched reviewer's own on-disk subagent transcript), or (b) grading for a
  dispatched-subagent Governor must be escalated to the main session which dispatches reviewers in
  the background. Not fixable within this run's footprint.
- Red Hat LOW: inert `dir` parameter still passed to `bootstrapDb(dir)` call sites in all three
  files (harmless; a readability trap). Code Reviewer LOW: same. Not fixed (out of the minimal
  footprint; a follow-up cleanup).
- Red Hat LOW: testDbTemplate.js's "~38 remain" approximate count not decremented for the
  preferenceSheetCli conversion. Doc-staleness only.
- TEMPLATE.md's inline `task_class` enum comment is stale (omits `concurrency` and
  `test-infrastructure`, both valid per `WORK_RECORD_STANDARD.md` §4). Out of footprint.

## Decision

**ESCALATE (process blocker, not a merit FAIL).** The work meets its success predicate on
deterministic evidence (Verifier PASS: tests, lint, agents:check, footprint, CPU, leak closed) and
clean opinion review (one HIGH fixed+re-verified; only LOW nits remain). The one thing that could
not be produced is a machine-bound GateReport score, because `gateReportCli` cannot bind
foreground-dispatched opinion reports — a tooling/execution-model mismatch. Escalated to the
coordinator for a decision on how to record the grade; no verdict was fabricated. Not pushed/merged
(the worker does that).

> A Grader FAIL ends this loop and escalates to the worker. It does not become a round 2/3.
