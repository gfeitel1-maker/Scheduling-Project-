---
title: "History rewrite: purge real camp identity and personal paths from public git history"
document_type: ticket
status: open
created: 2026-09-05
task_class: documentation-governance
archive_when: "the owner has ruled on the 2026-09-25 re-scope below — either (a) the rewrite has landed, the remote reflects it, and GitHub's cached objects are confirmed unreachable, or (b) the rewrite is recorded here as declined on the measured evidence and the forward-looking guard has shipped"
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
---

# T120 — History rewrite: purge real camp identity and personal paths

## Why

A working-tree scrub removed a real camp's identity from the tip, but **git history still
contains all of it**. Removal from the tip reduces casual discovery; it does not remove the material.

The owner has explicitly asked for a history rewrite and "complete removal of any potentially
sensitive material from any public space" (2026-09-05).

> **Two premises in the text below are stale — read the 2026-09-25 re-scope at the bottom first.**
> _Prior: this ticket said "the repository is **public**". It is **private** as of some point after
> 2026-09-05, which is currently the whole mitigation._ _Prior: it cited commit `4a7ef13` as the
> tip scrub; that SHA no longer resolves in this repository._ And the rewrite is **not** ~841
> commits from `6b14293` — the camp name is present in the **initial commit** (`08a0aa89`,
> 2026-04-21), so a rewrite is the entire history.

## Scope — what the rewrite must cover

Two independent categories, deliberately bundled so history is rewritten **once**:

**1. Real camp identity**
- `docs/work/specs/samples/campA-bunk-schedules.txt` and `campB-<campname>-by-day.txt` — real
  camp, division, and bunk names. Introduced in `6b14293` (2026-07-30), ~841 commits back.
  `docs/work/specs/samples/INGESTION_SAMPLES.md` stated outright that the names were real.
- The **filename** itself carried the camp's name.
- `src/screens/CampBootstrapScreen.jsx` shipped a hardcoded `placeholder` naming a real camp — the name was
  **in the product**, on the camp-creation screen. Also `src/localClient.mock.js`'s demo host.
- The name appeared as a worked example in 10 committed docs (ADRs, specs, archives).

**2. Personal filesystem paths**
- 14 commits contain the developer's absolute home path. The tip was scrubbed in #248; the history rewrite
  was deferred at that time and is still outstanding. Fold it in here.

## Known constraints and traps

- **A rewrite does not fully erase on GitHub.** Rewritten commits stay reachable by direct SHA
  until GitHub garbage-collects. Complete removal requires asking GitHub Support to purge the
  cached objects, or deleting and re-pushing the repository. The repo currently has **0 forks**,
  which makes the delete/re-push option genuinely viable and the most complete.
- **Blast radius.** Rewriting from `6b14293` changes every SHA since (~841 commits). Every
  active worktree and every peer session branch based on old SHAs is orphaned. Before starting:
  confirm `git worktree list` is clear of in-flight work and tell any concurrent sessions.
