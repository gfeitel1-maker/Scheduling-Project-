---
title: "Ingestion Reconciliation — R8′ workspace honesty + compression design spec"
document_type: spec
status: draft
created: 2026-08-17
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_docs:
  - docs/work/runs/2026-08-17-reconciliation-acceptance-test.md
  - docs/work/specs/2026-08-17-reconciliation-onescreen-design.md
prototype: docs/work/specs/2026-08-17-reconciliation-r8-honesty-compression-mockup.html
archive_when: superseded by the R8′ implementation run record, or the design is rejected
---

# DESIGN SPEC — Reconciliation R8′ (workspace honesty + compression)

This is a **delta spec** on top of the shipped one-screen design
(`docs/work/specs/2026-08-17-reconciliation-onescreen-design.md`, R2′b, still governing). It does not
restate that document's layout, personality, or token vocabulary — read it first. Everything below is
scoped to the three acceptance-test findings (F1/F2/F3) plus the compression pass they motivate. Ground
truth renders unchanged: `buildReconciliationReport` → `{ buckets, decisions, meta }` →
`reportToLanes` → `{ express, standard, hold, spine, readinessGreen }`
(`src/ingest/reconciliationReport.js`, `src/ingest/reportToLanes.js`). This design translates at the
presentation layer only.

**Acceptance test this design answers to:** with the roots spine off and rendered in greyscale, the
screen must still read as a plain sorted checklist — unchanged from R2′b. F1/F3's new rows are typographic
and structural (spacing, order, a dashed hairline, the existing bronze accent), never a new colour.

---

## F1 — set-aside items surfaced inside the workspace (BALANCED option, recommended)

