---
title: "Ingestion Reconciliation — one-screen design spec"
document_type: spec
status: draft
created: 2026-08-17
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_runs: [docs/work/runs/2026-08-17-reconciliation-r0-audit.md, docs/work/runs/2026-08-17-reconciliation-r1-design-divergence.md]
prototype: docs/work/specs/2026-08-17-reconciliation-onescreen-mockup.html
archive_when: superseded by the R2′ implementation run records, or the design is rejected
---

# Ingestion Reconciliation — One-Screen Design Spec

This spec is a hard constraint on Maker. It resolves every aesthetic decision for the R2′ rebuild
of `ImportScreen.jsx` under the LOCKED owner decisions in
[R1′](../runs/2026-08-17-reconciliation-r1-design-divergence.md). It answers to
[`DESIGN_STANDARD.md`](../../governance/standards/DESIGN_STANDARD.md). Visual reference:
[`2026-08-17-reconciliation-onescreen-mockup.html`](2026-08-17-reconciliation-onescreen-mockup.html) —
real tokens, real fonts, realistic camp data (a mid-size overnight camp mid-onboarding, not a toy
fixture).

**Personality anchor:** Professional. Grounded. Warm. Quiet. Precise. Never playful. Colour means
something. **Acceptance test that governs every visual decision below:** with the roots spine
kill-switched and rendered in greyscale, this screen must read as a plain sorted checklist. If a
decision cannot survive that test, it does not ship.

**Ground truth this design renders (do not re-derive):** `buildReconciliationReport(input)` →
`{ buckets: {understood, needsAttention, changed, notInSource}, decisions, meta }`
(`src/ingest/reconciliationReport.js:304`). Vocabulary in code is `CONFIDENCE.HIGH/MEDIUM/LOW` +
identity tiers + `human`/`import` provenance — **not** OBSERVED/INFERRED/CONFIRMED/UNKNOWN. This
design translates at the presentation layer only; it does not rename anything in the data model.

---

## 0. Information architecture — what replaces the six gated views

One continuous scroll, one `<ReconciliationScreen>`. No sequential gates, no takeover modals except
where DESIGN_STANDARD already sanctions a modal (a destructive confirm). Deleted from the current IA:
`ReconciliationQueue.jsx`, the held-conflict takeover banner, the post-commit banner-as-separate-view.
Folded into one lane: per-entity ticking, held resolution, the ledger, and commit.

Vertical order, top to bottom, always all present (empty states collapse their own section, they
never disappear the section header):

1. **Header strip** — source name, row count, "N of Y done" spine (see §3).
2. **Understood receipt** — one line, collapsed by default (§2).
3. **Domain filter chips** — Structure / Scheduling / Time / Facility, over the same lane (§6).
4. **Triage lane** — the cards, ordered by readiness-demand (§3, §4, §5).
5. **Not-in-source gap** — honestly-empty, low in the page, never counted as hot (§7).
6. **Staged tray + final actions** — sticky footer (§8).
7. **Receipt + undo** — replaces the tray after apply (§9).

---

## Layout

`src/screens/ReconciliationScreen.jsx` (replaces `ImportScreen.jsx`'s reconciliation-facing half;
the file upload / parse-trigger step stays a short antechamber, out of scope here — this spec starts
at "a report exists").

```
<div style={S.pageShell}>                          // max-width 920px, centered, matches Locations/Days
  <ScreenIntro screen="reconciliation" />           // existing pattern
  <HeaderStrip />                                    // §1
  <UnderstoodReceipt />                               // §2, collapsed <details>-style row
  <FilterChipRow />                                   // §6
  <TriageLane>                                        // §3-5
    {decisions.map(d => <DecisionCard decision={d} />)}
  </TriageLane>
  <NotInSourceGap />                                  // §7
  <StagedTrayFooter />                                // §8, position: sticky, bottom: 0
</div>
```

No new top-level React state machine. `route`/`screen` props are unchanged. Internal state:
`activeFilters: Set<domain>`, `expandedCardIds: Set<id>`, `resolutions: Map<decisionId, resolution>`
(mirrors the existing dry-run resolution shape already used by `commitInputsWithResolutions`).

---

## 1. Header strip

Plain row, no card: `padding: '16px 0 12px'`, `borderBottom: '1px solid var(--border)'`.

