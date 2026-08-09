---
title: T76-status-drift-commit-gate
document_type: ticket
status: completed
created: 2026-08-09
governing_docs: [docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs:
  - docs/adr/2026-08-09-work-record-status-drift-prevention.md
archive_when: checkStatusDrift ships in check-governance.js, is wired into checkAll, and its tests pass
---

# T76 — Commit-message status-drift gate (`checkStatusDrift`)

**Status: done.** Implements parts 1+2 of
`docs/adr/2026-08-09-work-record-status-drift-prevention.md`.

## What

Extend `scripts/check-governance.js` with a new `checkStatusDrift` check, wired into `checkAll()`
and therefore into the existing blocking `npm run check:governance` / `npm run verify` gate. No new
npm script, no new CI job (ADR candidate #2 rejected).

It inspects commit subjects reachable from `HEAD` but not `origin/main`, parses the normative
completion-reference vocabulary (`closes T##` / `Merge S##`) defined in `WORK_RECORD_STANDARD.md`,
resolves each referenced ID to its work document, and fails the build when:

- a referenced ticket/ADR/spec exists but its frontmatter still reads as open/not-done
  (`status-drift`), or
- a referenced ID resolves to no document at all (`status-drift-unresolvable-reference`) —
  product-owner decision 2: hard-fail, same severity.

Runs only on commits ahead of `origin/main`; degrades to a finding-free no-op where there is no
`origin/main` to diff (fresh clone / CI without the base ref).

## Done when

- `checkStatusDrift` implemented and called from `checkAll()`.
- Test-first coverage in `scripts/check-governance.test.js`: both failure modes + the pass case,
  with injected `execFn` (git log) and injected doc set so tests never touch git or the filesystem.
- `npm run check:governance` passes on this branch (dogfooded).
