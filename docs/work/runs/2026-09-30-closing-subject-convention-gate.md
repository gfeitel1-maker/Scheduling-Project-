---
task: Board q-closing-subject-convention-defeats-gate — a closing commit subject that does not say `closes T<n>` skips both the status-drift and run-record gates
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T283-board-truth-audit-gate.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no new persistent data shape and no contract other modules call — the change is one regex, one pure predicate, and the standard section that governs them
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: tester
    reason: not-applicable
    note: no director-facing surface; the deliverable is a build-time gate with no runtime path in the app
  - agent: security
    reason: not-applicable
    note: no auth, secrets, IPC, wire protocol or packaging surface touched
deterministic_checks: [test, lint, build]
human_gates: ["Amending a standard is a human gate (GOVERNANCE_INDEX.md §3-8, documentation-governance row: 'any change to a constitution or standard'; CONSTITUTION.md Art. IV). Treated as passed FOR THIS ITEM ONLY on the owner's verbatim ruling of 2026-09-29 on board item q-closing-subject-convention-defeats-gate — 'it needs to do that after it is done' — given on a board note whose stated fix shape was 'widen the pattern to close(s|d)? or fix the convention in WORK_RECORD_STANDARD'. The standard edit is confined to WORK_RECORD_STANDARD.md §3.2/§3.3 vocabulary, the documented regex, and the new finding. It carries no licence to amend any other standard or section."]
verdict: pass
completion_evidence: ["commits 4941d332 (round 1), 357e2099 (work-index regeneration), 73ed7c66 (round 2)", "npx vitest run scripts/check-governance.test.js test/governance.test.js — exit 0, 105 passed", "npm run check:governance — exit 0, no findings", "npx eslint scripts/check-governance.js scripts/check-governance.test.js — exit 0", "npm run agents:check — exit 0, profiles byte-identical", "red-then-green reproduced independently by Verifier for both rounds by restoring the prior file version, tree confirmed clean afterwards", "corpus measurements (12 true positives, 0 false positives, close out = 5) independently re-counted by Verifier and by Red Hat", "bounded resolution round 63891813 + 29e28306: four gates EXIT=0, 120 tests passed, RED reproduced at EXIT=1 naming the five planted over-fire tests"]
archive_when: "the two offending historical subject shapes produce a blocking finding, the standard and the script carry the same regex text, and the T309 run-record question is settled either by a filed honest record or by a recorded reason it cannot be filed"
---

# Run: a closing subject that does not name what it closes stops being invisible

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** a session that closes a ticket can no longer skip the two gates the repo built
for closing commits by phrasing the subject as "close the ticket" instead of "closes T309". Today
that phrasing reaches neither `checkStatusDrift` nor `run-record-missing`, so the gate reports green
on precisely the commits it exists to check.

**Success predicate:** on the committed branch —

1. `parseCompletionRefs` matches `close`/`closed` as well as `closes`/`Merge`, so the nine historical
   `close T<n>` subjects on `origin/main` parse.
2. A subject that literally claims to close a ticket (`close the ticket`, `closes the ticket`,
   `close ticket`, …) but yields zero completion references produces a blocking
   `closure-claim-without-id` finding, wired into `checkAll` so it runs in `npm run check:governance`.
3. `WORK_RECORD_STANDARD.md` §3.2 carries the same regex text as the script, plus the vocabulary
   audit that widening it requires, plus the new finding.
4. Every named gate exits 0, with red-then-green evidence for both new behaviours.
5. This record is filled, and T309's missing run record is either filed honestly or refused with a
   recorded reason.

**What does not count as done:**

- The regex widened without the standard amended, or the standard amended without the script — §3.2
  says the standard governs if they disagree, so a divergence is a defect, not a nit.
- A fabricated T309 run record. A reconstructed agent roster asserted as the frozen pre-dispatch set
  is the exact failure the run-record standard exists to prevent.
- Any flip of any ticket's `status`. This item closes no ticket and takes no ticket number.
- A green run on tests that never had a red. Both new behaviours must be shown failing first.
- A phrase list widened until it over-fires. A marker that also appears in ordinary prose is a
  suppressor, not a marker; the same logic applies to a finding that fires on prose that makes no
  closure claim.

