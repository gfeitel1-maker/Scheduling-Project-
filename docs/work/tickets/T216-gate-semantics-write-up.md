---
title: "Write up the gate-semantics pattern: a gate answers a question about this tree at this moment, and is read as answering one about the repository"
document_type: ticket
status: completed
created: 2026-09-17
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "The pattern and both its families are written where someone triaging a confusing gate result will actually find them, and each member names the check, what it actually measured, and what it was read as meaning"
---

# T216 — Gate semantics: what a green (or red) verdict actually claims

## The pattern

Collected across one evening and several concurrent sessions, then sharpened in a cross-session
thread. Stated once, because treating these as unrelated gotchas is how the next one gets made:

> **In every instance the gate answered a question about *this tree at this moment*, and was read as
> answering a question about *the repository*.**

## Family 1 — the answer was true, of something else

| Member | What it measured | What it was read as |
|---|---|---|
| **Duplicate ticket numbers** | `check:governance` scans the **working tree**; our branch has no other branch's tickets | "no number collision exists" — seven did, on `main` |
| **Duplicate schema versions** | same scan, same blind spot | "v66 is ours" — another branch also built v66 on 65 |
| **The live advisory clock** | `npm audit` queries a **live external database**, so the verdict is a function of wall-clock time, not committed state | "our diff broke the build" — GHSA-vrf4-mx87-p53w was published overnight. Corollary: `main` is **stale-green**, not green; "it passed" and "it would pass now" are different claims |
| **Stale `node_modules` after a dependency-major rebase** | the suite ran against the packages **actually installed**, which were the OLD major while `package-lock.json` already said the new one | "the gate validated this tree". **Confirmed twice, not hypothetical:** hit on the T215 merge, then reproduced exactly on this branch's rebase — `package.json` read `^3.3.11` while `node_modules` held 2.10.0, with nothing in any output saying so. **Run `npm ci` before trusting any local result after such a rebase** |
| **Status-drift is never checked in CI** | `checkStatusDrift` needs `origin/main` to diff against; CI's shallow checkout has none, so it **skips** | "CI is the gate of record, so drift was validated." It was not — and because CI is the gate of record for merging, **a green CI run is positive evidence that status-drift was NOT checked**, not evidence that it passed. The only place it runs is a local gate |
| **CI's shallow clone** | `actions/checkout@v4` with no `fetch-depth`, so `checkStatusDrift` and the run-record check have no `origin/main` and skip | "CI validated everything the local gate does". *(The duplicate scan DOES run in CI — do not over-read this.)* |
| **A merge-conflict sweep over stale literals** | `git` raised conflicts only where **both** sides touched a file, so the sweep covered conflicted files | "every stale schema-version literal is fixed". A file the OTHER side *added* carries its tripwire through the merge untouched and never conflicts — `electron/db/deviceIdentityKey.migration.test.js` arrived from `main` asserting `CURRENT_SCHEMA_VERSION).toBe(67)` and sailed through a v68 merge into a red CI run. **Sweep the predicate (`grep` every assertion), never the conflict list.** Same shape as the rest: a check ran, answered a narrower question than the reader assumed, and looked like coverage |

The duplicate-schema member is the one with teeth. Two migrations at one version do not merely fail a
check: the second to land is **never applied** on a database that already ran the first, because the
guard compares the stored version against the literal — and the app then reports itself fully
migrated. Silent data-shape divergence across a camp's devices, surfacing much later as unexplained
sync failures. **Only the rebase can catch it**, which is why the pre-merge rebase + re-run is
written as mandatory in the 2026-09-17 handoff rather than advisory.

## Family 2 — the tool abstained, and the abstention read as agreement

**This is the more dangerous half.** A stale answer is at least an answer. An abstention read as
agreement is the tool saying *"I did not look"* and the reader hearing *"there is nothing there."*

| Member | What it actually said | What it was read as |
|---|---|---|
| `npm run verify` printing `⚠️ VERIFY INCONCLUSIVE` **and exiting 0** | "this was not a pass" | a pass, by exit code |
| `graphify affected "selectJoinHost"` → *"No unique node match"* | "this symbol is not indexed" (a `useCallback` const) | "nothing depends on it" |

Both were read as reassurance here before being caught. The rule that follows: **read the verdict
line, never the exit code**, and treat "no results" as a claim about the measurement until shown
otherwise.

