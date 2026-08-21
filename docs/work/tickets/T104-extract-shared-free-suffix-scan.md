---
title: T104-extract-shared-free-suffix-scan
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: duplicateWeek.js and locationId.js share one free-suffix-scan helper, or a decision records why they stay separate
---

# T104 — Extract a shared free-suffix-scan helper (reuse review, T101)

**Surfaced by the reuse review during T101 (2026-08-20). Maintainability, non-blocking.**

`electron/ops/locationId.js`'s `${base}:${n}` free-suffix scan (T101) and `electron/ops/duplicateWeek.js:43-52`'s
`"X copy (n)"` free-suffix scan are the same pattern — "find the smallest free disambiguating suffix
given a camp-scoped name/id collision" — independently reinvented. Extract a shared
`findFreeSuffixedId(existing, base, formatCandidate)` both call, so the algorithm lives once.

## Definition of done
- One shared free-suffix helper used by both `duplicateWeek.js` and `locationId.js`, behavior-preserving,
  with the existing tests of both still green.

## Related
- T101 (introduced the location suffix scan).
