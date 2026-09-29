---
title: "A retry says it is a retry: caller-declared arrival on the CLI/MCP path"
document_type: ticket
status: completed
created: 2026-09-29
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T299-identical-submissions-are-not-one-camper.md, docs/work/tickets/T285-preference-shape-adapters.md]
archive_when: "an agent driving the CLI or MCP can import two byte-identical preference sheets as TWO campers by declaring two different arrivals, and can retry a single import any number of times as ONE camper by declaring the same arrival; a caller that declares nothing gets today's content-derived behaviour and is TOLD that two submissions were indistinguishable rather than silently merged; and a test drives the real CLI/MCP path for all three cases asserting camper rows in the database"
---

# T303 — A retry says it is a retry

## Filed as T303, written as T301

The owner wrote this ticket as T301. That number was already taken, on `main`, by
`docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md` — a different, open,
`ui-ux-design` ticket filed the same day. `scripts/nextTicketNumber.js`, which aggregates every
in-use number across the root checkout, all 19 sibling worktrees, branches and PRs, reports T303 as
the next free one, and `checkTicketNumberUniqueness` in `npm run verify` would have failed the gate
on a second T301. The title, `archive_when` and body below are the owner's, unchanged.

## Why this was open

_Everything from here to "What shipped" is the state at filing, kept as written._

T299 made two children who answered identically into two campers on the director's panel, because the
panel mints an arrival per file selection. The machine path was left explicitly unsolved, and its
own `## Known limit at close` says why:

> `deriveImportedElectiveRunId` keys a CLI import on the file's bytes precisely so that re-sending the
> same bytes is an idempotent retry; under that declaration two identical files ARE one submission
> arriving once, and there is no second fact on that path to separate them. Giving the CLI a
> per-invocation arrival would split the two children and simultaneously fork every retry.

Owner, 2026-09-29: *"i don't think that the cli/mcp path was there. we do need to take that piece up.
i want it solved."*

## The shape of the answer, which T299 already identified

> Closing it needs an owner decision — most likely an explicit idempotency token supplied by the
> caller, so a retry can say it is a retry instead of being inferred from content.

That is the standard resolution for this class of problem and it is the right one: the caller knows
whether this is a new submission or the same one again, and nothing in the bytes does. Inferring it
from content is exactly the guess this program refuses to make everywhere else.

`scripts/preferenceSheetCli.js:374` currently passes `arrivalId: importedRunId`, and that run id is
content-derived. The fix is to let the caller state the arrival, and to keep today's behaviour when
they say nothing.

## What must remain true

- **An agent's retry stays idempotent.** This is not a nicety — a machine that cannot safely retry a
  failed call cannot be trusted to drive the software at all. Same declared arrival, any number of
  times, one camper.
- **Never say no at the machine interface** (standing owner ruling). A caller that declares nothing
  is not refused; it gets today's content-derived behaviour.
- **But it is TOLD.** Today two indistinguishable submissions merge silently on this path. Silence is
  the defect, not the merge — the same reasoning T297 used for held edits, and the same reasoning
  behind the whole residue surface. An agent that can see the collision can re-call with explicit
  arrivals; an agent that cannot see it has lost a child's answers and will never know.
- **The director's panel is unaffected.** It already mints an arrival per file selection. Do not
  re-open what T299 settled there.

## Non-goals

- Not a general idempotency framework for every IPC call. One path, one parameter.
- Not fuzzy matching or similarity scoring. Byte-identical only, as in T299.
- Not a change to `deriveImportedElectiveRunId`'s content-addressing, which is load-bearing for retry.

## Notes for whoever takes this

- `test/unattributedSubjectIdentity.test.js` pins the current behaviour under a "KNOWN LIMIT" name.
  That test must change deliberately, with the new expectation stated, not deleted.
- `deriveCamperId`'s `sub` mode takes `(submission, arrival)` and throws without an arrival — a
  default would silently restore the collision. Whatever the CLI/MCP passes must be explicit.
- Check the MCP tool surface (`preference_sheet_preview` / `preference_sheet_commit`) for where a
  caller-supplied token belongs, and follow T298's precedent for what a "read this sheet" tool may and
  may not do.
- Verify the premise before designing: read `scripts/preferenceSheetCli.js` around the `arrivalId`
  call site and confirm for yourself that it is content-derived.

## What shipped

**The premise was confirmed before anything was designed.** `scripts/preferenceSheetCli.js` passed
`arrivalId: importedRunId`, and `deriveImportedElectiveRunId` keys that run id on the file's bytes.
The pinning test was run first and passed 14/14 — including the assertion that two byte-identical
files land as one camper — so the defect was current, not inherited from a stale ticket.

**One parameter, one path.** `runPreferenceSheetCli` takes `arrivalId`; `preference_sheet_preview`
and `preference_sheet_commit` take `arrival_id`. Declared, it becomes the provisional subject's
arrival, so `deriveCamperId`'s `sub` arm keys on it. Undeclared, the content-derived run id stays the
arrival exactly as before. No general idempotency framework, no new entity, no schema version — this
identity is derived, and T299 needed no column either.

**`deriveImportedElectiveRunId` was not touched.** The declared arrival changes the SUBJECT's
identity only; the run id stays content-addressed, which is what keeps a retry idempotent.