### The problem, restated precisely
`ImportScreen.jsx`'s `buildPreview()` step (still upstream of `ReconciliationScreen`) computes, per
entity, a `create` list and a `lowConfidence` subset of it (`preview.perEntity[entity].lowConfidence`,
`ImportScreen.jsx` ~lines 283–294). The initial `chosen[entity]` set is `create.filter(n => !low.has(n)
&& …)` — every low-confidence candidate starts **unticked**, i.e. excluded from `baseInputs` before
`ReconciliationScreen` ever sees the file. Nothing downstream (`buildPlan`, `buildReconciliationReport`,
`reportToLanes`) has any record that these candidates existed and were set aside. They are not
`notInSource` (they WERE in the source); they are not `understood` (nobody looked at them); they simply
never enter the pipeline. This is real, honest exclusion-by-default (Q8/§D5's own contract: "nothing is
ever minted or bound without the director's explicit tick") — the finding is not that the exclusion is
wrong, it's that reconciliation-the-workspace has no visibility into it, so the screen under-reports the
director's actual involvement in a clean import.

### Recommendation: Option B (surface, don't relocate)
**Ship B — a quiet, in-workspace "set aside" affordance — not A (folding ticking wholesale into the
workspace).** Confidence: high for B being the right v1 shape; medium-high that A should stay deferred
rather than cancelled.

Reasoning: A collapses two genuinely different judgment types into one lane — "is this candidate real"
(ticking, currently upstream, all-or-nothing per row) vs. "which of these two known values wins"
(reconciliation's actual card shape, always A/B/other). Folding A's shape into B's UI would either (a)
force every low-confidence create into a fake confirm_value card with an invented "current" side that
doesn't exist yet — dishonest, or (b) require a genuinely new card kind and resolution vocabulary
(tick/skip, not accept/keep), which is a real Architect-scoped change, not a visual delta. B gets 90% of
the honesty benefit — nothing is silently dropped, the count is visible where the director is already
looking — at a fraction of the surface area, and it composes cleanly with the existing express/standard/
hold rank system instead of adding a fourth rank. A remains the right answer if the owner later decides
the two-stage IA itself (upload-and-tick, then reconcile) should collapse into one stage; that is a
bigger IA call this spec does not make.

### Spec — the set-aside row
Positioned directly under the Understood receipt (§2 of the base spec), same visual register: not a
card, no border, no shadow, `padding: '10px 4px'`, `13px`, `var(--text-secondary)`. Icon: outline
dashed-circle, 14px (same glyph vocabulary as the Not-in-source gap, §7 of the base spec — this row and
that one are semantic siblings: "things the file offered that a human choice kept out of scope").

Copy: `"We set aside {n} items we weren't sure about while reading the file."` — never "rejected," never
"excluded," never a percentage. If `n === 0`, the row renders nothing (same honestly-empty rule as every
other optional section in this screen).

A plain-text disclosure toggle (`"Show them"` / `"Hide"`, `var(--primary)` link-button) reveals a list,
`max-height` reveal per `--motion-base`/`--ease-out` (identical pattern to Understood/Not-in-source).
Each row:

```
Free Swim                                          [ Bring into review ]
seen once, in Chalutzim only — not clearly a camp-wide activity
```

- Name: `13px`, `var(--text)`.
- Reason: `12px`, `var(--text-secondary)`, directly under the name — this is the SAME "why it was
  low-confidence" sentence `buildPreview`'s `lowConfidence` classification already carries (seen-once /
  not-universal-in-a-unit / merged-name-looking), translated the same way `CONFIDENCE_COPY` in
  `ReconciliationScreen.jsx` already translates the tier vocabulary — reuse that mapping, do not invent
  new prose per reason code.
- `"Bring into review"` — compact secondary button (`btnCompactSecondary` style, `padding: '4px 10px'`,
  `12px/600`). Clicking it does exactly what re-ticking the row in `ImportScreen` does today: adds the
  candidate back into `chosen[entity]`, which re-runs the dry-run and lets the candidate surface as a
  normal `confirm_value` card (almost certainly `standard` rank, since these are exactly the
  low-confidence creates that rank system already treats as one-tap review) in the triage lane above.
  **No new resolution vocabulary** — pulling an item back in does not resolve it, it just makes it
  eligible for the existing card machinery to classify and render.

### Data dependency flagged for Architect
The set-aside list and the "bring into review" action need a **live handle on `chosen`/`lowConfidence`
state, which today lives entirely inside `ImportScreen.jsx`'s component state, not in `baseInputs` or the
report.** Two shapes are possible and Architect should pick:
1. **Thread it down** — `ImportScreen` passes `{ setAsideCandidates: [{entity, name, reason}], onBringIntoReview(entity, name) }` as props into `ReconciliationScreen` alongside `baseInputs`, and re-runs its own `buildPreview`-derived `chosen` update when a candidate is pulled back in (crosses the antechamber/workspace boundary this spec's parent doc calls "out of scope," but only as a thin prop, not a merge of the two screens).
2. **Move the concept downstream** — have `buildPlan`/`buildReconciliationReport` itself carry low-confidence-excluded candidates as a new `buckets.setAside` (or similar) so `ReconciliationScreen` is a pure projection again, matching the ADR's "no state beyond the report + in-progress answers" invariant.
Recommendation: (2) is more architecturally consistent with the existing "screen is a pure projection"
invariant and should be preferred if the cost is acceptable; (1) is the smaller patch if a same-milestone
ship date matters more than that invariant. Either way, this is an Architect decision, not resolved here.

---

## F2 — CHANGED "from → to" for the moved-anchor card

### The problem, restated precisely
`addFixedEventDecision` (`reconciliationReport.js:216-239`) is the sole constructor for both `moved` and
`scopeChanged` fixed-event decisions. It hard-codes `field: null, proposedValue: null` and carries only
`reason` (a prose string, e.g. `"Free Swim moved from Period 3 to Period 5"` — exact wording depends on
`electron/ops/ingest.js`'s fixed-event diff, not verified here) plus whatever `fixedEventEvidence[name]`
happens to hold. `DecisionCard`'s existing `ResolutionControls` for `confirm_change` (in
`ReconciliationScreen.jsx`) already tries to show `decision.proposedValue` via
`JSON.stringify(decision.proposedValue)` — for a moved anchor this always renders literally `"null"`,
which the acceptance test correctly flags as thin/unreadable.

### Design response — two tiers, both honest
The card must never claim structured data it doesn't have. Two rendering paths, chosen automatically by
what the decision actually carries (mirrors the existing `evidenceDisclosure()` table/text fallback
pattern already shipped for evidence — same discipline, applied to the from/to panel):

**Tier 1 — enriched (needs new data, see Architect flag below).** A two-column `fromTo` panel directly
under the evidence line, inside the same card:

```
Current Shoresh record          →          This file
Tue & Thu · Period 3 · Lakefront            Tue & Thu · Period 5 · Lakefront
```
Style: `display:flex`, two `.side` blocks each with a `10px` uppercase label (`"Current Shoresh
record"` / `"This file"`) in `var(--text-secondary)` and a `13px/600` value in `var(--text)`, an arrow
glyph between them in `var(--accent)` (bronze — this is the same caution/attention hue the `hold` card
already uses for its left bar, so the panel doesn't introduce a new colour role). Container:
`background: color-mix(in srgb, var(--accent) 6%, var(--surface))`, `border: 1px solid color-mix(in srgb,
var(--accent) 22%, var(--border))`, `borderRadius: 6`, `padding: '10px 12px'`, `margin-top: 10px`. This
reuses the caution-tint recipe DESIGN_STANDARD already specs for the auth lockout box (§6 of the
standard) — not a new pattern.

The two radio options underneath name the concrete values instead of the current prose-only phrasing:
`"Use the file's placement — Tue & Thu, Period 5"` / `"Keep it where it is — Period 3"` (matches the base
spec §5b's "name the two concrete values" requirement for every `confirm_change` card, now actually
achievable for this card kind).

**Tier 2 — degraded (today's actual shape, ships first if Architect doesn't extend the data).** No panel.
A single muted note directly under the evidence line: `"What changed: {reason}"` in a dashed-bordered box
(`border: 1px dashed var(--border)`, `12px`, `var(--text-secondary)`, `padding: '8px 10px'`) — visually
distinct from the enriched panel (no bronze tint, dashed not solid) so a director can tell "we know the
before/after" from "we only know that something changed," rather than one style silently doing both jobs.
The radio options fall back to `"Use the file's placement"` / `"Keep the current placement"` — still no
`JSON.stringify(null)`, but honestly generic where the data is generic.

### Data dependency flagged for Architect
Tier 1 requires the fixed-event diff (in `electron/ops/ingest.js`'s moved/scopeChanged construction,
upstream of `fixedEventsReport`) to additionally carry structured before/after fields — at minimum the
day(s), period/time-block, and location the anchor moved from and to — not just the prose `reason`
string. This is a **report/logic change**, not a rendering choice: `addFixedEventDecision` would need a
new optional `{ from, to }` shape threaded through from wherever `ingest.js` currently computes the
`reason` sentence (it almost certainly already has these values in scope to build that sentence — the
gap is that they're formatted into prose and discarded rather than kept structured). Recommend Architect
confirm whether `ingest.js`'s move-detection already has the structured values on hand (likely yes, since
it has to compare them to write the reason string) before treating this as new computation vs. a
plumbing-only change.

---

## F3 — required gap as an attention item, not a hidden flag

### The problem, restated precisely
`reportToLanes.js` already computes `readinessGreen` correctly from `report.readiness` (`row.kind ===
'required'` rows must all be `state === 'ready'`) — the LOGIC is honest. The UI is not: when the required
gap is the ONLY thing standing between "done" and "ready," the triage lane is empty (0 hold, 0 standard),
the header spine reads "0 of 0 done," and the only surviving signal that something is wrong is a
"readiness strip" that this design deliberately made unobtrusive elsewhere in the screen (it is not
mentioned as its own numbered section in the base spec — it is exactly the kind of easily-missed
secondary chrome the base spec's compression discipline was pointed at reducing). Two true statements —
"nothing to review" and "not ready to build" — currently coexist with no card connecting them.

### Design response — a required gap IS an attention card
Every `report.readiness` row where `kind === 'required'` and `state !== 'ready'` renders as a `hold`-rank
card in the triage lane itself, sorted **first** (ahead of every other `hold` card — a setup gap blocks
everything else, so it is the most readiness-demanding item there is). This is not a new rank, not a new
colour, not a new component: it reuses the existing `cardHold` shell (`var(--accent)` left bar, `padding:
16`, `14px/600` title) verbatim.

**One visual addition, and only one:** a small uppercase label above the top-left corner of a
required-gap card only — `"READY TO BUILD?"`, `10px`, `var(--font-mono)`, `letter-spacing: 0.06em`,
`var(--accent)`, positioned as a tab breaking the card's own top border (background `var(--bg)` so it
reads as a label sitting on the hairline, not a badge floating over content). This is the one deliberate
exception to "no badge color-coding beyond the bronze bar" from the base spec §3 — justified because this
card kind is answering a categorically different question ("can I build at all") than every other card in
the lane ("which value is right"), and conflating the two by giving it an identical unlabeled shell would
recreate exactly the confusion F3 exists to fix. Grayscale test: the label survives as plain bold caps
text, no colour dependency for legibility.

Card anatomy:
- **Question line** (`14px/600`): `"{gapLabel} aren't set up yet — {reason}."` e.g. `"Units aren't set up
  yet — this file didn't include one, and your camp needs at least one to build a schedule."` Built from
  `readiness.js`'s existing `{ label, message }` shape (`readiness.js:196`) — `label` is already
  human ("Units"), `message` is the existing optional detail string; if `message` is absent, fall back to
  a generic `"{label} is required before you can build a schedule."`
- **Meta row** (`12px`, `var(--text-secondary)`): `"setup · {label} · Structure"` — literal string
  `"setup"` in the entity-icon slot (no entity icon exists for a readiness gap; a plain wrench/gear
  outline glyph, 14px, is acceptable if Maker wants a non-empty icon slot, but text-only is also fine).
  Domain classification: `Structure` for Units/Groups/Cohorts, matching `DOMAIN_OF`'s existing mapping —
  reuse it, do not invent a second domain table for readiness rows.
- **Body line** (`13px`, `var(--text-secondary)`): one sentence naming why nothing was proposed —
  `"This file has no unit/tier column, so nothing was proposed. This isn't a decision about the file —
  it's a gap in your camp's own setup."` This sentence is the one place in the whole screen that
  explicitly distinguishes "the file is silent" from "the file is wrong," which is exactly the honesty
  gap F3 is about.
- **Resolution row** — NOT a radio group (there is no file value to accept/reject). Two buttons:
  - `"Set up {label}"` — `btnCompact`-scale button, but tinted bronze (`background: var(--accent)`,
    `color: #fff`) rather than the usual primary/secondary pair, since this isn't a reconciliation choice,
    it's a navigation escape hatch. Calls `onNavigate(readinessRow.screen)` (the `screen` field
    `readiness.js` already attaches per-row) — same navigation contract `EndState`'s existing "Go to
    Schedule" button already uses elsewhere in this file.
  - `"Skip {label} for now — I'll add it later"` — `btnCompactSecondary`. This does NOT resolve the card
    (there is nothing to write); it is a dismissal that removes the card from the SPINE'S denominator for
    this session only (component state, e.g. `dismissedGaps: Set<key>`, not persisted, not synced,
    matching the roots-spine kill-switch's "local UI preference only" precedent) so a director who
    genuinely wants to finish reconciliation first and set up Units later isn't blocked from ever reaching
    "done" on this file. The `readinessGreen`/"Use this setup" gate is unaffected by dismissal — dismissal
    only quiets the card, it never fakes readiness.

### Spine and denominator
`totalCount`/`doneCount` (header spine, base spec §1) extend to include required-gap cards:
`totalCount = holdCount + standardCount + requiredGapCount`, `doneCount` treats a dismissed gap as done
for spine purposes only (the spine is a work-tracking UI, not the readiness gate). This keeps the
"0 of 0 done" contradiction from ever recurring: if a required gap exists, the spine is never "0 of 0."

### Data dependency flagged for Architect
None — `report.readiness` already carries everything this card needs (`key, label, screen, kind, state,
message?`, `readiness.js:179`). This finding is pure UI: the data was already honest, only invisible.

---

## Compression pass — what should DISAPPEAR for the common case

Grounded in the acceptance test's actual numbers (118 facts, 0 forced decisions on a clean import, 1 on a
changed one): the shipped screen already compresses well structurally, but three things still render
unconditional chrome that the common case doesn't need.

1. **Remove the separate "readiness strip"-style secondary UI entirely** (wherever an implementation
   currently renders a standalone readiness banner outside the triage lane, if one exists beyond the
   `readinessGreen`-gated tray button state). F3's required-gap card replaces it. Do not keep both a card
   AND a strip — that reintroduces the exact "two places say two things" problem F3 fixes. **This is the
   single largest compression win in this pass**, because it deletes a whole secondary information
   channel rather than shrinking an existing one.
2. **Collapse the filter chip row when every domain count is the same as `(0)` or `(1)` total across all
   four** — i.e. when the lane has ≤1 item, multi-select filtering has no work to do. Render the chips
   only when `totalCount + requiredGapCount > 1`. On the acceptance test's clean-import case (0 decisions
   + a possible required gap = 1 card), the filter row would not render at all. This is a small but real
   reduction of unconditional chrome for the majority-honest-import case.
3. **Do not add a distinct "F1 set-aside" AND "F3 required-gap" visual language beyond what's specified
   above.** Both reuse existing card/row shells rather than introducing new colours, new card widths, or
   new type scales. The temptation with two new findings is two new visual treatments; resist it — the
   whole point of this pass is that the screen should look like it always looked this way, just more
   honest.
4. **Do NOT add a persistent "3 things you should know" summary banner at the top of the screen** — this
   was considered and rejected. It would duplicate the header spine + set-aside row + required-gap card's
   combined signal in a fourth place, working against compression rather than for it.

Net effect on the acceptance test's actual data: the clean-import screen goes from {header, understood
receipt, empty lane, empty tray-disabled-state} to {header, understood receipt, one-line set-aside row,
one required-gap card in the lane, tray}. That is objectively MORE visible information (nothing was
previously silently true) at roughly the same or smaller visual footprint, because the filter row and any
standalone readiness strip disappear.

