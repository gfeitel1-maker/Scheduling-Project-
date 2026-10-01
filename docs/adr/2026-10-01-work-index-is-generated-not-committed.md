---
title: "docs/work/INDEX.md stops being a committed file — generated on demand, never a merge target"
document_type: adr
status: proposed
authority: normative
implementation_state: in-progress
date: 2026-10-01
task_class: documentation-governance
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_adrs: []
related_specs:
  - docs/work/specs/2026-07-30-typed-run-records-and-compiled-work-index-design.md
related_tickets:
  - docs/work/tickets/T261-ci-minutes-duplicate-main-runs.md
  - docs/work/tickets/T283-board-truth-audit-gate.md
related_runs:
  - docs/work/runs/2026-10-01-work-index-no-collisions.md
supersedes: []
affects:
  - scripts/build-work-index.js
  - scripts/check-governance.js
  - .gitignore
  - docs/work/README.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - test/governance.test.js
  - scripts/check-governance.test.js
  - scripts/build-work-index.test.js
---

# ADR: docs/work/INDEX.md stops being a committed file — generated on demand, never a merge target

## Context

`docs/work/INDEX.md` is a 327-line board compiled from frontmatter across five `SOURCE_DIRS`
(`docs/adr`, `docs/work/tickets`, `docs/work/specs`, `docs/work/runs`, `docs/work/handoffs`) by
`scripts/build-work-index.js`. It is committed, and `scripts/check-governance.js`'s
`checkIndexFreshness` (blocking, not in `ADVISORY_CODES`) rebuilds it in memory and byte-compares
against the committed copy on every `check:governance` run — the second-cheapest step of
`npm run verify`.

