---
title: T71-dev-shape-assertion-at-engine-id-list-inputs
document_type: ticket
status: open
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T69-engine-still-tolerates-json-stringified-id-lists.md, docs/work/tickets/T63-anchor-group-ids-parsing-belongs-at-the-boundary.md]
archive_when: a string-shaped id-list reaching the engine surfaces as a loud DEV-only error rather than a silent spinner, and the assertion is stripped from production builds
---

# T71 — Add DEV-only shape assertion at engine id-list inputs

**Raised:** 2026-08-08, deferred from T69 commit (`ab919e7`). T69 deleted the JSON-string
tolerance from `buildSchedule.js` and `weekCatalog.js`; the commit records explicitly that
the DEV assertion is a decision, not a substitute for the deletion.

## The problem

T69 removed the engine's tolerance for JSON-stringified id-lists (`eligible_group_ids`,
anchor `group_ids`). The normalizer at `useScheduleData.js:117–122` guarantees arrays at
the boundary today. But if that guarantee ever breaks — a new caller, a refactor that
skips normalization, a future IPC path — a string reaching `weekCatalog.js` throws on
`.every()` from a floating promise outside any `try` at `useGeneration.js:66`. The failure
surfaces as a spinner that never resolves: silent in production, invisible in development.

The deletion is not free, and the residual is that the failure mode is now harder to
diagnose. A DEV-only shape assertion at the engine inputs would make it loud immediately
rather than forcing someone to trace a hung spinner back to a type contract violation.

## What to build

1. **Assert array shape at the two engine entry points** where id-lists are consumed:
   - `buildSchedule.js` — `eligible_group_ids` on each activity, `group_ids` on each anchor
   - `weekCatalog.js` — `group_ids` on each anchor
   Assertion: `Array.isArray(value)`, throwing with a clear message naming the field,
   the caller, and the fix ("normalize at the IPC read boundary via
   `normalizeActivityEligibility` / `parseIdList`").

2. **DEV-only.** Strip the assertion from production builds. The standard pattern in this
   codebase is `if (import.meta.env.DEV)` — Vite tree-shakes it in production. Verify the
   assertion is absent in `npm run build` output.

3. **No test for the assertion itself** — it is a developer-experience aid, not a correctness
   guarantee. The correctness guarantee is the normalizer coverage added in T69. Do not add
   a test that imports the engine with a string and asserts it throws; that would pin
   DEV-only behaviour and break in production builds.

## Definition of done

- A string-shaped `eligible_group_ids` or anchor `group_ids` reaching the engine in DEV
  throws immediately with a message naming the field and the fix.
- The assertion is absent from the production build (`npm run build` output contains no
  reference to the assertion message string).
- `npm run test`, `npm run lint`, and `npm run build` all pass.

## Notes

- Logic-only. No Designer, no Architect (no schema or contract change — the array-only
  contract already exists; this just makes violations visible).
- The assertion must not change engine behaviour in production. If in doubt, wrap in
  `if (import.meta.env.DEV)` and verify with `npm run build`.
- Do not restore JSON-string tolerance as a fallback. T69 deleted it deliberately.