- Left: `IBM Plex Sans 600, 16px` — `"Reconciling {sourceFileName}"`.
- Right: the **spine** — `"{doneCount} of {totalCount} done"`, `13px`, `var(--text-secondary)`,
  tabular-nums. A thin progress rule beneath it: `height: 3px`, track `var(--border)`, fill
  `var(--secondary)` (forest — this is progress, not alarm), `width: {pct}%`,
  `transition: width var(--motion-base) var(--ease-out)`.
- The spine persists on scroll (`position: sticky, top: 0, background: var(--bg), zIndex: 5`) so
  resume-after-interruption always shows "how much is left" without scrolling up. This is the literal
  mechanism for "supports resume-after-interruption" — no separate resume UI, no localStorage banner.

`totalCount` = count of `needsAttention` + `changed` decisions (the things that require a human
choice). `doneCount` = those with a `resolutions` entry. Express/understood items are never in the
denominator — the spine must never read e.g. "480 of 486," which would defeat the compression goal.

---

## 2. Understood receipt (express speed — never shown as work)

One row, not a card: no border, no shadow, `padding: '10px 4px'`, `color: var(--text-secondary)`,
`13px`. Icon: outline check-circle, 14px, `var(--success)`.

Copy pattern: `"{count} rows read cleanly — nothing needed from you."` e.g.
`"482 rows read cleanly — nothing needed from you."`

Collapsed by default; a plain-text disclosure toggle (`"Show details"`, `var(--primary)` link-button,
no icon change) expands a static list of the understood field-changes in a muted `12px` monospace-free
list, `max-height` reveal (`--motion-base`, per §8 motion tokens — expand/collapse animates
`max-height`). This is the ONE place raw volume is allowed to surface, and only on demand.

**This is where the express speed lives entirely.** It never appears as a card in the triage lane —
that is the mechanism that keeps "6 things to look at" true even when 480 rows were read.

---

## 3. Triage lane — readiness-demand order and the 2-3 rank salience system

### Ordering
Cards sort by a single deterministic `salienceOf(decision)` (Architect owns the exact function; this
spec fixes its *output contract* and *visual encoding*, not its inputs). Contract:

```
salienceOf(decision) -> 'hold' | 'standard'   // rank, not a continuous score
```

Two ranks in the lane itself (a third, lower rank — "express" — never enters the lane; see §2). This
directly satisfies the LOCKED "2-3 DISCRETE ranks" decision: express (invisible) / standard (one-tap)
/ hold (real decision).

- **`hold`** — genuine `CONFLICT` or `UNKNOWN` per R0 Q10's independent counters; also anything
  `isProtected` (human-edited field the import wants to touch). Sorted first.
  - **Architect dependency:** the report needs to expose a blast-radius-shaped signal per decision
    (how many downstream slots/activities this touches) if "readiness-demand order" is to mean more
    than confidence tier alone. Flagging this explicitly — see §11.
- **`standard`** — one-tap confirms: high-confidence `changed` or `needsAttention` items where the
  proposed value is unambiguous. Sorted after all `hold` cards.

Within a rank: stable sort by entity type grouping (so "3 activity name changes" cluster), then by
the order the report emits them (no re-sort on every render — avoid layout jitter as cards resolve).

### Visual encoding of the two ranks — grayscale-recoverable

| Rank | Spacing | Accent | Card scale | Order |
|---|---|---|---|---|
| `hold` | `margin-bottom: 12px` (more air) | `4px` left border-bar, `var(--accent)` (bronze — caution, per §4 semantic role table) | `padding: 16px`, title `14px/600` | first |
| `standard` | `margin-bottom: 6px` (tighter) | `4px` left border-bar, `var(--border)` (neutral, same hairline gray as everything else) | `padding: 12px`, title `13px/500` | after all `hold` |

That is the entire salience system: **spacing delta + one accent (bronze, hold-only) + 4px scale
delta on padding/title-weight + sort order.** No background tint, no glow, no badge color-coding
beyond the single bronze bar. In greyscale, `hold` cards are still taller, more padded, and heavier-
weight — order and scale alone recover the hierarchy. This is the literal mechanism that passes the
acceptance test.

**Do not** add a third visual weight for `standard` vs a hypothetical fourth state — the lane has
exactly two card treatments, matching the two in-lane ranks.