Every PR that files a run record, opens a ticket, or flips a ticket's status touches the *same*
regenerated file in the *same* sections (Open work / Decisions / Runs). Measured on this branch
family the night of 2026-09-30/10-01: five of six consecutive merges (#675–#678, #681) needed a
rebase and a full CI re-run purely to reconcile INDEX.md, and #672 bounced twice for the same
reason. The failure is structural, not a process-discipline gap — any two PRs open at once that
each add a ticket or a run record will touch overlapping lines of a file neither one "owns." A
diff-gate on a committed generated file cannot fix this, because the gate is reacting to the
collision, not preventing it. A `.gitattributes` union merge driver is not a fix either: GitHub's
server-side merge (the only merge path this repo uses — PRs merge via the GitHub UI/API) does not
apply local merge drivers; only a `git merge` run on a machine with that driver configured would
honor it, and `graphify-out/graph.json merge=graphify` already demonstrates the same limitation
for a different generated file in this repo.

The owner's ruling on the board was "yes, let the second worker take it," relayed with this
framing of intent: the approval is for the **outcome** — parallel PRs stop colliding on this file
and no CI cycles are lost to it — not for a specific mechanism. The owner added one constraint:
because this repository goes public, `docs/work/INDEX.md` is a reader's entry point on GitHub, so
if it stops being committed, something committed must still lead a reader from the repo root into
the tickets and run records — either a short pointer file or an index regenerated on `main` by a
post-merge action rather than by PRs.

## Facts established in this tree (2026-09-30/10-01), not re-derived by Maker

- `.github/workflows/gate.yml` has **no `push: branches: [main]` trigger** (removed by T261).
  Triggers are `pull_request`, a daily `schedule` (`15 9 * * *`), and `workflow_dispatch`.
  `permissions: contents: read`. T261's measured baseline: 100 runs over ~3 days, 44 were
  push-to-main, ≥27 of those re-verified a tree byte-identical to a PR run just merged, costing
  ~255 of ~994 wall-minutes in that window — 46% of a 2,000 min/month Free-plan allowance burned
  on reruns of an already-green tree. A single `npm run verify` run costs ~521s, dominated by
  `vitest run` (473s, 529 files, 6976 tests); `npm ci` is 117s uncached.
- **Nothing links to `docs/work/INDEX.md` with a markdown link.** All ~28 referring documents name
  the path in an inline code span. `test/governance.test.js`'s link-integrity test matches
  `]\(...\)` over `ACTIVE_DOCS` (built by `walk()` — a live filesystem scan, not `git ls-files`)
  and resolves targets with `existsSync`. It has no opinion on `INDEX.md` today because nothing
  links to it, and `ACTIVE_DOCS` includes it only when `walk(docs/work)` finds it on disk at test
  time — true whether the file is tracked or gitignored, as long as it physically exists in that
  checkout when the test runs.
- `build-work-index.js` already `EXCLUDED`s `docs/work/INDEX.md` from its own inputs (line 37) and
  emits a `GENERATED_HEADER`. The **only** reader of the committed copy is
  `checkIndexFreshness`'s byte-compare inside `checkAll` (`scripts/check-governance.js`). No other
  script, no launchd job, reads it as input.
- `.gitignore` already carries the precedent for this exact shape: `graphify-out/` ("regenerated
  locally; never committed") and `electron/build-info.json` ("Generated at package time").
- `GOVERNANCE_INDEX.md` has two table cells, the "Current-state reference" column for the
  **Documentation / governance** and **Test infrastructure** rows, both reading `` `../work/INDEX.md` ``.
  Both go false if the file is no longer present by default.
- `WORK_RECORD_STANDARD.md` describes the mechanics in three places: the reference-field note
  (around the "declare edges in one direction" section), §3's closure guidance ("The board
  (`docs/work/INDEX.md`) is generated... regenerate with `npm run index:work` and never
  hand-edit it"), and §6 ("The generated index" — committed-copy staleness reporting).
- `docs/work/` holds directories not among the five `SOURCE_DIRS` (`architecture-reports`,
  `evidence`, `onboarding-reconciliation`, `plans`, `security`, `testing`) plus five loose
  top-level `.md` files. Any committed pointer must be honest that the five source directories are
  INDEX.md's *inputs*, not a complete map of `docs/work/`.

## Decision

**Option A: `docs/work/INDEX.md` becomes an untracked, gitignored generated artifact,
regenerated by `check:governance` on every run (in memory, compare-only — see "Is the gate a
writer?" below) and by `npm run index:work` on demand. A short, committed
`docs/work/README.md` is the public entry point, naming the five source directories, what each
holds, and the one command (`npm run index:work`) that builds the board. `index-stale` and
`index-missing` are both removed from `checkIndexFreshness` / `checkAll`, since neither is
meaningful once there is no committed copy to be stale or missing.**

Confidence: high. This is the smallest responsible shape that satisfies the owner's stated
outcome (no more PR collisions on this file, zero CI minutes spent on it) and the owner's stated
constraint (a public reader still has a committed path into the work records).

### Rejected: Option B — commit INDEX.md, but write it only from a post-merge Action on `main`

Rejected on the owner's own numbers, not on taste. This repo removed `push: branches: [main]`
*in this exact workflow* for a measured 46%-of-budget cost from runs that re-verified a
byte-identical tree. A post-merge "regenerate and commit" Action reintroduces a push-to-main
trigger — a smaller one (it need not run `npm run verify`, just `index:work` + `git commit`), but
it still runs on every merge to `main`, which T261 explicitly identified as the expensive case
(every merge, not "occasionally"). It also requires `contents: write` on a workflow, where the
repo's one existing workflow deliberately grants only `contents: read` — that is itself a
security-posture change needing its own sign-off, not a one-line diff. And it does not remove the
underlying defect: `main` is now correct only in the window after the bot's commit lands, which is
a new kind of staleness (committed-but-behind) in place of the old one (committed-but-conflicting).
It trades a merge-conflict problem for a trust-the-bot-ran problem, for no CI-minute savings and a
new write-permission surface. If the owner later wants INDEX.md GitHub-browsable with zero edit
lag, Option A's README pointer plus `npm run index:work` run locally before a release tag is a
smaller, reversible way to get there than a standing write-permissioned workflow.

### Rejected: Option C variants surfaced by divergence

- **Per-document generated fragments** (each ticket/ADR embeds its own "see also" footer,
  generated on save) — trades one collision surface for N, since every document a PR touches
  would need its footer regenerated too; strictly worse fan-out than one file.
- **GitHub Pages / read-time generation** — adds a deploy pipeline and a second place
  ("is the Pages site fresh?") to go stale, for a repo whose actual readers today are agents and
  the owner reading files directly in the checkout, not a browsable marketing site. No evidence
  this is a near-term need; revisit if/when the repo goes public and traffic data says otherwise.
- **Sharding INDEX.md by section** (Open work / Decisions / Runs as three files) — reduces
  collision *frequency* but not *existence*; two PRs that both open tickets still collide on the
  ticket shard. Does not address the root cause, only dilutes it.
- **Drop the generated board entirely, replace with a query command** (`npm run work:query
  "open tickets"`) — genuinely interesting for agent consumption, but fails the owner's public-
  reader constraint outright: a cloned-but-not-run repo has nothing at all for a human to read.
  Could be a *future addition alongside* Option A's README, not a replacement for it; out of scope
  here.

## Design for Maker

### Fresh clone / CI / reader surfaces (answered explicitly, per the brief's checklist)

- **Fresh clone, before any command runs:** `docs/work/INDEX.md` does not exist (gitignored, never
  committed). `docs/work/README.md` exists, committed, and is the entry point.
- **CI shallow checkout:** same as fresh clone — `actions/checkout@v4` does not restore gitignored
  files. `index-missing` is removed as a finding, so this is not a failure state.
- **A reader on GitHub browsing `docs/work/`:** sees `README.md` rendered by GitHub's directory
  view, naming the five source directories and the regeneration command. Does not see a live
  board unless they clone and run `npm run index:work` — this is the one piece of the
  outcome the owner's constraint explicitly accepts giving up, in exchange for zero collisions.
- **`npm run verify` when INDEX.md is absent:** passes — `index-missing` finding removed.
- **`npm run verify` when INDEX.md is present (a dev ran `index:work` locally) and fresh:**
  passes, same as today.
- **`npm run verify` when INDEX.md is present and stale:** `checkIndexFreshness` as a *finding*
  function is deleted entirely (no committed copy is ever authoritative to compare against), so a
  stale local copy is simply a stale local file — never a gate finding, never blocking. This is a
  deliberate loss of the "forgotten regeneration surfaces as a finding" property `WORK_RECORD_STANDARD.md`
  §6 currently describes; that sentence must be rewritten, not left stale (see affected docs below).

### Is `check:governance` a writer?

**No — keep it compare-only, do not have it write the file.** A gate that mutates the tree as a
side effect of "checking" is a different contract than every other check in that script (pure
read + report), and a writer-gate interacts badly with `scripts/gate.sh`'s SHA-stamping (the stamp
declares tree-clean state at run start; a gate that then writes a new untracked file mid-run is
fine only because the file is gitignored and `integration.sh`'s clean-tree classification walks
`git status`, which ignores gitignored paths — confirm this in `scripts/integration.sh`'s existing
PHANTOM-INDEX-vs-real-uncommitted-work classification logic before relying on it, since that
script already reasons carefully about what counts as "dirty"). Since there is no committed copy
to compare against, there is nothing for `check:governance` to write *to* — `generate(root)` is
called, if at all, only by `npm run index:work` (explicit, developer-invoked) and, optionally, by
a lightweight local convenience (e.g., a `predev` or `postinstall` hint) that Maker should treat as
optional polish, not part of this ADR's required scope.

### Exact removals / additions (bound the footprint — do not exceed it)

1. `scripts/build-work-index.js` — no change to `SOURCE_DIRS`, `EXCLUDED`, or `generate()`. The
   file remains exactly what builds the board on demand.
2. `scripts/check-governance.js` — delete `checkIndexFreshness` and its two call sites' findings
   (`index-missing`, `index-stale`) from `checkAll`. Delete the header comment block that
   justifies `index-stale` staying blocking (it describes a rule that no longer exists). Leave
   `generate`/`INDEX_PATH` imports only if something in this file still needs them for the README
   source-directory check (see item 6); otherwise remove the now-dead import.
3. `.gitignore` — add `docs/work/INDEX.md` under a comment following the existing
   `graphify-out/` / `electron/build-info.json` precedent style ("regenerated on demand; never
   committed — see docs/adr/2026-10-01-work-index-is-generated-not-committed.md").
4. Remove `docs/work/INDEX.md` from version control (`git rm --cached`), do not delete the
   generation capability.
5. `docs/work/README.md` — new, committed. Names each of the five `SOURCE_DIRS` entries and what
   it holds, names the other `docs/work/` subdirectories that are *not* INDEX inputs
   (architecture-reports, evidence, onboarding-reconciliation, plans, security, testing, plus the
   loose top-level files) without conflating the two lists, and states the one command
   (`npm run index:work`) that builds the board locally.
6. A test (new case in `scripts/build-work-index.test.js` or `test/governance.test.js`) that reads
   `docs/work/README.md` and asserts every string in `SOURCE_DIRS` appears in it — so the README
   cannot silently drift from the generator's actual inputs. This is the mechanical anti-drift
   check the brief requires.
7. `docs/governance/GOVERNANCE_INDEX.md` — the two "Current-state reference" cells currently
   reading `` `../work/INDEX.md` `` (Documentation/governance row, Test infrastructure row) change
   to `` `../work/README.md` `` (or to prose pointing at "`npm run index:work`'s output" if a
   static link reads as overclaiming freshness — Maker's call, but state which was chosen and
   why).
8. `docs/governance/standards/WORK_RECORD_STANDARD.md` — rewrite only the sentences that literally
   describe INDEX.md's committed-ness and the staleness-finding mechanism (the §3 closure note,
   §6 "The generated index"). Do not touch anything else in the standard — amending it beyond
   this mechanical correction is the Article IV "standard would need to change" gate (see below),
   and this ADR's scope is the mechanical correction, not a broader revision.
9. `test/governance.test.js` — add the explicit, tested stance the brief asks for: a test that
   asserts `docs/work/INDEX.md` is **not** tracked by git (e.g.
   `execSync('git ls-files docs/work/INDEX.md')` returns empty) — making the "accidentally green
   either way" link-integrity behavior into a deliberate, pinned fact instead of a coincidence.
10. `scripts/check-governance.test.js` — delete the three `checkIndexFreshness` cases
    (equal/differing/null), since the function no longer exists. Do not leave them skipped; remove
    them, since a skipped test for a deleted function is worse than no test.

### Test plan (red before green)

- **Red 1:** `scripts/check-governance.test.js`'s three existing `checkIndexFreshness` cases
  (equal → `[]`, differing → `['index-stale']`, null → `['index-missing']`) must be deleted as
  part of this change — Maker deletes them in the same commit that deletes the function, so there
  is no red/green pair here; instead the removal itself is the evidence the mechanism is gone.
  State this plainly in the commit/PR rather than manufacturing a synthetic red.
- **Red 2 (genuine):** write the README-drift test first, against a `docs/work/README.md` that
  does not yet exist (or exists but omits one of `SOURCE_DIRS`) — it must fail with a message
  naming the missing source directory, before Maker writes the README that makes it pass.
- **Red 3 (genuine):** write the "INDEX.md is not tracked" test first, against the *current*
  tree where `docs/work/INDEX.md` **is** tracked — confirm it fails (`git ls-files` returns the
  path) before `git rm --cached` runs, then confirm it passes after.
- **Green confirmation, not a new red:** run `npm run check:governance` once with INDEX.md absent
  (fresh-clone simulation: `rm docs/work/INDEX.md`) and once with it present-but-stale (hand-edit
  a line) — both must exit 0 with no `index-*` finding, demonstrating the finding class is
  genuinely gone, not merely downgraded to advisory.
- `test/governance.test.js`'s existing link-integrity test must stay green unmodified — it already
  has no opinion on INDEX.md's links one way or the other; confirm this by running it both with
  and without a locally-generated INDEX.md present and showing no diff in pass/fail.

### Human gates this design triggers (CONSTITUTION.md Article IV)

- **Deleting a tracked file** (`docs/work/INDEX.md` from version control) — explicit gate, listed
  in the brief's footprint note. Flag to Governor/owner before Maker runs `git rm --cached`.
- **This ADR itself**, once written, needs the human `accepted` flip — not performed here per the
  task's instruction (`status: proposed`, do not write `accepted`).
- Not triggered: no change to `.github/workflows/*` (Option A touches none), no change to a
  security tradeoff, no standard is being substantively revised (only the mechanical sentences
  describing a mechanism that no longer exists — if Maker or Governor judges any edit to
  `WORK_RECORD_STANDARD.md` goes beyond that, stop and escalate rather than deciding it reads as
  mechanical).

## Open questions for Governor

1. The owner's constraint names two acceptable mechanisms for a committed reader-facing artifact
   ("a short committed README pointer, or a generated index regenerated on main by a post-merge
   action"). This ADR picks the README and gives the CI-cost evidence against the Action. If the
   owner specifically wants the GitHub-browsable live board badly enough to accept a standing
   `contents: write` workflow and the reintroduced push-to-main cost, that is a product preference
   this ADR cannot resolve technically — surface it rather than silently overriding the owner's
   named second option.
2. `GOVERNANCE_INDEX.md`'s two cells: static link to `README.md` vs. prose pointing at the command.
   Left as Maker's call in the design above; if Governor wants a specific one, say so before Maker
   starts.