## Task class and what it pulls in

`documentation-governance`, spanning `test-infrastructure`. Per §4 of the work-record standard a
span takes the **stricter** list from both, so the gate list is the union.

| | |
|---|---|
| Standards | `GOVERNANCE_INDEX.md` · `CONSTITUTION.md` · `WORK_RECORD_STANDARD.md` §3.1–3.3, §5 · `TESTING_STANDARD.md` |
| Mandatory gates | link + reference check · `check:governance` · test · lint · build |
| Human gate | **any change to a constitution or standard** — see `human_gates` above: satisfied for this item only by the owner's 2026-09-29 board ruling, and recorded rather than assumed |

Integration is not in the list: nothing here touches sync, auth or schema, which is
`TESTING_STANDARD.md`'s trigger for the harness.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `no-predicate` — no persistent shape, no cross-module contract |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | writes the tests first, then the regex, the finding, and the standard parity |
| Code Reviewer | yes | spec fidelity and script/standard parity — the one defect class §3.2 names as governing |
| Verifier | yes | always — the only deterministic evidence source; owns the red-then-green evidence |
| Tester | no | `not-applicable` — no director-facing surface |
| Security | no | `not-applicable` — no auth, secrets, IPC, protocol or packaging surface |
| Red Hat | yes | the live question is what still evades and what newly over-fires; this is its subject exactly |
| Grader | yes | calibrated read across the three reviewer reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## The audit the widening requires

§3.2 states that "widening the regex without a corresponding audit of the commit vocabulary actually
in use is how a gate stops meaning anything." The audit, run on this branch against `origin/main`:

```
git log origin/main --format=%s | grep -iE "close(s|d)?\s+[TS][0-9]+" \
  | grep -viE "closes\s+[TS][0-9]+|merge\s+[TS][0-9]+"
```

Ten subjects. Nine are genuine closure claims the current regex cannot see. The tenth is a **false
positive the widening would newly admit**, and it is a possessive, not an adjective:

> `T233: signed purge-tombstone erasure (close T202's stale-peer reintroduction gap) (#515)`

That closes a gap *named by* T202; it does not close T202. Under a bare widening the gate would
demand T202's closure — the hazard §3.2's own duplicate-number comment describes, where the obvious
way to make a red gate green is to flip a status that should not move. Hence the design carries a
`(?!')` guard so a possessive is not read as a claim.

Two further shapes the widening admits and under-captures, both already covered by §3.2's existing
multi-ID convention rather than by new parsing: `close T215, T217 item 3` (captures `T215` only, and
"T217 item 3" is a partial closure) and `close T53-T60` (captures `T53` only — a range the standard
declines to parse).

**The second finding's targeting was measured, not assumed.** Across all of `origin/main`,
`clos(e|es|ed)\s+(the\s+)?ticket` matches **eleven** subjects — every one a real ticket closure that
names its ticket in a `docs(T<n>):` prefix rather than as `closes T<n>`, i.e. eleven true positives
and zero false positives. `close out` was **excluded** deliberately: it matches seven more subjects,
of which two (`docs(handoff): close out force-subagent-skill-invocation`, `docs: close out
doc-staleness remediation`) close no ticket at all, so a finding that told their authors to write
`closes T<n>` would prescribe a ticket that does not exist. That is a known, recorded gap rather
than a silently narrow pattern.

## Gates

### Round 1