### Roots spine (optional, kill-switched)
A single 2px vertical rule, `color-mix(in srgb, var(--secondary) 14%, transparent)`, positioned
`left: -20px` relative to the lane container (in the gutter, never inside a card), running the full
height of the triage lane. On a `hold` card, the rule thickens locally to 3px and gains a small
root-node dot (4px circle, same tint) aligned to that card's vertical center — a "this is where a
root needs attention" cue, nothing botanical or illustrative. Governed by a single boolean render
flag (`showRootsSpine`, default **on**, persisted per-device in local UI prefs — not synced, not a
schema change). Toggling it off removes the gutter rule entirely; nothing else changes. This satisfies
"faint margin spine motif behind a kill-switch" literally — it lives outside the card grid, is a
single flat color at 14% mix, and never touches card content or salience encoding.

---

## 4. Decision card — the standard/hold shared shell

Base card: `background: var(--surface)`, `border: 1px solid var(--border)`, `borderRadius: 8`,
`borderLeft: 4px solid {rankAccent}` (see §3 table). No shadow (matches DESIGN_STANDARD §1 minimal-
shadow rule; a shadow here would compete with the modal-elevation convention).

### Anatomy (top to bottom inside the card)
1. **Question line** — `IBM Plex Sans 600` (14px hold / 13px standard), `var(--text)`. Always phrased
   as ONE meaningful question, not a field dump: `"Keep Group 3B's name as 'Chipmunks' or update to
   'Chipmunks (3B)' from the file?"` — never `"Conflict: name"`.
2. **Domain + entity meta row** — `12px`, `var(--text-secondary)`: entity type icon (outline, 14px) +
   entity name + domain tag (matches the filter-chip vocabulary, §6) so a card is legible even with
   filters cleared.