## This is not new, and the knowledge was not missing — it was loaded

The strongest evidence in this ticket is not that the lesson was written down and forgotten. It is
that it was written down **in the standing instructions both agents load at the start of every
session**, was in context tonight, and did not prevent the recurrence.

`~/.claude/CLAUDE.md:51-56` (identically at `/Users/gregfeitel/dev/.claude/CLAUDE.md`), section
**"Why this is a rule and not a suggestion,"** dated 2026-09-08, from deleting a ~14k-line sync
layer: hand-written `grep` sweeps produced **four separate false negatives** — an unquoted zsh
`--include` glob, a regex assuming a path prefix, a `| head` that truncated results, and `file -b`
misused as a byte detector. It closes with:

> Diligence inside the wrong method still converges on the wrong answer.

The same incident is recorded in-repo at `docs/work/handoffs/2026-09-09-post-stage6-handoff.md:110-113`,
which adds the detection rule:

> **A zero-result search is a claim about the SEARCH.** Two tells that it is lying: a count of zero
> for something you know exists, and a *uniform* zero across many items where you expected variation.

**And that 2026-09-08 incident already reached the conclusion this ticket would otherwise propose.**
Its answer was not "grep more carefully" — it was structural: *graph → `grep -a` → gate*, **three
tools with three different blind spots, none sufficient alone.** That recommendation was adopted, is
in the standing instructions, and **still did not prevent the 2026-09-17 recurrence.**

That is the argument. A recommendation the repository already adopted, in a case where adoption did
not prevent recurrence, is evidence about **enforcement**, not about advice. Writing the lesson down
again — however well — is the intervention already proven insufficient.

## A fresh instance, committed while writing this ticket

On 2026-09-17, sweeping every live branch for collisions on schema version, close codes and table
names, the sweep returned `<none>` / `unreadable` for **all six branches, uniformly**. That was read
as "no collisions on any branch" for long enough to nearly be reported as an all-clear.

It was not absent data. It was shell quoting in the loop — `git show` worked perfectly when run
directly a moment later, and `git branch -r` listed a branch (`claude/shoresh-elective-scheduling-b3bec8`)
that the same sweep's `ls-remote` pass had never shown at all. The real answer, once measured
properly, was that `origin/main` and that branch were both at v65 — information the broken sweep had
silently withheld.

**It was caught by the second tell from the 2026-09-09 rule** — uniformity where variation was
expected — which is the only reason this is a near-miss and not a wrong report. The rule worked; it
just had to be remembered at the right moment, which is precisely the property a mechanical check
does not depend on.

The point is not that more care was needed. **Care was present and insufficient**: this happened
while actively writing the document about this exact failure, with the governing rule loaded in
context at session start. Neither session anticipated it. That is what makes it structural rather
than careless, and why the mitigation has to be mechanical rather than another written rule:

- quote the glob;
- **assert the sweep found *something* before trusting that it found nothing** (`expect(files.length).toBeGreaterThan(N)`
  — the shape already used in `electron/sync/automerge/transportBoundary.guard.test.js` and
  `authRejectedSender.test.js`, both of which fail loudly if their scanner matches zero inputs);
- and treat a uniform result across many items as a defect in the measurement until proven otherwise.

## A member with a payload, from the same night

The taxonomy is not only about wasted time. T215's libp2p 2→3 migration swept
`electron/sync/automerge/**` and not `test/fuzz/**`, leaving
`test/fuzz/wireAndCrypto.fuzz.test.js` — a security fuzz test over adversarial byte sources — still
building its send-path fake as a callable pull-stream sink. The full gate caught it
(`TypeError: stream.send is not a function`).

**But the gate's own banner argued against believing it:** *"VERIFY INCONCLUSIVE … very likely a load
artifact, not a defect"*, because the machine was oversubscribed. The counts underneath read
`1 failed | 447 passed`. Taking the banner's advice — re-run and expect a flake — would have shipped
the defect. **The counts must be read before the explanation is believed**, and an inconclusive
verdict is not evidence in *either* direction.

The same lesson without a payload: the deletion in #470 swept only `src/` and `electron/` for its
removed symbols. It came back clean, so nothing broke — but the method had the identical gap.
**Sweep `test/` and `scripts/` too.**