**The caller is told.** A new `INDISTINGUISHABLE_SUBMISSION` residue item fires when the caller
declared nothing AND the subject this import derives already exists as an unattributed row. It is
read off the id `parsePreferenceSheet` already derived rather than derived a second time, because two
derivations are two rules. It carries the remedy — the message names `arrival_id` — so an agent that
never read the tool schema meets the parameter at the moment it can act on it. It is suppressed when
the caller declared, and when the subject is attributed.

**A malformed token is refused, not dropped.** A declared arrival becomes a component of a derived
id and `opaque()` throws outside `[A-Za-z0-9_.:-]`. Letting the throw escape would break this
function's "never throws past this boundary" contract; ignoring the declaration would merge the two
children the caller was declaring apart. So it returns the ordinary `ok: false` shape with a message
naming the alphabet — the same try/catch shape `commitElectiveRun` already uses for its
caller-supplied run id. An EMPTY string is declaring nothing, not declaring badly, and is not refused.

### Evidence, by execution

`test/callerDeclaredArrival.test.js` drives BOTH the CLI core and the real MCP handlers and asserts
camper rows, preference rows and coordinates — never a message. Fixtures are anti-sorted (arrival
tokens and filenames both sort opposite to import order) so no assertion can pass on a lucky sort,
and the hardest case gives two children identical bytes AND an identical basename, leaving the
declaration as the only distinguishing fact.

Three defects were planted and the red confirmed to land on the data:

| planted | red |
| --- | --- |
| arrival minted per invocation (the trap) | 7 failures, all row counts: retry forks 1 → 2 |
| declared arrival forked per invocation | 3 failures, row counts 1 → 3 and 1 → 2, CLI and MCP both |
| residue emitted without a real collision | 3 failures on the non-vacuity assertions |

## Known limit at close

**Two declared arrivals on byte-identical files share ONE `elective_assignment_runs` row, and that
row's `name` and `source_filename` are whichever import ran last.** Confirmed by execution, not
inferred: two arrivals on identical bytes produce `campers: ["ari", "noa"]` and 8 preference rows —
correct — alongside a single run row named `noa.csv`. The run id is content-derived and was
deliberately left that way (this ticket's own non-goal), so identical bytes are one run however many
arrivals declare them.

Nothing is lost by it. Each camper keeps its own label, its own four answers and its own coordinates,
and the attention surface lists both by their own names, so the director's actual task — name these
two children — is unaffected. What is wrong is only the run's label, and only in the case where two
submissions were byte-identical. Closing it means letting the declared arrival participate in the run
id, which is a larger change than this ticket's "one path, one parameter" and would want its own
judgement about what a run means when two children submit the same bytes.

**Re-importing the same bytes AFTER a director has named the subject forks the child, and this
residue does not fire.** Found by an altitude review of this change and then confirmed by execution:

```
import 1, nothing declared -> [{display_name:"ari", is_unattributed:1, external_id:"sub-951de8…"}]
director names it           -> [{display_name:"Aviva Feldspar", is_unattributed:null, external_id:null}]
SAME bytes imported again   -> ok=true, residue ["UNATTRIBUTED_SUBJECT"], 8 preference rows
                               [{"Aviva Feldspar", null, null}, {"ari", 1, "sub-951de8…"}]
```

One child, two identities, her week stored twice, and nothing says so. **Pre-existing, not introduced
here** — `attributeElectiveSubject` rekeys the provisional row onto a name-derived id and drops the
submission key, so the row this residue probes for is gone and the re-import derives a fresh
provisional subject. Before this ticket the same fork happened with no telling at all.

Left unfixed deliberately, because the fix is a design decision rather than wiring: closing it means
carrying the submission key onto the canonical row at attribution (or probing `external_id` across
attributed rows too), and that requires deciding what a named camper's submission key MEANS — whether
a child who legitimately submits a second, different sheet should collide with her own first one. Not
a question this ticket's "one path, one parameter" scope should answer.

**Two follow-ups the same review named, neither in this ticket's `archive_when`:**

- A CLI merge leaves no PERSISTENT director-facing trace. `INDISTINGUISHABLE_SUBMISSION` is an
  ephemeral tool result read by the agent; residue is not persisted, and `buildStructureIssues` fires
  its "another unnamed sheet has exactly the same answers" wording only when TWO unattributed rows
  share a submission key — which is precisely the case a merge does not produce. So the director sees
  the ordinary "who is this?" with no hint that two children may be behind one row.
- `scripts/preferenceSheetCli.js`'s `resolveSubject` and `src/ingest/preferenceImport.js`'s
  `readPreferenceSheet` are two spellings of one subject-identity rule; the CLI reaches past
  `readPreferenceSheet` to `parsePreferenceSheet` directly. The fork predates this ticket, which
  widened it by adding the declared-arrival default to the CLI's copy only. The file's own comment
  ("ONE RULE, shared with the import screen … two rules fork one child into two subjects depending on
  which door their sheet came through") names the principle at stake.

A third, one line from here and deliberately not taken: guarding `name`/`source_filename` in
`electron/ops/commitElectiveRun.js` the way `status` is already guarded (`existingRun ? undefined :
…`) would erase the first known limit's symptom by letting the FIRST document's label win. It is two
lines, but it changes re-commit behaviour for every caller including the director's panel, which is
outside this diff.
