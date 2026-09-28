---
title: "Machine-checkable doc-fact freshness gate in check:governance"
document_type: ticket
status: completed
task_class: documentation-governance
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T294-documentation-staleness-audit-and-refresh.md]
program: documentation-governance
archive_when: "A `checkDocFacts` gate ships in scripts/check-governance.js (BLOCKING), driven by a scripts/doc-facts.js registry that derives each canonical value deterministically from source (no DB, no Electron — runs in CI); at least the schema-version and VERIFY_STEPS-count facts are wired to their docs with `<!-- doc-fact:NAME -->` markers; a stale marker fails `npm run verify`; unit tests cover match / stale / unknown-fact / missing-value; merged on green"
---

# T295 — Machine-checkable doc-fact freshness gate

## Why (motivating evidence)

T294 refreshed the whole doc corpus, but nothing prevents re-drift. Proof it is not hypothetical:
between the T294 sweep and the same day, a concurrent session bumped
`CURRENT_SCHEMA_VERSION` in `electron/db/localDb.js` from 78 to **79** — so the just-refreshed
`docs/current/PLATFORM_STATE.md` schema-version claim was stale again within hours. The existing
`checkPlatformStateFreshness` (advisory, commit-date-based) can only say "possibly behind"; it
cannot say "this doc states 78 and the code says 79."

## Success predicate (observable)

1. `scripts/doc-facts.js` exports a `DOC_FACTS` registry. Each entry has a `derive(root)` that
   returns the canonical value **deterministically from source only** — regex/parse of committed
   files, **no SQLite build, no Electron, no DB** — so it runs on the portable CI runner.
2. `check-governance.js` gains `checkDocFacts(root)`: for every doc line carrying a
   `<!-- doc-fact:NAME -->` marker, it extracts the value asserted on that line, derives the
   canonical value for `NAME`, and emits a **BLOCKING** `doc-fact-stale` finding on mismatch
   (naming doc:line, asserted vs actual). An unknown `NAME`, or a marker with no extractable
   value, is also a finding — misuse must not pass silently.
3. At least two facts are wired end-to-end to real docs:
   - `schema_version` ← `CURRENT_SCHEMA_VERSION` in `electron/db/localDb.js` → the schema-version
     claim in `docs/current/PLATFORM_STATE.md`.
   - `verify_step_count` ← length of `VERIFY_STEPS` in `scripts/verify.js` → the gate-count claim
     in `docs/governance/standards/TESTING_STANDARD.md`.
4. Test-first: `scripts/check-governance.test.js` (or a sibling) covers match, stale, unknown-fact,
   and missing-value, with fixtures — a planted stale marker must fail, a matching one must pass.
5. `npm run verify` green on a portable runner; PR merged on green.

## Design (settled)

- **Explicit anchored markers, not prose-grepping.** A checkable claim is annotated inline:
  `... schema version 79 <!-- doc-fact:schema_version -->`. The gate reads the marker, not fragile
  free text, so an incidental "79" elsewhere in the doc is never matched and the editor sees the
  contract. Value extraction: the marker asserts the last number (or explicitly delimited token) on
  its own line.
- **Blocking, unlike `platform-state-stale`.** A marked fact is an exact claim; a mismatch is a
  definite factual error, not a maybe. It does not join `ADVISORY_CODES`. (The owner ruling "a stale
  doc cannot block" applied to the *heuristic* commit-date check, which can red a session for drift
  it did not cause; a doc-fact marker is a claim the doc's own author placed and must keep true.)
- **Derivation is source-only and cheap.** `schema_version`: `/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/`.
  `verify_step_count`: parse the `VERIFY_STEPS` array length from `scripts/verify.js`. Both read
  committed files with `fs`, nothing else.

## Non-goals

- Table counts (63/36/26) and anything needing a built DB — deferred; the registry is the extension
  point, but a CI-portable derivation for those is out of scope here.
- Auto-fixing docs. The gate reports; a human (or `/update-state`) fixes.
- Replacing `checkPlatformStateFreshness`; the two coexist (heuristic advisory + exact blocking).

## Gates

`npm run index:work` · `npm run check:governance` · `npm run test` (new unit tests) · PR + merge on
green (CI is the gate of record).

## Outcome (2026-09-28)

Success predicate discharged:
- `scripts/doc-facts.js` ships `DOC_FACTS` (`schema_version`, `verify_step_count`), a pure
  `scanDocFactsInText`, and `checkDocFacts(root)` — all derivation source-only (regex over
  `electron/db/localDb.js` and `scripts/verify.js`), no DB, no Electron.
- `checkDocFacts` is wired into `checkAll` in `scripts/check-governance.js` as a **blocking**
  finding (`doc-fact-stale`), not advisory.
- Two facts wired end-to-end with `<!-- doc-fact:NAME value=N -->` markers:
  `docs/current/PLATFORM_STATE.md:689` (schema version — this also FIXED a live `v78`→`v79` stale
  claim) and `docs/governance/standards/TESTING_STANDARD.md` (gate-step count), with the marker
  convention documented in that standard.
- `scripts/doc-facts.test.js`: 11 tests — match, stale, unknown-fact, missing-value, incidental
  number, multi-marker, comment-apostrophe counting, live-repo integration.
- Negative control verified by hand: planting `value=77` produced a blocking finding citing
  `PLATFORM_STATE.md:689`, asserted vs actual; restored.

## Remaining

Closed. Extension point (`DOC_FACTS` registry) left for future facts; table counts needing a built
DB remain a documented non-goal.