---

## States (delta from base spec §"States")

| State | Rendering |
|---|---|
| `setAsideCount === 0` | Set-aside row renders nothing (not even collapsed) |
| Set-aside item "brought into review" | Row leaves the set-aside list (no exit animation needed — the list itself remains mounted with `max-height` intact via `useMaxHeightReveal`, so removing one row just reflows), reappears as a normal card in the triage lane on the next dry-run pass |
| Required gap dismissed ("Skip for now") | Card fades out via the same `opacity 1→0.6` + content-swap crossfade `DecisionCard` already uses for a resolved card (`--motion-fast`), replaced by a one-line `"Skipped — {label} still isn't set up."` + `Undo` link, matching the resolved-card pattern exactly |
| Required gap card + CHANGED card both present | Required gap sorts first (readiness-demand order, §3 of base spec already establishes "hold sorts first"; required gaps are the most-demanding subset of hold) |
| F2 enriched data absent (today, always) | Tier 2 degraded box renders; no `JSON.stringify(null)` ever reaches the DOM |

## Interactions (delta)

- Clicking "Bring into review" on a set-aside item: re-runs the dry-run exactly as ticking a checkbox in
  `ImportScreen` does today (same debounce/staging mechanism `stage()` already uses in
  `ReconciliationScreen.jsx`) — no new network/IPC shape, assuming the Architect-flagged data threading
  above lands.