3. **Evidence — progressive disclosure, never a probability score.** Collapsed: a single muted line,
   `"From this file · was 'Chipmunks' last year"` (13px, `var(--text-secondary)`). A `"Why?"` text
   toggle (`var(--primary)`, no button chrome) expands a two-column comparison, `max-height` reveal:

   ```
   From this file                  |  Current Shoresh record
   "Chipmunks (3B)"                |  "Chipmunks"
   seen in row 14, Groups tab      |  set by hand 2026-06-02 (Dana)
   ```
   Human-readable sentences built from `import_evidence` + provenance timestamp/author, never a
   0.0–1.0 number, never the raw `CONFIDENCE.HIGH/MEDIUM/LOW` enum name printed verbatim (translate:
   HIGH → "clearly stated in the file", MEDIUM → "inferred from context", LOW → "a guess — worth a
   second look").
4. **Resolution controls** — see §5 (standard) / §5b (hold/CHANGED) — inline, no navigation away.

### States
- **Default** — as above.
- **Expanded evidence** — `max-height: 0 → auto` via measured height (standard React pattern, not CSS
  `auto` transition — measure with a ref, animate to `scrollHeight`), `--motion-base`, `--ease-out`.
- **Resolved (pending apply)** — card gets `opacity: 0.6`, resolution controls replaced by a single
  line: `"✓ Will set to 'Chipmunks (3B)'"` + an `Undo` text link. Card does NOT disappear from the
  lane (removing it would break "list empty AND readiness green" as the only completion signal, and
  would make the spine count feel like it's hiding things). It moves to the bottom of its rank group.
- **Hover/focus** — `border-color: color-mix(in srgb, var(--primary) 30%, var(--border))`, no
  background shift (quiet).

---

## 5. Resolution controls

### `standard`-rank cards (one-tap confirm)
Two buttons, inline, right-aligned under the question line:
- `S.btnPrimary`-style but compact (`padding: '5px 12px'`, `13px`) — `"Use this value"` (accepts the
  proposed value).
- `S.btnSecondary`-style compact — `"Keep current"`.
No third option; if a card needs a third option it is not `standard` rank by definition (misclassified
inputs are an Architect/`salienceOf` bug, not a UI concern).

### `hold`-rank CHANGED cards — explicit options, never Accept/Reject (§ LOCKED requirement)
Three explicit, named options as a vertical radio-card group (not a dropdown — the options must be
scannable, this is the moment that most needs comprehensibility):

```
○ Use the file's value — "Chipmunks (3B)"
   Overwrites what's in Shoresh now.
○ Keep the current value — "Chipmunks"
   Ignores this file's value going forward for this field.
○ Something else — type a value
   [ text input, appears inline when selected ]
```
Each option label is `13px/500`, the description `12px var(--text-secondary)`. Selecting a radio
immediately writes to the `resolutions` map (staged, not applied — see §8); no separate per-card
"confirm" button. This is what makes CHANGED provenance-legible: the copy names the two concrete
values instead of abstract verbs.

### `hold`-rank UNKNOWN/CONFLICT cards
Same three-option shape, but option 1 becomes `"Use the guessed value"` (only shown if a proposed
value exists) and there is no "current value" option if none exists yet — instead `"Leave unset for
now"`. Never fewer than two options; never silently pre-select one.

---

## 6. Domain filter chips

Row directly under the understood receipt, above the lane. `display: flex, gap: 8px`.

Chips: `Structure` · `Scheduling` · `Time` · `Facility`, plus an implicit `All` (default, no chip
rendered for it — chips are exclusion filters, not a tab bar with a home tab). Chip style:
`padding: '5px 12px'`, `border: 1px solid var(--border)`, `borderRadius: 999` (pill, matches existing
filter-chip convention elsewhere in the app), `13px`. Selected state: `background: var(--primary)`,
`color: #fff`, `border-color: var(--primary)` (same recipe as any other active-filter chip in this
codebase — do not invent a new selected-chip treatment).

Each chip carries a plain count badge: `"Structure (2)"` — count = hold+standard decisions in that
domain currently unresolved. Multi-select (toggle each independently); zero selected = show all. This
is a lens over the same `decisions` array — filtering never re-fetches, never changes `salienceOf`
ordering within the visible set, never creates a second data source (LOCKED: filter chips over the
same report, not a second inbox).

**Facility chip honesty:** if the source is a plain spreadsheet with no location columns at all, the
Facility chip still renders but with count `(0)` and, if clicked, shows the same empty-state pattern
as §7 (not a warning, not a red badge) — "Nothing needs a decision here." This is the mechanism for
"facility absence in a plain spreadsheet must not trigger warnings."

---

## 7. Not-in-source gap (honestly-empty, never a hot item)

Positioned low, after the triage lane, before the tray. Visually the LEAST salient thing on the
screen — this is deliberate and is itself part of the discrete-rank system (a de facto rank below
`standard`, rendered outside the lane entirely so it can never be mistaken for something requiring
action).

Style: no card, no border, `padding: '16px 4px'`, dashed 1px top rule
(`border-top: 1px dashed var(--border)`) as the section's only visual boundary. Icon: outline
dashed-circle or similar "gap" glyph, 16px, `var(--text-secondary)`. Copy:
`"{count} items not mentioned in this file — left as-is, not a problem."` followed by a collapsed
disclosure (`"Show them"`) revealing a plain muted list, same `max-height` pattern as §2.

**Never** use `var(--danger)` or `var(--accent)` here, never a numeric badge in a "hot" color, never
appears in the header spine's denominator. If `notInSource` is empty, the section renders nothing at
all (not even the header) — do not show "0 items not mentioned," that is noise.

**Data dependency flagged for Architect:** R0 stale-assumption #3 — `notInSource` today only covers
`readiness.state === 'optional'`. This design's copy assumes that's the correct/complete set for v1;
if the design review wants broader coverage, that's a logic-layer change, not a visual one.

---

## 8. Staged tray + final actions (sticky footer)

`position: sticky, bottom: 0`, full width of `pageShell`, `background: var(--surface-elevated)`
(white — reads as lifted above the paper page, matches modal-elevation convention),
`border-top: 1px solid var(--border)`, `padding: '14px 20px'`, `box-shadow: 0 -2px 12px
color-mix(in srgb, var(--text) 6%, transparent)` (the one place a shadow is warranted — DESIGN_STANDARD
explicitly allows minimal shadow to separate a lifted surface from the page behind it).

Layout: left = staged summary line, right = two buttons.

- **Left:** `"{confirmedCount} decisions staged"` (13px, `var(--text-secondary)`), or if zero:
  `"Resolve at least one item, or apply what's understood as-is."` The tray IS the dry-run per the
  binding invariant — no separate "preview" step; the numbers shown are always the true dry-run
  output, not a client-side guess.
- **Right, two buttons, both truthful, neither says "commit":**
  - `S.btnSecondary` — **"Apply confirmed changes and keep the rest for review"** — enabled once
    `confirmedCount > 0`; commits only resolved decisions (`commitInputsWithResolutions` with a
    partial resolution set), leaves unresolved `hold`/`standard` cards in the lane for a later visit.
  - `S.btnPrimary` — **"Use this setup"** — enabled once every `hold` card is resolved (standard cards
    may default to "use proposed value" if left untouched — Architect should confirm this default is
    safe per R0 Q9/Q10 semantics, flagged in §11). Runs full commit.

Disabled-button copy (tooltip on hover, `title` attr, not a modal): `"Resolve the {n} items marked for
your attention first."` — plain language, no jargon.

Motion: the tray itself does not animate on scroll (it's sticky, not entering). Its **content**
(staged count, button enabled state) crossfades on change: `opacity` only, `--motion-fast` (140ms) —
this is a frequent micro-update and must not distract.

---

## 9. Receipt + grace-window undo

> **v1 SCOPE NOTE (Governor, 2026-08-17):** the grace-window UNDO affordance is DEFERRED to its
> own later slice — Red Hat found three HIGH structural gaps in the undo mechanism (see the ADR's
> gate-outcome banner). For R2′, ship the **receipt panel** (the "Applied. N decisions recorded…"
> confirmation) WITHOUT the "Undo this whole import" button and timer. The staged tray (§8,
> decide≠apply) is v1's safety net. When the undo slice lands, this section's undo pattern is its
> design reference. Do not build the undo button in R2′.

On successful apply, the tray transforms in place (same DOM position, not a new modal/page) into a
receipt panel. Motion: **Fade + Settle** per DESIGN_STANDARD §5d pattern — `useEnterTransition('settle')`
— `translateY(12px)→0`, `opacity 0→1`, `--motion-settle` (340ms).

Content:
- Success icon (outline check, `var(--success)`, 18px) + `"Applied. {n} decisions recorded, {m} rows
  left for review."` (plain language — never "committed", never "transaction").
- A visible countdown/undo affordance: `"Undo this whole import"` as a prominent text-button
  (`var(--primary)`, `14px/600`, underlined) with a small inline timer chip next to it:
  `"available for {mm:ss}"` (monospace, `var(--font-mono)`, `12px`, `var(--text-secondary)`). The
  grace window duration is an Architect/backend decision (flagged §11) — this spec fixes the visual
  pattern, not the number.
- After the window elapses, the undo button fades to a disabled/greyed state (`color:
  var(--text-secondary)`, no underline) with copy `"Undo window closed"` — never disappears entirely
  (a director should still see that the option existed and is now gone, not wonder if they missed it).
- Clicking undo triggers the compensating-inverse-ops path (per R1′ binding invariant #3) and, on
  completion, replaces the receipt with a plain confirmation line:
  `"Import undone. Your camp is back to how it was before."` — no fanfare, `Fade` only, `--motion-base`.

---

## 10. Empty / end state — "Nothing left to reconcile"

Triggered when the triage lane has zero `hold`+`standard` decisions (either nothing needed attention
from the start, or everything has been resolved and applied). Follows DESIGN_STANDARD §5a exactly:
centered block, `padding: '60px 16px'`, **no card, no border, no shadow**.

- Icon: outline checkmark-in-circle, ~40px, `stroke-width: 1.5`, `var(--success)` (the one empty-state
  variant in this app that earns a non-neutral icon color, because this is a genuinely good outcome,
  not an absence to be neutral about — still not `--accent`/`--danger`, stays inside the palette's
  status-green role).
- Title: `IBM Plex Sans 600, 15px` — `"Nothing left to reconcile."`
- Body: `13px, var(--text-secondary)` — `"Your camp setup reflects this file. You're ready to build a
  schedule."` (plain language tying back to the product goal — never "the ledger is clear").
- No CTA button required (this is the natural landing state, not a dead end); if the calling context
  wants a next-step nudge, a single `S.btnPrimary` `"Go to Schedule"` may be added by Maker using the
  existing `onNavigate` prop — optional, not specified further here.
- Motion: `Fade + Lift` on mount, `--motion-base`, per §5a.

---

## 11. Data dependencies flagged for Architect (do not guess these away)

1. **Blast-radius signal.** `salienceOf` as specified needs more than confidence tier to produce a
   genuinely "readiness-demand"-ordered lane (e.g., a name change touching 40 scheduled slots vs. one
   touching zero). If the report doesn't expose this, `salienceOf` degenerates to confidence-tier
   sort, which is a smaller but shippable v1 — flagging so the gap is a decision, not a surprise.
2. **Evidence strings.** §4's "seen in row 14, Groups tab" / "set by hand 2026-06-02 (Dana)" assumes
   `import_evidence` carries a row/sheet locator and that provenance carries an editor identity +
   timestamp. Confirm both are present on every decision the UI needs to render evidence for; if
   editor identity isn't tracked, the copy degrades to "set by hand" without a name.
3. **Grace-window duration + persistence.** §9 needs an actual number (minutes) and confirmation that
   the compensating-inverse-undo path can compute "what to skip" (entities touched since import)
   synchronously enough for a snappy UI, or whether it needs its own loading state.
4. **Standard-card default-on-skip behavior** (§8) — whether leaving a `standard` card untouched and
   hitting "Use this setup" safely defaults to "use proposed value," per R0 Q9/Q10, needs an explicit
   confirm from Architect before Maker wires it — this design assumes yes.
5. **Facility evidence gap** (R0 stale-assumption #4) — `locations` isn't an evidenced `entity_type`
   today. If a CHANGED card exists for a location field, §4's evidence panel has nothing to show;
   Maker should fall back to the collapsed line reading "From this file" with no comparison table
   until that gap closes, rather than rendering an empty table.

---

## Animation summary (all values from DESIGN_STANDARD §8 — no new curves, no new durations)

| Moment | Trigger | Variant | Values |
|---|---|---|---|
| Understood receipt expand | click "Show details" | max-height reveal | `--motion-base`, `--ease-out` |
| Evidence panel expand | click "Why?" | max-height reveal | `--motion-base`, `--ease-out` |
| Not-in-source list expand | click "Show them" | max-height reveal | `--motion-base`, `--ease-out` |
| Card resolves | radio/button click | opacity 1→0.6 + content swap | `--motion-fast` (140ms), crossfade |
| Header spine progress bar | resolution count changes | width transition | `--motion-base`, `--ease-out` |
| Tray staged-count update | resolution count changes | opacity crossfade only | `--motion-fast` |
| Receipt panel appears | apply succeeds | `useEnterTransition('settle')` | `--motion-settle` (340ms), translateY 12px→0 |
| Empty/end state mounts | lane reaches zero | Fade + Lift | `--motion-base`, translateY 8px→0 |
| Undo confirmation | undo completes | Fade only | `--motion-base` |
| Filter chip select | click | background/color transition | `--motion-fast`, no transform |

Every reveal uses `prefers-reduced-motion` → opacity-only crossfade, per §8 global rule (no
component-level exceptions needed; all of the above route through `useEnterTransition` or an
equivalent `max-height` pattern that already respects `prefersReducedMotion()`).

---

## Prototype

[`2026-08-17-reconciliation-onescreen-mockup.html`](2026-08-17-reconciliation-onescreen-mockup.html) —
self-contained, real tokens/fonts, realistic data for a mid-size overnight camp (Camp Kinneret, 482
rows, 6 decisions needing attention: 2 hold, 4 standard). Demonstrates: header spine, collapsed
understood receipt (expandable), filter chips with counts, both card ranks side by side, one CHANGED
card with the three-option resolution shown expanded, evidence disclosure open on one card, not-in-
source gap, sticky tray footer with both buttons, and the post-apply receipt state (toggle via a
dev-only switch at the top of the mockup — not part of the shipped UI).

---

## Implementation Notes for Maker

- New CSS is **not** warranted here — `src/components/schedule/` is the only scoped CSS exception and
  this screen is outside it. All `max-height` reveals and the sticky-tray shadow are expressible as
  inline styles + the existing `useEnterTransition` hook; do not add a stylesheet.
- The card resolution state (`resolutions: Map`) should mirror the shape `commitInputsWithResolutions`
  already accepts — do not invent a parallel resolution schema; check `electron/ops/ingest.js` for the
  exact input contract before wiring.
- `salienceOf(decision)` belongs in `src/ingest/` alongside `reconciliationReport.js`, pure and unit-
  testable like the engine's `slotCellConstants.test.js` precedent — per R1′ binding invariant #2, it
  must be deterministic and unit-tested, not computed inline in the component.
- The roots-spine kill-switch is a local UI preference, not a schema field — do not add a DB column or
  op-log entry for it.
- Do not delete `ReconciliationQueue.jsx`/`HeldResolution` code paths until R2′ implementation
  confirms `commitInputsWithResolutions` covers every resolution shape those files handled (R0 §13
  flags them deletable, but deletion is an implementation-time verification, not a design decision).
- The "Facility" filter chip must never render a warning glyph or `--danger`/`--accent` tint purely
  because its count is 0 — zero is a valid, calm state for a spreadsheet with no location data.