## Family 3 — the paired test asserted something adjacent to the bug, not the bug (T220)

A third shape, distinct from staleness (Family 1) and abstention (Family 2): the check ran, on the
right file, and passed — but it was measuring a fact that happens to hold identically whether the
bug is present or fixed.

**T220** (`docs/work/tickets/T220-rollback-bare-equality-guard.md`): 20 of 29 rollback migrations
under `electron/db/rollback/` deleted their `schema_migrations` row with a bare
`WHERE version = N` instead of `WHERE version >= N`. The defect: rolling back vN on a database since
migrated to vN+1 strands the higher-version row, so `getSchemaVersion()` reports N+1 while vN's
tables are gone — a shape no migration path can produce and none will repair.

`v68_down.test.js:46` asserts `SELECT COUNT(*) c FROM schema_migrations WHERE version = 68` is `0`
after rollback. That assertion is **true identically** whether the production line reads `= 68` or
`>= 68` — a fresh single-version rollback deletes row 68 either way; the two predicates only diverge
on a row for a version *higher* than 68, which this test's fixture never seeds. The test looked like
line-level coverage of the exact statement containing the bug and covered an adjacent fact instead.
Same pairing existed in `v66_down.test.js`, and by construction in every other rollback's test.

| Member | What it measured | What it was read as |
|---|---|---|
| `v68_down.test.js:46` (and the equivalent in every rollback test) | "the row for exactly N is gone after rollback" — true under both `=` and `>=` | "the schema_migrations cleanup at this line is correct" |

The general form, worth naming alongside Families 1 and 2: **a test can cite the exact line
containing a bug and still not test the bug**, when the assertion's predicate happens to be
invariant across the buggy and fixed code paths. Line-level proximity between a test and a defect is
not evidence the test would catch that defect — only running the test against both versions of the
code is. (See `test-driven-development`'s verify-RED step, and the non-vacuity proof required in
T220: plant the bad pattern, watch the guard go red, remove it, watch it go green.)

## Cousins from the same evening — not gate mechanics, same error

- `pgrep verify.js` matched **another session's** gate in a different checkout; read as "my gate is
  running" when mine had never started. Process ownership is cwd, not binary path.
- BSD `sed -E 's/\bT192\b/…'` matched nothing and exited 0 — `\b` is unsupported — so a rename
  "succeeded" having changed nothing, and the rebase reported success.

## Scope

Documentation only. Do **not** try to "fix" the live-advisory property: the gate is supposed to learn
about new advisories; that is its job. What is worth having is the distinction recorded so a red
`security` step is triaged as *"which advisory, published when"* before anyone hunts for it in the
diff.

Material already exists in `docs/work/security/2026-09-14-security-program.md` ("What a green gate
does and does not mean") and in the 2026-09-17 handoff. This ticket is about putting it where a
person triaging a confusing verdict will find it — `TESTING_STANDARD.md` owns the gate list and is
the likely home.

## Does NOT count as done

- A list of anecdotes without the one-sentence pattern that makes them one thing.
- Presenting this as a new discovery. The 2026-09-09 precedent is the strongest evidence in the
  ticket and must be cited as prior art, not re-derived.
- Dropping the abstention family because it is subtler than the staleness family. It is the half that
  reads as reassurance.


## Resolution (2026-09-18)

Written to [`docs/governance/standards/TESTING_STANDARD.md`](../../governance/standards/TESTING_STANDARD.md),
§1, "What a green (or red) verdict actually claims" — placed inside the section that owns the gate
list and "what each run is worth," so a person triaging a confusing verdict lands on it. It states
the one-sentence pattern, then all **three** families the ticket documents (Family 3 / T220 was
added to the ticket body after the `archive_when` clause was written, which still says "both
families"; the write-up carries all three), each as a table naming the check, what it actually
measured, and what it was read as meaning. It cites the 2026-09-08 / 2026-09-09 precedent as prior
art rather than re-deriving it, keeps the abstention family, and ends with the mechanical
mitigations — recording, per the ticket's own argument, that the write-up is a triage aid and not
the enforcement.

A pointed cross-reference was added to
[`docs/governance/standards/WORK_RECORD_STANDARD.md`](../../governance/standards/WORK_RECORD_STANDARD.md)
§3.2, where the status-drift CI-skip member lives, pointing back to the pattern.
