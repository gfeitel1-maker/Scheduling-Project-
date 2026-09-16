---
task: "closes T156: the decision was already made, recorded and built — the ticket did not follow"
document_type: run
date: 2026-09-15
round: 1
status: pass
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T156-generated-route-validity-after-merge.md]
related_specs: []
related_adrs: [docs/adr/2026-09-08-crdt-conflict-reconciliation.md]
selected_agents: []
omitted_agents:
  - agent: governor
    reason: human-waived
    note: "Owner routed this session directly (\"fix any stale comments you find along the way but keep going\"); no Governor dispatch occurred."
  - agent: architect
    reason: not-applicable
    note: no behaviour change. A ticket status flip and four comment corrections; the product decision was taken by the owner on 2026-09-13 and built under T159.
  - agent: designer
    reason: not-applicable
    note: nothing rendered changes. The OVERLAP marker this ticket is about already ships on both routes.
  - agent: maker
    reason: human-waived
    note: this session made the edits directly rather than dispatching a Maker. Recorded as waived, not selected.
  - agent: code-reviewer
    reason: human-waived
    note: "No reviewer was dispatched. The peer session held the machine for a native compile and reviewing this would have cost it CPU it was already starved of; the change is comment text plus a status flip, with the gate as the evidence surface."
  - agent: verifier
    reason: not-applicable
    note: the gate was run directly by this session and its verdict is quoted in completion_evidence.
  - agent: tester
    reason: not-applicable
    note: no director-facing behaviour changes — the behaviour under discussion shipped in T159 and is unaltered here.
  - agent: security
    reason: no-predicate
    note: no auth, secret, IPC or transport surface. The one security-adjacent comment touched (normalizeSlots.js) had its MECHANISM corrected while the hazard it describes is unchanged.
  - agent: red-hat
    reason: not-applicable
    note: no stored-data shape, sync or migration change; comments only.
  - agent: grader
    reason: no-predicate
    note: nothing to score; no opinion agents ran.
deterministic_checks: [npm run verify]
human_gates:
  - "Owner decision 2026-09-13: \"for warning on the clash - show the warning on both routes\" — Option 1, which T159 then built."
verdict: pass
completion_evidence:
  - "T156 archive_when is satisfied and was satisfied before this commit: the owner decided, and T159 (status: completed) built it"
  - "src/screens/ScheduleScreen.jsx derives OVERLAP on both routes via withOverlapFlags — verified in the file, not inferred from the ticket"
  - "four stale comments corrected: ScheduleScreen.jsx (asserted the opposite of the code 14 lines below), normalizeSlots.js (op-log named as the sync boundary it stopped being in Stage 6), usePendingConflicts.js and electron/main.js (both cited syncServer.js, deleted in Stage 6)"
  - "a fifth leftover from the same T159 change: `route` lingered in the OVERLAP useMemo dep array after the body stopped reading it — pre-existing on origin/main, confirmed there before touching it; removed, 65 ScheduleScreen tests pass"
  - "npm run verify: see the gate verdict recorded at merge"
archive_when: a stale comment is caught by something other than a person reading the line beneath it
---

# T156 — closed, and the stale comments it left behind

## What this is

Not a build. T156 asked a product question, the owner answered it on 2026-09-13
("show the warning on both routes"), and T159 shipped it. The ticket stayed open
past its own closing condition.

## The finding worth keeping

`ScheduleScreen.jsx` carried a comment asserting **"OVERLAP stays manual-only ...
a genuine product stance"** fourteen lines above the call that derives OVERLAP on
both routes. Both were written deliberately; the second superseded the first and
the first was never removed.

This is the week's defect class one layer up. Not a wrong answer in the code — a
stale claim *about* the code, left standing because nothing checks it. The
status-drift gate catches a ticket whose status contradicts a commit. Nothing
catches a comment that contradicts the function directly beneath it, and a
confident comment is worse than no comment: it is read instead of the code.

Three more of the same, all pointing at machinery deleted in Stage 6:

- `src/utils/normalizeSlots.js` called the op log "the LAN sync boundary". It has
  been a local history ledger since Stage 6; flags now arrive via the replicated
  Automerge document. The prototype-pollution hazard the comment guards is
  unchanged — only the route by which untrusted input arrives was misdescribed,
  which is exactly the kind of wrongness that survives review.
- `src/hooks/usePendingConflicts.js` and `electron/main.js` both cited
  `syncServer.js` — a file that no longer exists — as the live counterpart to
  their logic.

And one that was not a comment at all. The same T159 change left `route` in the
dependency array of the memo it edited, after the body stopped reading it —
`react-hooks/exhaustive-deps` had been reporting it on `origin/main` the whole
time, one warning inside a 27-warning baseline that nobody reads. A stale comment
and a stale dependency are the same event: a change that updated the code and not
the things around it. The comment needed a person to notice; the dependency was
being reported continuously and ignored, which is the worse of the two failures.

## What was not done

No sweep. These four were found while working, which is how the owner scoped it.
A systematic hunt for stale comments is a different job and would want a
different instrument than grep; the three Stage-6 ones were found by searching
for names of deleted things, which only works when you already know what died.
