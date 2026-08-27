---
title: "Retire Sort Order as a director-facing input (derive it instead)"
document_type: plan
status: active
created: 2026-08-27
governing_docs: [docs/work/specs/2026-08-26-roots-subscreens-redundancy-program.md]
---

# Retire Sort Order as a director-facing input

Part of W2 field-retirement in the Roots redundancy spec. Owner-approved 2026-08-27 ("Option 1"). Removes the `sort_order` number box (input + column) from Age Divisions, Days, and Time Blocks — the director never sees or types it again — while **keeping the stored field** and **auto-deriving** its value from each row's natural key. `day_of_week` stays (it is the meaningful weekday choice, load-bearing for the engine's `prefer_before_day`, and already a friendly dropdown — not clutter).

## Why derive instead of delete

`sort_order` is read downstream and must stay populated and sensible:
- `src/engine/buildSchedule.js:91` sorts time blocks by `sort_order` for `span_blocks` consecutive logic.
- `src/utils/exportWorkbook.js:166` carries the persisted `sort_order` into the re-import baseline.
- Display sort on all three screens uses `sort_order` (with a natural-key secondary already).

So: no schema change, no migration, no engine change. The column stays; we stop collecting it in the UI and compute it at write time so it always reflects the intended order.

## Derivation rule (compute at create AND edit — whenever the row is written)

- **Days:** `sort_order = day_of_week` (0–6, Sun→Sat). Weekday already carries the order.
- **Time Blocks:** `sort_order = minutesFromMidnight(start_time)` (e.g. "09:00" → 540). A whole number ≥ 0 (satisfies the existing import validator), always chronological, so the engine's `sort_order` sort stays correct with **zero engine edit**, regardless of the order blocks are entered.
- **Age Divisions (Tiers):** `sort_order = (max existing sort_order) + 1` on create (append). No natural key; creation order. **Accepted tradeoff:** directors lose fine-grained manual re-ordering of divisions; drag-to-reorder is a possible future follow-up, explicitly out of scope here (avoids new DnD surface + its touch/testing burden).

Add a tiny shared helper `minutesFromMidnight(hhmm)` (guard null/malformed → 0) rather than inlining the parse.

## Tasks (test-first, one commit each)

### Task 1 — Days
- Remove the `sort_order` `<input>` from the add-row and the edit-row; remove the `Sort Order` table column (header + cell).
- On add and on edit-save, set `sort_order = Number(day_of_week)` (do not read a UI value).
- Display sort: order by `day_of_week` (it already is the secondary key; make it the effective order).
- Test: adding/editing a day writes `sort_order === day_of_week`; the list renders in weekday order; no Sort Order input/column in the DOM.

### Task 2 — Time Blocks
- Remove the `sort_order` input (add + edit) and the column.
- Add `minutesFromMidnight` helper; on add and edit-save set `sort_order = minutesFromMidnight(start_time)`.
- Display sort: keep `sort_order` primary (now chronological) — no change needed since derived value is chronological; the existing `start_time` secondary stays.
- **Engine untouched** — verify `buildSchedule` still sorts blocks correctly given derived `sort_order`; add/confirm an engine test that two blocks entered out of chronological order still schedule in start_time order.
- Test: adding "10:00" then "09:00" yields sort_order 600 then 540, list shows 09:00 first; no input/column in DOM.

### Task 3 — Age Divisions (Tiers)
- Remove the `sort_order` input (add + edit) and the column (including the `columns=[...]` entry at TiersScreen.jsx:464 and the render at :477).
- On add, set `sort_order = max(existing sort_order) + 1`; on edit-save, leave the existing `sort_order` unchanged (name-only edit).
- Display sort: keep `sort_order` primary + name secondary (unchanged).
- Test: adding tiers appends in order; no Sort Order input/column in DOM.

## Do NOT change

- The stored `sort_order` schema/column; the engine; `exportWorkbook`; the import parsers (they already default `sort_order` to an index when absent — leave that path).
- `day_of_week` — stays exactly as-is (the weekday dropdown is kept).
- Any other screen or field.

## Accepted tradeoff (Governor, 2026-08-27)

Existing camps could have hand-typed `sort_order` values (e.g. 1,2,3) while newly added/edited rows get derived values (day_of_week 0–6, minutes 540/600, or max+1). Until every row is re-saved, edited rows can interleave oddly with legacy ones. **Accepted as intentional** — Shoresh has no live users/camp data yet and the owner's standing preference is clean hard cutovers (`feedback_preproduction_bias_bold`). Deliberately **not** fixed by changing `buildPlan`/ingest: `sort_order` is index-derived there on purpose so it does not create false reconciliation diffs (`buildPlan.js:384`), so import-side derivation is a separate Red-Hat-gated change, not part of this ticket.

## Verification
Per-file focused tests, then full gate. Because a downstream (engine) reads `time_blocks.sort_order`, Task 2 gets a code-review + an engine sanity test specifically. Machine under load: background long runs with real exit-code capture.