- Clicking "Set up {label}" on a required-gap card: calls the existing `onNavigate(screen)` prop, same as
  `EndState`'s "Go to Schedule" button. Reconciliation state (staged answers) is NOT lost — this is
  navigation to another screen, not a teardown; the base spec's existing screen-routing model
  (`AppShell`/`SCREENS`) already preserves this for free since `ReconciliationScreen` doesn't own the
  screen stack.
- Clicking "Skip {label} for now": local-only dismissal, no write, no IPC call.

## Animation (delta — reuses base spec §"Animation summary" tokens verbatim, no new curves/durations)

| Moment | Trigger | Variant | Values |
|---|---|---|---|
| Set-aside list expand | click "Show them" | max-height reveal | `--motion-base`, `--ease-out` |
| Set-aside item removed (brought into review) | click "Bring into review" | list reflow, no explicit exit transition (small list, instant removal reads as responsive, not jarring) | none |
| From→to panel appears | card renders (not user-triggered — mounts with the card) | none — static, part of card layout, not an animated reveal | n/a |
| Required-gap card resolves (dismissed) | click "Skip for now" | opacity 1→0.6 + content swap | `--motion-fast` (140ms), same as any other resolved card |
| Filter row mounts/unmounts (compression rule 2) | lane count crosses the 1-item threshold | Fade only | `--motion-fast` |