- Consider whether to make the repo private for the duration rather than under time pressure.
  The owner declined this on 2026-09-05, judging the exposure low ("if it says camp a and camp b
  that's not worth flipping") — revisit only if scope grows.
- `.ingest-incoming/` (including `shemesh-2025.txt`) is **not** in scope: gitignored, never
  committed, and Shemesh is a fabricated camp the owner drafted. Do not spend effort there.

## Sequencing

Queued behind the four branches in flight as of 2026-09-05 (`anchor-contention`,
`ingest-location-approval-gate`, `T119-location-capacity-provenance`, `synthetic-sample-data`).
None of them rewrite history; all are ordinary commits on `0cea17b`. Do the rewrite only once
they have merged and their worktrees are removed.

## Done when

- No commit in history contains the real camp name (in content, path, or product string).
- No commit in history contains the developer home path.
- The remote reflects the rewritten history.
- The GitHub-side cached-object question is resolved deliberately — either purged via Support,
  or the repo deleted and re-pushed, or consciously accepted and recorded here as accepted.


---

## 2026-09-25 re-scope — measured, and the conclusion is not the one this ticket assumed

Re-opened because T261 (CI minutes) surfaced a second, unrelated reason to want the repo public:
**a public repository gets free unlimited GitHub Actions minutes.** That made it worth measuring
what is actually in the history rather than continuing to reason from this ticket's 2026-09-05
prose. Everything below is measured on the repository as it stands today.

### Cost of the rewrite, measured

| | |
|---|---|
| Commits rewritten | **1,466** on `main` (1,705 across all refs) — the camp name is in the initial commit, so all of them |
| Local worktrees orphaned | **32** |
| Remote branches to force-push | 42 |
| PRs whose history breaks | 542 |
| Forks / stars | **0 / 0** — no evidence anyone copied it |
| Camp name | **0 files at tip**, 30 commits in history, 1 committed filename (`docs/work/specs/samples/campB-<camp-name>-by-day.txt`, deleted from tip) |
| Developer home path | **11 files at tip** (not 0 — see regression), 29 commits in history (not 14) |

### What is actually in the history — full sweep

Scanned **every unique text blob in all of history** (9,101 blobs, 257 MB of text) for PII and
secret patterns. Results:

| pattern | unique hits | what they are |
|---|---|---|
| phone numbers | **0** | — |
| SSN-shaped | **0** | — |
| date-of-birth-shaped | **0** | — |
| JWTs, Slack / Google / Stripe keys, Supabase URLs | **0** | — |
| PEM private key | 1 | `scripts/security-gate.test.js` — a fixture proving the secret detector fires |
| AWS access key | 1 | the canonical AWS *documentation example* key (`AKIA…EXAMPLE`, redacted here — writing it out trips this repo's own secret gate, which is itself a datapoint), same file |
| GitHub token | 1 | `ghp_0123456789…` — an obvious placeholder, same file |
| email-shaped | 17 | **all** npm package authors (from the lockfile), `git@github.com`, `you@example.com`, `noreply@anthropic.com`, two `*-pkg@1.0.0.json` filenames, and 5 fuzz-generated strings |

**There are no real personal emails, no phone numbers, no dates of birth, no identifiers, and no
live secrets anywhere in this repository's history.** The three secret-shaped hits are all in the
test file for the secret detector itself.

The two non-synthetic sample files were characterised directly: both are **schedule grids, not
rosters** — columns are cohort names (`Yeladim`, `Tzofim`, `Chalutzim`, `Adom 4's`, generic Hebrew
age-group words common to many Jewish camps), cells are activity names. **No camper names, no
contact details.** The two camper-preference CSVs are named `fabricated-*` and are exactly that.

So the residual material is: **a real camp's name, a set of cohort labels, some activity names, and
the developer's macOS username** — which is already public as his GitHub handle.

### The finding that actually matters: the scrub regressed, and nothing guards it

PR #248 scrubbed the developer home path and the record states "verified 0 occurrences remain in
the tree." **It is back in 11 tracked files at `HEAD`** — `scripts/gateLock.test.js`,
`scripts/observeRun.js`, `scripts/memoryProject.{js,sh}`, `scripts/consolidation/{gather,run}.sh`,
`docs/adr/2026-09-15-opinion-report-dispatch-provenance.md`, three tickets, and a gate report.
There is **no gate** preventing re-introduction.

This reframes the whole ticket. A one-time history rewrite cleans the past; it does nothing about
the fact that the tip re-accumulates this material on its own. **Once the repository is public,
every future commit publishes live** — and agent sessions write local paths, sample data and ingest
evidence into `docs/` continuously. The ongoing risk is strictly larger than the historical one,
and it is the only part a rewrite does not address.

### Recommendation

**The guard is the valuable work. The rewrite is probably not worth its blast radius.**

1. **Build the forward-looking guard first** — a gate step that fails on the real camp name, the
   developer home path, and PII/secret patterns in tracked files. Small, cheap, and it is the thing
   that makes public safe *going forward*. It should have existed since #248.
2. **Then the owner rules on the rewrite itself**, with the evidence above rather than the
   2026-09-05 assumption. The measured case against it: 1,466 commits, 32 orphaned worktrees, 42
   force-pushed branches, 542 broken PRs, plus a GitHub Support purge or a delete-and-recreate — to
   remove a camp name and a username, with 0 forks and no PII or secrets found.
3. **Do not let CI cost drive this.** After T261 the overage is ~2,400 min/month, which at GitHub's
   $0.008/min Linux rate is roughly **$19/month**. That is the cheap fix for the cost problem, and
   it removes the one genuinely dangerous temptation here: flipping to public *before* the purge is
   verified, to save money. Confirm the rate in billing rather than taking this number on trust.

### Sequencing, corrected

_Prior: this ticket was queued behind four branches from 2026-09-05; those are long merged._ If the
rewrite is ever approved it must run with the fleet quiesced — **32 worktrees** and both peer
sessions would be orphaned — from a fresh clone, never from a worktree (shared `.git`).

### Owner decision needed

- Ship the guard? (recommended, independent of everything else)
- Rewrite history, or record the rewrite as declined on this evidence?
- Go public for free CI, or pay the ~$19/month and stay private?
- ~~**Provenance question:** is `campA-bunk-schedules.txt` real?~~ **RESOLVED 2026-09-25 — the owner
  confirms campA is NOT a real camp.** Independently corroborated: PR #285's own description records
  that the campA/campB samples were "replaced with a fabricated, length-preserving mapping." So
  **no real-camp material ships at the tip.**

### GitHub metadata — the surface the history sweep did not cover, now measured

Going public also publishes PR descriptions, review comments and Actions logs, which live in GitHub's
metadata rather than in git objects. Scanned all **542 PRs** (titles + bodies, 1.32 MB): **0 emails,
0 phone numbers**, and exactly **three** hits — the camp name twice in **PR #285** and the home path
once in **PR #248**, which are the scrub PRs *describing the removal*.

PR bodies are **editable in place**, so this is three edits rather than anything structural. Not done
unilaterally — it is a change to published descriptions and is the owner's call. Actions logs were
not scanned (they expire on their own retention schedule).

### Next action

[T263](T263-privacy-guard-before-public.md) builds the forward-looking guard, which is the
precondition for going public. The rewrite remains an open owner decision, and the evidence above
argues against it.

---

## 2026-09-27 — the tip re-accumulated real camp identity, and a shape rule now blocks it

Found during T278 review, out of that ticket's scope, folded in here rather than spun into a
competing ticket.

### The correction this section exists to make

The 2026-09-25 re-scope above states **"Camp name: 0 files at tip"** and concludes **"no real-camp
material ships at the tip."** Both were wrong as written. The sweep measured **one** camp name — the
one whose digest the guard holds — and the conclusion was drawn about the whole class. A day later
`docs/adr/2026-09-26-per-cell-elective-preferences.md` cited a real JCC camp, division and season at
the tip; two August ADRs had been carrying a different real camp all along.

This is the same failure mode twice: #248's "verified 0 occurrences remain" regressed to 11 files,
and #285's sweep answered a question adjacent to the one asked. **Both gates were green on that
tree** (`security-gate.js` exit 0, `check-governance.js` exit 0) while seven files named real camps.

### What was actually present, and what was scrubbed

A shape-based sweep found **more than the targeted grep did** — including real camps nobody had
looked for:

| what it was | where | disposition |
|---|---|---|
| a day camp's name, paired with a JCC's | 2 ADRs + 1 spec | → "a day camp's", "a real camp's activity-list pdf" |
| a JCC's name + its division + season | 2 ADRs + **`src/engine/buildElectiveAssignments.js`** | → "a real camp's grade-5 2024 selection sheet" |
| a second JCC's name | 2 ADRs | → "a JCC grid" |
| a second camp's name | 3 docs + **5 `src/` files incl. test fixtures** | → `Camp B` (this repo's existing anonymisation) |
| a real camp's name inside a test-fixture camp name | 3 test fixtures | → `Camp Kinneret` (already-synthetic demo name) |
| three published-glossary citations | field-voice research | → "four movement-affiliated camps (Conservative and Reform)" |
| a published Color War sheet's camp | facility-audit sources | → "a published Color War sheet" |
| a camp used as an illustrative example | `electron/sync/automerge/discovery.js` comment | → `Camp Kinneret` |

The names themselves are deliberately **not** written here. This table was drafted with them in it and
the new Rule 4 went red on this very file — which is the rule working, and is why it reads this way.

**Deletion was rejected in favour of re-description.** These names are *evidence provenance* — an
argument rests on them — so a straight deletion damages the ADR. The `_Prior:` /
`doc-refs:historical` convention was also rejected: it exists so a doc naming a repo path *in order
to say it is gone* stays traceable, and it works by **preserving the name**, which is the one thing
this must not do. Nothing here is being said to be gone.

**Cleared, not scrubbed:** `Camp Willowbrook` is the product's own fabricated placeholder
(`src/screens/CampBootstrapScreen.jsx`); `Shemesh` is confirmed fabricated above; `Chai`,
`Maccabiah` and `TAVOR` are generic Hebrew / Jewish-camp vocabulary. The one committed binary that
could have carried identity — `docs/work/handoffs/assets/2026-09-17-individual-elective-scheduling-handoff.docx`
— was unzipped and scanned (41 KB of extracted text, **zero hits**); the two camper-preference CSVs
are `fabricated-*` and are.

### The guard: a shape rule, not more digests

The brief for this work assumed the guard missed this because `IDENTITY_TOKEN_LENGTHS` is
`{5, 10}`. That is only half right and the difference matters: two of the four tokens involved are
length 5, so they **were** hashed and tested — they simply were not in the digest set. Only the
7-letter place name and the 3-letter organisation acronym are untestable at any digest.

**Adding camp-name digests was considered and rejected.** It is a denylist against an **open set**:
every new artifact arrives before its digest does, so it would not have caught either ADR that
prompted this. And because SHA-256 of a short lowercase word is trivially brute-forced — the guard's
own comment concedes this — such a list is itself an enumerable roster of the camps this developer
holds data from.

**What shipped instead is `camp-identity`, Rule 4 in `scanPrivacy`:** a *shape* rule over
`Camp <Name>`, `JCC <Name>`, `<X>JCC <Name>` and `JCC Camps at <Name>`, holding **no camp names at
all**, with a plaintext allowlist of the repo's own domain vocabulary and its verified-synthetic
fixture names. Same architecture as the existing home-path rule (shape-generic + placeholder
allowlist). Because it holds no names, it fires on the **first** commit citing a new camp. It runs
over file **paths** as well as contents — the earlier scrub's own miss was a camp name in a
filename. A new word after `Camp` surfaces as a finding for a human to classify, which is the
intended failure direction.

### Residual control, stated because a green reads as permission

Rule 4 does **not** cover, and no guard here can:

- an unstructured proper noun with no `Camp`/`JCC`/path/email shape around it — a camp referred to
  by a bare name, a director's name, a bunk name;
- the **contents** of binary or opaque files (`.xlsx`, `.docx`, `.pdf`, images) — only their paths
  are checked.

For those the only control is **human review**. The gate's pass line now says so on every green run,
because the green line is what gets quoted as clearance to publish.

### What this does to the rewrite decision

It strengthens the 2026-09-25 recommendation and adds a fact the owner should weigh: the tip
re-accumulated real camp identity **nine days** after a sweep concluded it was clean, and did so
through ordinary ADR authorship rather than carelessness. A one-time history rewrite would not have
prevented any of it. The forward guard remains the valuable work; **the rewrite is still an open
owner decision** and the measured case against it is unchanged.

Ticket allocation note: the highest allocated ticket is **T282** (T279–T282 are held unpushed in the
`peaceful-keller-404ba9` worktree). Next free is T283 — deliberately unused, per the instruction to
fold this into T120 rather than open a competing ticket.

## Decision record: rewrite DECLINED (2026-10-08) — DRAFT for the board keeper to rule

> **Status of this section: DRAFT recommendation, not a ruling.** T120's `status` stays `open` until
> the board keeper rules. Evidence below is from Build Board item `i-ci-minutes-residual-cost`
> (verified 2026-09-25) plus a fresh re-verification of the current tip.

**Recommendation: decline the history rewrite; keep the forward-looking guard (T263, shipped).**

**Owner statement on record:** "this is an open source repo. i will never sell it. i will never
patent it."

### Evidence (measured)

- `main` swept at `e88be5c6`: 1,905 tracked files, paths and raw bytes, **0 hits** for camp name or
  developer username.
- 6 history blobs of 2 MB or more: clean.
- Full history: 9,101 text blobs / 257 MB, **no PII and no live secrets** (the 3 secret-shaped hits
  are fixtures in `scripts/security-gate.test.js`).
- GitHub text surfaces: 4 hits, redacted and re-verified to 0.
- T263 privacy guard (#546) in `scripts/security-gate.js` fires on 5 planted classes.

### Current-tip re-verification (2026-10-08, base `b489ab9a`)

- `git grep -I -c -i` for the developer username: **0** matching files.
- `scanPrivacy` from `scripts/security-gate.js` (hashed identity tokens, camp-identity shape rule,
  home path, email, phone; paths and contents) run over all **2,526** tracked files: **0 findings**.
  The camp name is held only as a SHA-256 digest in that file, so it is covered by this scan rather
  than grepped in plaintext here.

### Cost of rewriting

1,466 commits rewritten; 32 orphaned worktrees; 42 force-pushed branches; 542 broken PRs; 0 forks
exist to protect.

### Residual gaps (stated, not hidden)

- Binary file contents are unscanned by the guard (filenames only).
- Unstructured personal names (a bare name with no `Camp`/`JCC`/path/email shape) are unmatchable.
- Actions logs become public on the private-to-public flip until retention expiry.

For these the control is human review before the visibility flip.
