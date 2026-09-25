---
title: "Privacy guard: fail the gate on home paths, camp identity and PII entering tracked files"
document_type: ticket
status: open
created: 2026-09-25
task_class: security-auth
archive_when: "scanPrivacy ships as a fourth check in scripts/security-gate.js covering file CONTENTS and PATHS, the 11 files currently carrying the developer home path at HEAD are clean, and a non-vacuity test proves each pattern class goes red when planted — including one planted in a filename rather than in content"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
---

# T263 — Privacy guard: stop sensitive material entering tracked files

## Why

This is the piece of [T120](T120-history-rewrite-privacy-scrub.md) actually worth building, and it
is a **precondition for making the repository public** (which would make CI minutes free — see
[T261](T261-ci-minutes-duplicate-main-runs.md)).

The evidence is in T120's 2026-09-25 re-scope. In short: a full sweep of all 9,101 text blobs in
history found **no PII and no live secrets** — the only residual material is a camp name, some
cohort labels, and the developer's macOS username. So the history is not the problem.

**The problem is that the tip re-accumulates it, silently.** PR #248 scrubbed the developer's `~` home directory path
and recorded "verified 0 occurrences remain in the tree." It is back in **11 tracked files at
`HEAD`**: `scripts/gateLock.test.js`, `scripts/observeRun.js`, `scripts/memoryProject.{js,sh}`,
`scripts/consolidation/{gather,run}.sh`, `docs/adr/2026-09-15-opinion-report-dispatch-provenance.md`,
`docs/work/tickets/T171-*.md`, `T191-*.md`, `T216-*.md`, and a gate report. Nothing enforces the
scrub, so it regressed within weeks and nobody noticed.

A history rewrite cleans the past and does nothing about this. Once the repository is public, **every
future commit publishes live**, and agent sessions write local paths, sample data and ingest evidence
into `docs/` continuously. The forward risk is strictly larger than the historical one and it is the
only part no rewrite addresses.

## What to build

A fourth check in `scripts/security-gate.js`, alongside the existing three. It already has exactly
the right shape: pure functions (`auditFindings` / `scanSecrets` / `scanDangerous`) that take data
and return findings, a `trackedTextFiles()` helper, and a `security-gate:allow` marker. Add
`scanPrivacy(files)` in the same form.

It runs inside the existing `security` gate step (~1.4s), so **it costs no additional CI minutes** —
which matters, because T261 exists to reduce them.

### Pattern classes

1. **Absolute home paths** — `/Users/<name>` and `/home/<name>`. Generic by shape, not a denylist of
   one username, so it also catches a different machine's path.
2. **Real camp identity** — see the design constraint below.
3. **PII shapes** — email addresses and phone numbers in tracked text.

### The design constraint that is easy to get wrong

**The guard must not contain the camp name in plaintext.** A denylist with the name written in it
makes the guard file itself the leak — and it would be committed, gated, and public. Store a
**SHA-256 of the lowercased name** and hash candidate word tokens from each file to compare. That
detects a distinctive proper noun without the repository ever holding it again.

This is worth stating because the obvious implementation is a regex literal, and it would quietly
defeat the entire purpose of the ticket.

### It must scan PATHS, not only contents

This is how the material leaked the first time: `docs/work/specs/samples/campB-<camp-name>-by-day.txt`
carried the camp name **in the filename**. A guard that reads file contents and never looks at the
paths it was handed would have passed that file cleanly. Scan both.

## Exemptions, and being honest about them

These legitimately contain the patterns and must be exempt, or the guard is unusable:

- `package-lock.json` — carries npm package authors' email addresses. All 17 email-shaped strings in
  this repo's entire history come from here and similar metadata.
- `scripts/security-gate.test.js` and this check's own test — they contain the patterns as fixtures.
- `test/fuzz/**` — generates email-shaped strings.

Extend the existing `security-gate:allow` marker to this check and **say so in the comment at
`scripts/security-gate.js:15`**, which currently states the marker is honoured by checks 2 and 3
only. That comment exists because omitting the scope actively misled someone on 2026-09-17; leaving
it stale would repeat exactly that.

## A live demonstration, for free

While writing T120's evidence table, this ticket's author pasted the AWS documentation example key
into the ticket as a *description of a finding*. `npm run security` failed the gate on it
(`docs/work/tickets/T120-…:109 — possible aws-access-key-id`, CI run 36140342005). The existing
secret check works, and it caught sensitive-shaped material entering a **documentation** file, which
is precisely the surface this ticket is about.

Two things follow. The mechanism being extended is known-good rather than hypothetical. And the
failure mode is real: material arrives in `docs/` while someone is busy writing *about* privacy.

## Test-first, and non-vacuity

Per `TESTING_STANDARD.md` and the standing rule that a guard's *description* is part of the guard:
plant each pattern class and prove the gate goes red. Include, specifically:

- A home path planted in a **doc**, and one in a **code file**.
- The camp name planted in **file contents**, and — separately — in a **filename**. The filename case
  is the one that actually happened and the one a contents-only implementation silently misses.
- An email and a phone number in a tracked file.
- A **negative** case: `package-lock.json` still passes, so the exemption works and the guard is not
  green merely because it never runs.

## Done when

- `scanPrivacy` ships in `scripts/security-gate.js`, wired into the gate's `security` step.
- The **11 files** currently carrying the home path at `HEAD` are clean, so the guard passes on a
  green tree rather than being landed disabled.
- Non-vacuity tests above all pass, including the filename case and the exemption negative.
- `scripts/security-gate.js:15`'s marker-scope comment names this check.

## Out of scope

- **The history rewrite.** Owner decision, recorded in T120, and the evidence there argues against it.
- **Making the repository public.** Separate owner decision. This ticket makes it *safe*; it does not
  perform it.
- **The three GitHub PR bodies** that mention the camp name or home path (PR #285 twice, PR #248
  once — both are the scrub PRs describing the removal). PR bodies are editable in place and are
  not a code change; recorded in T120 for the owner rather than done here.