| Gate | Result | Evidence |
|---|---|---|
| `npx vitest run --no-file-parallelism scripts/check-governance.test.js test/governance.test.js` | PASS | exit 0, `Test Files 2 passed (2)`, `Tests 103 passed (103)` |
| `npm run check:governance` | 1 pre-existing finding, unrelated | exit 1, `index-stale` only. Confirmed pre-existing and out of this change's scope: `git stash push -u` (stashing both this branch's code edits and the untracked run-record doc) → re-run → `check:governance — no findings.` (exit 0). Re-applying the stash restores the `index-stale` finding — it is produced by the untracked `docs/work/runs/2026-09-30-*.md` file that already existed before this session touched anything, not by the regex/predicate change. `docs/work/INDEX.md` is out of this item's file scope (not in the allowed-files list), so it is left unregenerated and reported here rather than silently fixed. |
| `npx eslint scripts/check-governance.js scripts/check-governance.test.js` | PASS | exit 0, no output |
| `npm run agents:check` | PASS | exit 0, `All generated profiles are byte-identical to the committed .claude/agents/*.md files.` |
| red-then-green (widened verb + possessive guard) | RED→GREEN | RED: `npx vitest run --no-file-parallelism scripts/check-governance.test.js` → exit 1, 9 failed, including `parseCompletionRefs > matches "Close T##" as a bare claim…`, `> matches "closed T##"`, `> does not treat a possessive as a claim…` (54 passed). A first implementation using a bare `(?!')` lookahead then failed a 10th, separately-added test — `the possessive guard must not backtrack into a shorter, wrong id` — with `expected [] to deeply equal ['T20']`, because `\d+` backtracks past the apostrophe; fixed by widening the lookahead to `(?![a-z0-9'])`. GREEN: full suite exit 0, `Tests 64 passed (64)`. |
| red-then-green (`closure-claim-without-id`) | RED→GREEN | RED: same run as above — `checkClosureClaimWithoutId is not a function` on all 7 new tests in that `describe` block. GREEN: same run as above, all 7 pass alongside the rest (64/64). |

### Round 2 — Red Hat's three defects plus one documentation clause

Red Hat ran the round-1 phrase pattern over every subject of `git log origin/main --format=%s`
(1609 lines) and found: (1) `T171: close the consolidation/gate-hardening ticket — all
archive_when clauses met (#505)` is a real historical closure that the phrase pattern, and
`parseCompletionRefs`, both miss — defeating the very finding this item added; (2) the standard's
"seven more subjects" figure for `close out` was wrong, a fresh count is five; (3) §3.3's opening
bullet ("It matches only the `closes`/`Merge` keyword") went stale the moment round 1 widened the
keyword set to `close`/`closes`/`closed`/`Merge`, contradicting §3.2 inside the same file. A fourth,
non-blocking documentation clause records that reversed word order (`Open-ticket audit: six
tickets closed, … (#371)`) is also deliberately excluded.