All reveals respect `prefers-reduced-motion` via the same `useMaxHeightReveal`/`useContentCrossfade`
hooks already shipped — no new reduced-motion branch needed, these are the same hooks, new call sites.

## Prototype

[`2026-08-17-reconciliation-r8-honesty-compression-mockup.html`](2026-08-17-reconciliation-r8-honesty-compression-mockup.html)
— self-contained, real tokens, data shaped after the acceptance-test workbook (prior-year.xlsx, a 14-sheet
camp workbook). Demonstrates: the set-aside row expanded with four real-shaped low-confidence candidates
and "Bring into review" buttons; a required-gap card for missing Units, sorted first, with the
`READY TO BUILD?` tab label; a CHANGED moved-anchor card with the enriched from→to panel (dev toggle at
top switches it to the Tier-2 degraded box, showing both states side by side); a standard-rank name-change
card; the compressed filter row; and a closing note describing what disappeared vs. the shipped screen.

## Implementation Notes for Maker

- **Do not build F1's "Bring into review" wiring, or F2's Tier-1 enriched panel, until Architect resolves
  the two data dependencies flagged above.** Ship Tier 2 (F2) and a placeholder/deferred state for F1's
  button (disabled with a tooltip, or simply omit the button and keep the list read-only) if the data
  plumbing isn't ready in the same milestone — never fabricate `from`/`to` values or a fake "brought back"
  state client-side.
