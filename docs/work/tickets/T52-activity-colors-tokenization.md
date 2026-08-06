---
title: T52-activity-colors-tokenization
document_type: ticket
status: open
created: 2026-08-06
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: ACTIVITY_COLORS reads from tokens and DESIGN_STANDARD's stale note is corrected
---

# T52 — `ACTIVITY_COLORS` is the last hardcoded colour in the schedule components

**Status: open.** Split out of T50 (schedule canvas rebuild) by product owner decision,
2026-08-06, to keep the canvas rebuild a rendering-only change.

---

## Problem

`src/components/schedule/slotCellConstants.js:24` holds the activity identity palette as six
literal hex values:

```js
export const ACTIVITY_COLORS = ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
```

`DESIGN_STANDARD.md` §3 defines the canonical muted activity palette. These six values are not it,
and nothing enforces the relationship — a retheme of the standard would not reach them.

## Scope correction — the surface is smaller than the docs claim

Verified against the code 2026-08-06:

| Constant | Actual state |
|---|---|
| `ANCHOR_COLOR` | ✅ already `'var(--anchor)'` |
| `FLAG_COLORS` | ✅ already `{ UNFILLABLE: 'var(--danger)', OVERLAP: 'var(--accent)' }` |
| `ACTIVITY_COLORS` | ❌ six hardcoded hexes — **the only remaining item** |

**`DESIGN_STANDARD.md:60` is stale.** Its note says `--purple` must stay defined "until the
retheme migrates callers (`SlotCell.ANCHOR_COLOR`)". That migration already happened.
Two other memory/doc surfaces repeat the same stale claim. Correcting the note is in scope here —
an agent reading the standard rather than the code will otherwise keep re-reporting work that is
already done. (This ticket exists partly *because* a Designer agent did exactly that.)

## Why it is not part of T50

T50 is a rendering-primitive change: HTML table + `rowSpan` → CSS Grid. It edits these files but
does not change what any colour means. Bundling a palette migration would make T50's visual-parity
acceptance predicate untestable — you could not tell a layout regression from an intended colour
change.

## Not yet decided

- Whether the six values become CSS custom properties (`--activity-1` … `--activity-n`) or stay a
  JS array sourced from tokens. The activity palette is indexed by a hash of activity id
  (`activityColor(colorIdx)` in the same file), so the lookup shape matters.
- Whether the palette size stays at six. `setActivityPalette()` resolves the whole activity set at
  once specifically because a bare hash collided badly on real camp data — three of one camp's
  four activities shared an entry. Changing the count interacts with that.

## Acceptance

- [ ] `ACTIVITY_COLORS` derives from `DESIGN_STANDARD` §3 values, not literals
- [ ] `activityColor()` / `setActivityPalette()` collision behaviour unchanged — existing tests green
- [ ] `DESIGN_STANDARD.md:60`'s `SlotCell.ANCHOR_COLOR` note corrected to reflect that the
      migration is complete
- [ ] No visual change to anchors or flags (they are already tokenized — regression check only)
