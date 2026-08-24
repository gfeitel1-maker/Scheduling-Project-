---
document_type: spec
status: approved
authority: informative
date: 2026-08-23
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adr: docs/adr/2026-08-23-two-rows-multipattern-split.md
---

# Two-rows Slice 2 — split-suggestion affordance (Designer spec)

Slice 2 of the two-rows split (owner priority #5). Wires the merged Slice 1 pure
function `emitTwoRowSplit()` (`src/ingest/twoRowSplit.js`) into a director-facing
suggestion in the ImportScreen review flow. Off-by-default, calm, easily ignored.
Scoped entirely to `src/screens/ImportScreen.jsx` — no new screen.

## Placement
Attach the suggestion **inline to the existing Recurring Events chip**
(ImportScreen.jsx ~884-909), rendered only for names in `dualUseNames` AND in the
`fixedEvents.map(...)` loop. Do NOT build a second independent list or a new
titled section. The dual-use signal is a property of that specific fixed-event
chip.

## State to add
- Lift `dualUseNames` out of the throwaway local destructure at ImportScreen.jsx:271
  into component state (`setDualUseNames(dualUseNames)` alongside the existing
  `setPinOnlyActivityNames(pinOnlySet)` at ~line 285 — same data, no longer discarded).
- `splitDecisions` map: `{ [name]: { expanded, accepted, suffix, outcome:
  'idle'|'degenerate'|'collision', collisionChoice } }`.

## Collapsed (default) — a quiet disclosure link, NOT a checkbox/toggle
Under the chip, same left edge, no card/border. Reuse the `adjustButton` idiom
(no border/bg, cursor pointer, 2px 6px, radius 4, hover color-mix 5%). Chevron =
the `ActivityRuleRow` chevron SVG, rotates 180° on expand.
Copy: **"Also a flexible activity — split into two?"**

## Expanded — reuse ActivityRuleRow's reveal/container idiom (own keyframe name `importSplitReveal`)
- Header: **"'{name}' also appears on its own, outside the fixed time — split it into two activities?"**
- Pinned row label: **"{name}"** (unchanged).
- Editable suffix input (reuse ActivityRuleRow number-input styling, width ~90px),
  prefilled with `DEFAULT_SPLIT_SUFFIX` (`' (rec)'`) from twoRowSplit.js, selected/editable.
- Live preview, recomputed every keystroke: **"→ \"{name}{suffix}\" (flexible)"**.
- Buttons: **"Split"** (`S.btnPrimary`, sized down) / **"Not now"** (`S.btnSecondary`,
  NOT destructive/red — declining is a normal path).

## Outcome handling (source of truth = emitTwoRowSplit's return, called ONCE on confirm)
Client-side PRE-checks are advisory (pure string checks against
`proposal.entities.activities` + `existingRecordsAll.activities`, using the SAME
`normalizeName` from `../ingest/preview.js` that emitTwoRowSplit uses — do not
write a second normalizer). Do NOT call emitTwoRowSplit speculatively per keystroke.
- **degenerate** (suffix trims to empty/whitespace → normalizes to the original
  name): disable `Split`; inline msg replacing the preview: **"Add a suffix so the
  two activities have different names."** (`var(--danger)`, 11px, no icon).
- **collision** (a row already normalizes to the new name): swap card to a
  three-way micro-decision reusing the Keep-vs-Replace radio-card idiom
  (ImportScreen.jsx ~934-950):
  - **"Reuse it"** / "Attach the flexible pattern to the existing '{newName}' activity."
  - **"Pick a different name"** / "Choose another suffix." (reopens suffix input focused)
  - **"Cancel"** / "Leave '{name}' as one activity." (= decline)
- **split** (clean): collapse to a quiet confirmation line **"Split into {name} +
  {name}{suffix}."** (`var(--text-secondary)`, no chevron). Calm, not celebratory.

## Cross-device rejection (depends on the sync-prereq PR)
`Split`/`Confirm` calls emitTwoRowSplit → writes. The local check may pass while a
concurrent device already created the same name; once `activities` is registered
in UNIQUE_FIELD_ENTITIES (sync-prereq PR), that write returns an op-rejection
rather than throwing. The confirm handler MUST surface that gracefully (treat it
like the 'collision' outcome — offer reuse/rename — rather than a hard error).

## Decline-memory — a small local-only, unsynced table (mirrors the S1b aliases precedent)
Recommend `declined_two_row_splits (camp_id, activity_name_normalized, declined_at)`,
HOST-LOCAL, never replicated, single-writer. On `Not now` / collision-Cancel, write
one row keyed by `normalizeName(name)`. On the next `readFiles()` pass, after
computing `dualUseNames`, filter out declined names BEFORE rendering (never call
emitTwoRowSplit, never show the link). React state alone is lost on unmount → would
nag on the next re-import (the exact failure the ADR forbids). A dedicated tiny
local table has no sync/conflict surface (matches aliases reasoning). Sequence its
migration as its own small step before the UI lands (test-first at the seam).
Accepted tradeoff: two directors on two devices each get the suggestion once
(decline isn't shared) — mirrors the aliases precedent's accepted scope; revisit
only if real usage shows it's annoying.

## Motion
All reuse existing tokens; `prefers-reduced-motion` → instant. Card expand =
`importSplitReveal` (max-height+opacity, --motion-base/--ease-standard); chevron
rotate; collapse-to-confirmed = crossfade (--motion-fast), no slide. No
bounce/spring anywhere — this is a form micro-interaction ("explains, never
entertains").

## Copy discipline
NEVER surface "occurrence-pattern", "truth-status", "asserted", "obligation", or
"permission" in the UI. Plain scheduling language only, consistent with
ActivityRuleRow and the Keep-vs-Replace block.

## Biggest UX risk
Suggestion noise from `dualUseNames` false positives. Mitigation is placement (a
quiet, collapsed, ignorable link on a chip the director already sees) + decline-
memory, NOT validation. If Slice 3 instrumentation shows reflexive declines, the
fix is tightening `dualUseNames` precision in `fixedEvents.js`, not this UI.