- F3 has **no Architect dependency** — `report.readiness` already carries everything needed. This is the
  safe-to-build-immediately part of R8′.
- Required-gap dismissal state (`dismissedGaps`) is local component state, not persisted — matches the
  roots-spine kill-switch precedent (`docs/work/specs/2026-08-17-reconciliation-onescreen-design.md` §3)
  of "local UI preference, not a schema field."
- Reuse `CONFIDENCE_COPY`/`evidenceDisclosure()`'s table/text-fallback pattern for the F2 from→to
  enriched/degraded split — do not write a second confidence-translation table.
- The `"READY TO BUILD?"` tab label is a one-off exception to the base spec's "no badge color-coding
  beyond the bronze bar" rule (§3) — confirm with Governor/owner at review that this exception is accepted
  before shipping; if rejected, the required-gap card still functions correctly without it (it would just
  look identical to a normal hold card, which is the exact ambiguity F3 exists to remove — so this is not
  a decorative flourish to cut casually).
- New CSS is still not warranted (per base spec's Implementation Notes) — `src/components/schedule/` is
  the only scoped CSS exception and this screen remains outside it.

## Owner decision needed (design-review gate)

**F1: ship Option B as specified above** (recommended). Option A (fold ticking wholesale into the
reconciliation workspace) remains a legitimate future direction if the owner wants to eliminate the
two-stage IA entirely, but it is a larger, IA-level change this spec does not design — flag it back to
Governor as a possible future initiative if the owner leans toward A instead.