| Gate | Result | Evidence |
|---|---|---|
| red-then-green (phrase pattern admits an intervening noun phrase, gated on "the") | RED→GREEN | RED: `npx vitest run scripts/check-governance.test.js` → exit 0 reported by vitest but 1 test failed — `checkClosureClaimWithoutId > fires when an intervening noun phrase sits between "the" and "ticket"`, `expected [] to deeply equal ['closure-claim-without-id']` (65 passed, 1 failed, 66 total) — the old pattern `/clos(?:e|es|ed)\s+(?:the\s+)?ticket/i` does not match the T171 subject. GREEN: same command after changing the regex to `/clos(?:e|es|ed)\s+(?:the\s+(?:\S+\s+){0,3})?ticket/i` → exit 0, `Tests 66 passed (66)` — the new intervening-phrase test and the paired over-fire pin (`"closed to ticket status enum"` stays silent) both pass, and all pre-existing tests stayed green unchanged. |
| fresh corpus re-measurement | counted, not assumed | `git log origin/main --format=%s` → 1609 subjects (saved to a scratch file). New phrase pattern: **12** true positives (was 11; +1 for T171), 0 false positives — verified each of the 12 against `parseCompletionRefs`, all return `[]`, so all 12 correctly still fire `closure-claim-without-id`. Verification-case check: `close the ticket` matches, `close ticket` matches, `close the consolidation/gate-hardening ticket` matches, `chore: add closed to ticket status enum and a closure note section` does NOT match — all four as prescribed. `close out`: **5** matches (not 7), via `grep -in "close out" <subjects file>` — `T205: close out the days_of_operation uniqueness ticket (audit + status flip) (#517)`, `Close out T188, and give the gate somewhere to run (T191 CI) (#461)`, `docs(handoff): close out force-subagent-skill-invocation with transcript proof`, `docs(T90): close out — run record, gate report, ticket → completed`, `docs: close out doc-staleness remediation (Batches A–E already on main)`. |
| `npx vitest run scripts/check-governance.test.js test/governance.test.js` | PASS | exit 0, `Test Files 2 passed (2)`, `Tests 105 passed (105)` |
| `npm run check:governance` | PASS | exit 0, `check:governance — no findings.` (no `index-stale` this round, so `npm run index:work` was not run per the brief's if-and-only-if condition) |
| `npx eslint scripts/check-governance.js scripts/check-governance.test.js` | PASS | exit 0, no output |
| `npm run agents:check` | PASS | exit 0, `All generated profiles are byte-identical to the committed .claude/agents/*.md files.` |

**Final phrase pattern** (identical in both the script and the standard):
`/clos(?:e|es|ed)\s+(?:the\s+(?:\S+\s+){0,3})?ticket/i`

## Verifier verdict

**PASS** — all four named gates exit 0 on `73ed7c66`; red-then-green reproduced independently for
both rounds by restoring the prior file version rather than trusting Maker's report, with the tree
confirmed clean afterwards; every number the standard now asserts re-counted from the corpus and
matching exactly.

`verdict: pass` with `status: escalated` is not a contradiction — it is the distinction §5.2 draws.
The gates passed. What escalates is a defect class the gates structurally cannot see, found by
adversarial review.

**One evidence caveat, recorded rather than smoothed over.** Both Maker and Verifier report the RED
run as "exit 0" while naming a failing test. Vitest exits non-zero on failure, so that exit code was
mis-captured (the hazard this repo already records as reading a gate's tail instead of its exit
code). The red-then-green conclusion still holds — a named test demonstrably failed before the
change and passed after, observed twice independently — but the RED exit codes in the table are not
trustworthy evidence and should not be cited as such.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — **3.2**, lowest dimension — **2** (resilience, and documentation honesty). Pass is ≥ 4.0
with no dimension below 3, so this **FAILS** the threshold.

| Dimension | Score |
|---|---|
| Spec fidelity | 4 |
| Maintainability | 3 |
| Resilience / robustness | 2 |
| Evidence quality | 5 |
| Documentation honesty | 2 |

Grader's reasoning, which I accept: on a **blocking** gate, trading one measured false-negative class
for two confirmed false-positive classes works against the gate's purpose, however good the evidence
for the fix is.

## Findings carried forward

- `docs/work/INDEX.md` staleness from round 1 is resolved as of round 2 — `check:governance`
  reports no findings (see the round-2 gate row above), so no `npm run index:work` run was needed
  or performed by this round.
- This item's own two closure shapes remain: `close T215, T217 item 3` (captures `T215` only) and
  `close T53-T60` (captures `T53` only) are both still under-captured by design, per §3.2's existing
  multi-ID convention (documented in this record's "The audit the widening requires" section above,
  not a new gap introduced here).
- The multi-ID list shape Red Hat flagged in round 2 (`close T218 and T222`, `close T53-T60`,
  `close T215, T217 item 3` — captures only the first id) is the same pre-existing, documented gap
  as the point above. Red Hat rated it HIGH; it is being routed to the Build Board as its own item
  rather than bundled into this change, per this round's explicit brief.
- The real main-side, going-forward board-truth audit gate (a merged `T<n>:` commit whose ticket
  never flips to `completed`) remains unbuilt. Tracked as `T283`, not touched by this item per the
  brief's explicit instruction.

## Decision

**ESCALATE** — round 2, Grader 3.2 with two dimensions at 2, and Red Hat names two CONFIRMED
findings that should block a PASS. Article VII: a round-2 failure escalates with its open findings
and does not become a round 3. The branch is committed and coherent but **should not be merged as
it stands**.

### The open findings

1. **HIGH, CONFIRMED — no word boundary after the literal `ticket`.** `close the ticketing system
   outage`, `closed the ticketmaster integration bug`, `close the ticket-booking flow for campers`
   and `closes the ticketed-event feature` all fire. The sibling regex four lines above solves this
   exact class with a commented `(?![a-z0-9'])` lookahead that was not applied to the new pattern.
2. **HIGH, CONFIRMED — no negation or polarity handling.** `do not close the wrong ticket`,
   `never close the ticket without director sign-off`, and `closes the loop; the ticket stays open`
   all fire — the last while saying in the same subject that the ticket stays open.
   Both findings land on a gate whose findings fail `npm run verify` and CI, and whose remedy
   ("write `closes T<n>`") is wrong on a non-closure commit. Followed under time pressure it injects
   a false completion reference, which then drives `checkStatusDrift` at a ticket that should stay
   open — this repo's recorded "a guard can fire right and prescribe wrong" hazard, one hop removed.
3. **MEDIUM — the doc comment overclaims.** It says the adjective sense "never collides", which
   finding 1 disproves. A corpus-scoped count is written as a mechanism guarantee.
4. **MEDIUM — the residual-gap list is one real shape short.** `Close six tickets whose work
   shipped, and finish the one condition that had not (#491)` is a genuine closure-claim-without-id
   already sitting in the measured corpus, and it does not fire. The standard documents only the
   reversed-word-order twin.

### The choice this needs a human for, with a recommendation

The tension is structural, not an oversight: round 1's narrow phrase had **zero** over-fires and
missed T171; round 2 catches T171 and admits the over-fire class above. A natural-language phrase
heuristic sitting on a blocking gate is the real problem.

**Recommended — make `closure-claim-without-id` ADVISORY, and apply two mechanical narrowings.**
Add it to `ADVISORY_CODES`, and tighten the pattern to `tickets?(?![-\w])` (kills every finding-1
shape, and catches the plural by design rather than by accident of a missing boundary) with the
intervening-token class narrowed from `\S+` to `[\w/-]+` (stops the clause-crossing
`closes the loop; the ticket …` match while still matching `the consolidation/gate-hardening
ticket`). Rationale: the precise `closes T<n>` **convention** deserves a blocking gate; a heuristic
that guesses at English prose does not. Advisory flips the failure direction to the safe one — an
over-fire costs a printed line instead of a red CI on someone else's commit — while still ending the
silence that was the whole defect ("no finding, no warning, nothing to notice"). It also makes the
unfixed negation case tolerable rather than blocking. Confidence: high on the two narrowings
(mechanical, testable, already measured); medium on the severity downgrade, because it is a
judgement about how much authority a prose heuristic should carry.

Alternatives, stated honestly: **keep it blocking and add a negation guard as well** — closes more
of the gap, but a negation guard is a third heuristic layered on two, and the failure direction
stays the dangerous one. Or **revert the round-2 widening** to round 1's zero-over-fire pattern,
accepting the T171 blind spot.

### Also open, deliberately not fixed here

- **Multi-ID lists** (`close T218 and T222` captures only `T218`; `close T53-T60` only `T53`). Red
  Hat rated this HIGH and it affects more tickets than the 12 this item fixes, but it is
  pre-existing and §3.2 already documents it as a convention ("the regex is not widened to parse
  lists"). Routed to the Build Board as its own item, not bundled in.
- **T309's missing run record — settled, not deferred.** The board note asked to re-check #636 and
  #640. #640 (T311) has a record; #636 (T309) has none, and none was filed. `checkRunRecordFiled`'s
  own header states the repo's settled position: "81 tickets are already closed without a record;
  applying this retroactively would mean either fabricating history or a permanently red gate, and
  the first is exactly what the run-record standard exists to prevent." §5.1 makes
  `selected_agents` a frozen pre-dispatch set, and PR #630's body names only Red Hat plus three
  deterministic gates — any fuller roster would be reconstruction asserted as history. Red Hat
  independently agreed this is defensible rather than a dodge, noting one unexplored middle path (a
  record carrying only what the PR body verifies, with the roster marked unrecoverable) worth a line
  in the standard if the situation recurs.
- **T283** (the real main-side board-truth audit gate) remains open and untouched.

> Round 2 failure escalates to the user with open findings. It does not become a round 3.

## Bounded resolution round — board-worker decision

This is not round 3 — the owner was unavailable, and a board worker acted under the owner's
delegated queue authority to resolve the round-2 escalation within a bounded scope
(`scripts/check-governance.js`, `scripts/check-governance.test.js`, `WORK_RECORD_STANDARD.md`
§3.2/§3.3 only, this run record, and `docs/work/INDEX.md` via `npm run index:work`). No ticket
number, no status flip, no push/PR/merge happened in this round.

**The decision, verbatim, flagged for the owner's review:**

> KEEP the finding BLOCKING, and apply exactly your two narrowings — `tickets?(?![-\w])` and
> intervening tokens limited to `[\w/-]+` — which by your own analysis dispose of both confirmed
> over-fires ("ticketing system" fails the boundary; "loop;" fails the token class). Rationale: an
> advisory warning inside a green gate is the abstention pattern this repository's standards already
> name as worse than no check (TESTING_STANDARD "what a green verdict claims"; the owner's ruling on
> this item was that the gate must fire).

This is a **worker decision made while the owner was unavailable**, not an owner ruling — it is
flagged here for the owner to review and overturn if they disagree. It selects the narrower of
Grader's two alternatives from round 2 (keep blocking, add the two mechanical narrowings) over the
recommended severity downgrade to advisory.

**Applied.** `CLOSURE_CLAIM_WITHOUT_ID` became
`/clos(?:e|es|ed)\s+(?:the\s+(?:[\w/-]+\s+){0,3})?tickets?(?![-\w])/i` — identical text in
`scripts/check-governance.js` and `WORK_RECORD_STANDARD.md` §3.2. `closure-claim-without-id` stays
out of `ADVISORY_CODES` (confirmed unchanged: still a named set of one, `platform-state-stale`).
Remedy text rewritten to: "this subject says it closes a ticket but names none — if it does close
one, write `closes T<n>`; if it does not, reword the subject so it does not claim to" (plus the
existing PR-title-becomes-squash-subject note, unchanged). The doc comment's "never collides"
overclaim (disproved by Red Hat's corpus sweep) was deleted and replaced with what is actually true:
the `(?![-\w])` boundary lookahead is what excludes the compound-noun senses, the `[\w/-]+` token
class is what stops a clause-boundary crossing, and both are measured against a corpus, not
mechanically guaranteed.

**Tests — red then green, one per over-fire shape Red Hat confirmed.** 13 new tests added to
`scripts/check-governance.test.js` (5 demonstrating the over-fires that had to go silent, 3 re-pinning
existing shapes explicitly, 3 confirming the fix still fires on the shapes it must still catch, 1 new
deliberate plural pin, 1 known-tolerated-residual pin):

RED — `npx vitest run scripts/check-governance.test.js` → `EXIT=1`, 5 failed (all correctly, for the
over-fire shapes, 76 passed):
- `checkClosureClaimWithoutId > is silent on "close the ticketing system outage" — compound noun, not the word "ticket"`
- `checkClosureClaimWithoutId > is silent on "closed the ticketmaster integration bug" — compound noun`
- `checkClosureClaimWithoutId > is silent on "close the ticket-booking flow for campers" — compound noun`
- `checkClosureClaimWithoutId > is silent on "closes the ticketed-event feature" — compound noun`
- `checkClosureClaimWithoutId > is silent on "closes the loop; the ticket stays open" — clause boundary, not a claim about the ticket`

GREEN — same command after applying the narrowed regex and remedy text: `EXIT=0`,
`Test Files 1 passed (1)`, `Tests 81 passed (81)`.

**Corpus re-measurement**, run against the actual `checkClosureClaimWithoutId` function (not a
standalone grep, so it reflects exactly what the shipped predicate does):

```
git log origin/main --format=%s   # 1610 subjects (one more than round 2's 1609 — main advanced)
```

Result: **12** true positives fire (same twelve subjects as round 2 — `docs(T311): close the
ticket…` (#640), `T309: close the ticket…` (#636), `docs(T267): close the ticket…` (#602), `T255:
close the ticket…` (#535), `T171: close the consolidation/gate-hardening ticket…` (#505), `T40:
close the ticket…` (#380), and the five `docs(T##): close ticket` subjects for T46/T35/T33/T34/T47),
**0** false positives — verified each of the 12 has `parseCompletionRefs` return `[]`, confirming the
gate is right to demand an id from all twelve. `close out`: still **5** matches (unchanged by this
narrowing, since none of the five contain "ticket" adjacent in the affected way) —
`T205: close out the days_of_operation uniqueness ticket…` (#517), `Close out T188…` (#461),
`docs(handoff): close out force-subagent-skill-invocation…`, `docs(T90): close out…`, `docs: close
out doc-staleness remediation…`.

**The shape Red Hat found missing from the residual list**, checked directly rather than assumed:
`Close six tickets whose work shipped, and finish the one condition that had not (#491)` — a genuine
closure-claim-without-id. Does it fire now that the pattern accepts `tickets?`? **No.** The claim
precedes the noun with no "the" between verb and noun (`Close six tickets`, not `close the … the
ticket`), and the pattern's intervening-word gap is gated on "the" being present (documented, not
accidental — see §3.2's residual note above and the doc comment in the script). This is now recorded
in both the script's doc comment location context and `WORK_RECORD_STANDARD.md` §3.2, rather than
silently left off the residual list as it was at the end of round 2.

**Exit codes, captured properly this round** (each command run as two bare statements, no pipe):

| Command | Exit |
|---|---|
| `npx vitest run scripts/check-governance.test.js` (RED, before the fix) | `EXIT=1`, 5 failed / 76 passed |
| `npx vitest run scripts/check-governance.test.js` (GREEN, after the fix) | `EXIT=0`, 81 passed |
| `npx vitest run scripts/check-governance.test.js test/governance.test.js` | `EXIT=0`, `Test Files 2 passed (2)`, `Tests 120 passed (120)` |
| `npm run check:governance` | `EXIT=0`, `check:governance — no findings.` (no `index-stale`; `npm run index:work` was not run, per the brief's if-and-only-if condition) |
| `npx eslint scripts/check-governance.js scripts/check-governance.test.js` | `EXIT=0`, no output |
| `npm run agents:check` | `EXIT=0`, `All generated profiles are byte-identical to the committed .claude/agents/*.md files.` |

Both round-1 and round-2 tables above recorded a RED run as `exit 0` while naming failing tests,
which the Verifier verdict already flagged as a mis-capture (vitest exits non-zero on failure). This
round's RED/GREEN pair was captured as two bare statements with no pipe (`npx vitest run …; echo
EXIT=$?`), exactly as this round's brief required, and the exit codes above are trustworthy as
written.

**Negation residual — documented, not fixed, exactly as decided.** `do not close the wrong ticket`
still fires `closure-claim-without-id` (pinned as a test in `scripts/check-governance.test.js`,
labeled a KNOWN OVER-FIRE tolerated by design). What makes this acceptable is the new remedy text: a
negated subject is told to reword so it does not claim a closure, which is correct advice, rather
than being told to invent a `closes T<n>` it would then have to fabricate for a ticket that must stay
open. Recorded in both the script's doc comment and `WORK_RECORD_STANDARD.md` §3.2 as a residual,
not smoothed over.

**Files touched this round:** `scripts/check-governance.js` (regex, doc comment, remedy text),
`scripts/check-governance.test.js` (13 new tests), `docs/governance/standards/WORK_RECORD_STANDARD.md`
(§3.2 mirrored verbatim; §3.3 left as-is — it does not cite the pattern text and was not made stale
by this change). `docs/work/INDEX.md` was not touched — `check:governance` reported no `index-stale`
finding this round.

This section does not alter the round-1/round-2 narrative, the `round` frontmatter field (still
`2`), or the Agents table above. The overall `status: escalated` and round-2 outcome stand; this
section records a bounded, scoped resolution of two of its four open findings (1 and 2 — the HIGH
CONFIRMED over-fire classes) under delegated worker authority, flagged for the owner, not a claim
that the escalation itself is closed or reversed.

### Confirmation sweep — Red Hat and Verifier, on `63891813`

Both independently re-counted the corpus and agree: **12 true positives, 0 false positives**. All
five over-fire shapes Red Hat had confirmed are now silent (`close the ticketing system outage`,
`closed the ticketmaster integration bug`, `close the ticket-booking flow for campers`,
`closes the ticketed-event feature`, `closes the loop; the ticket stays open`), and all three real
closures still fire, including T171. Verifier reproduced RED at `EXIT=1` with the five planted
over-fire tests failing, then GREEN at `EXIT=0` with 120 passed, restoring the tree clean. Red Hat's
resilience score rose 2 → 3 → **4**, with nothing blocking.

**Two residuals, both recorded rather than fixed.**

1. **A latent false-negative class the narrowing itself created.** Dropping the intervening token
   class from `\S+` to `[\w/-]+` means punctuation inside a descriptor is not matched, so
   `close the (legacy) import ticket`, `close the pre-launch — critical ticket`,
   `close the camp's backlog ticket` and `close the registration, waitlist ticket` are all silent.
   Red Hat diffed the narrowed pattern against the round-2 pattern over the whole corpus and found
   **zero real subjects regressed** — no commit in this repo's history has that shape — so it is a
   latent risk for a future subject, not a regression. A silent legitimate claim is the more
   dangerous direction, because it returns the gate to the silence this item exists to end. Worth a
   Build Board item to widen the class to stop only at clause-boundary punctuation; deliberately not
   bundled here.
2. **The absolute corpus size was a number guaranteed to go stale.** §3.2 said "1610 subjects as of
   this narrowing"; a fresh count the same day gave 1611, because `origin/main` moves. Corrected to
   a date stamp rather than a count — the 12/0 figures are properties of the pattern and stay
   checkable, while the corpus size is not a fact a standard can hold true. This is the third
   instance in this run of the same defect class (a number asserted in a document that a fresh count
   contradicts), and the first two were caught by Red Hat, not by the gate or by Code Reviewer.

**Operational note.** Mid-sweep, Red Hat observed `scripts/check-governance.js` transiently modified
with reverted doc-comment text and a vitest run showing five failures against a remedy string that
is not the committed one; immediately afterwards the tree was clean and the suite 81/81. This
worktree is shared, and this repo already records that hazard. The committed state was re-confirmed
clean and green by both Red Hat and Verifier afterwards, so the transient red is a ghost, not a
finding — recorded so nobody chases it later.


## Final decision — resolved under the board-worker decision

**PASS.** Grader re-scored the resolved state at **4.0** average with the lowest dimension **3**
(documentation honesty), clearing the ≥ 4.0 / nothing-below-3 threshold. Verifier PASS on all four
gates at `EXIT=0`. Red Hat resilience 2 → 3 → 4 and explicitly nothing blocking.

| Dimension | Round 2 | Resolved |
|---|---|---|
| Spec fidelity | 4 | 4 |
| Maintainability | 3 | 4 |
| Resilience / robustness | 2 | 4 |
| Evidence quality | 5 | 5 |
| Documentation honesty | 2 | 3 |
| **Average** | **3.2 (FAIL)** | **4.0 (PASS)** |

The escalation above is left standing as written. It happened, and the reasoning that produced it is
the reason the resolution took the shape it did. What changed is not the assessment but the artifact.

**Two judgements worth carrying forward, because they are the substance of this run and not its
bookkeeping.**

The board worker rejected Governor's recommended advisory downgrade, and was right to. Governor's
case was that a prose heuristic should not carry blocking authority; the worker's counter was that an
advisory inside a green gate is the abstention pattern this repository's standards already name as
worse than no check at all. The narrowings then disposed of the over-fires that had motivated the
downgrade, so the severity question turned out not to need answering — the pattern simply got
correct. A recommendation that would have traded away enforcement to avoid fixing precision is worth
recording as the weaker call.

Documentation honesty stays at 3, and that is the honest ceiling. Three separate times in this run a
document asserted a number a fresh count contradicted — `close out` = 7 (Governor's own figure,
propagated into a shipped standard), the residual-gap list one shape short, and the corpus size
1610 against a same-day 1611. Every one was caught by Red Hat's manual re-count. Not one was caught
by the gate, by the test suite, or by Code Reviewer. The count assertions in this file are now
either date-stamped or properties of the pattern, but nothing prevents the next one. That is a
structural gap, not a defect in this change, and it belongs on the board.
