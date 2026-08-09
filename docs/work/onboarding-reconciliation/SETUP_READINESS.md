---
title: "Setup Readiness as the Onboarding Hub"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Setup Readiness as the Onboarding Hub

Derived from the synthesis source §5 (Designer). This is a design synthesis, not an
implementation plan — no code changes are authorized by this document. It records what the
readiness surface should become and the invariants any eventual implementation must hold.

## 1. What exists today (verified against `src/engine/readiness.js`)

`readiness.js` is a small, deliberate, honest module. It answers exactly one question — *"Can
this camp build a week yet, and if not, what is missing?"* — and the file's own header records
that it exists because the app once held four disagreeing answers to that question.

- `REQUIRED_AREAS` (lines 37–71): the **five** areas that gate building a week — `tiers`/Units,
  `groups`, `days`, `timeblocks`, `activities`. Each carries `{ key, label, screen, message }`
  so every surface can navigate to the same screen and say the same sentence. Programs are
  deliberately absent (auto-created "Main", lines 24–36).
- `OPTIONAL_AREAS` (lines 76–79): `anchors` (Fixed Events) and `dayoverrides` — present in the
  sidebar and setup screen but **never a gap**. The comment is explicit: flagging a finished
  camp as unfinished "teaches directors to ignore the flag that matters."
- `getSetupGaps(collections)` (lines 102–108): the pure blocking-truth core. Filters
  `REQUIRED_AREAS` to those whose backing collection is missing or empty. Returns `[]` when the
  camp can build a week. A missing collection counts as *empty*, not *present* (lines 99–101),
  to avoid flashing "ready" mid-load.
- `describeSetupGaps(gaps)` (lines 114–123): one honest sentence for a director, not a progress
  bar — the comment records that it "replaces a fraction of the wrong set."

The sidebar already consumes this. `Sidebar.jsx` calls `getSetupGaps` via `countGaps`
(lines 12–21) and renders a fixed-width glyph per row (lines 152–215) using the vocabulary this
hub must reuse verbatim.

## 2. The core decision: promote readiness to the onboarding HUB

Readiness becomes a real **screen** — the home base of the whole onboarding experience, a
full-screen expansion of the sidebar rollup. It is where sources are provided, proposals are
reviewed, and the director always knows where setup stands.

**`getSetupGaps` is not touched.** It remains the untouched blocking-truth core. The hub is an
**additive states layer wrapped around it** — the binary gap/no-gap answer stays authoritative
and every surface keeps reading it. This preserves the module's hard-won single-source-of-truth
property (Constitution Article I; the file's own design intent).

## 3. The six-state layer — NOT a percentage

The binary model (`gap` / `no gap`) cannot express the distinctions onboarding needs. Wrap it
with **six named states**. A percentage is explicitly rejected — `describeSetupGaps` already
replaced a lying fraction, and a progress bar re-introduces exactly the dishonesty the module
was built to remove.

| State | Glyph | Color role | Meaning |
|---|---|---|---|
| **Ready** | `✓` | `--success` | Area is satisfied; nothing to do. |
| **Needs-attention** | `!` | `--accent` (bronze) | Resolvable — a proposal to review, an ambiguity to confirm, an inferred value worth checking. Does **not** block a week. |
| **Missing** | `!` | `--danger` (red) | **Blocks a week.** A required area is empty. Kept rare and loud. |
| **Optional** | `·` | `--text-secondary` | An optional area (Fixed Events, Day Overrides) with nothing set — finished, not unfinished. |
| **Not-applicable** | `–` | dimmed | Does not apply to this camp (e.g. Staffing at a camp that supplies none). |
| **In-progress** | `⋯` | `--accent` | A reconciliation plan is staged for this area but not yet committed. |

### The critical new distinction

The one distinction the binary model structurally cannot make, and the reason this layer exists:

> **Missing (red, blocking, rare)** vs **Needs-attention (bronze, resolvable).**

`getSetupGaps` returns both as "a gap" today. The hub separates them: **Missing** is a required
area that is genuinely empty — the schedule cannot build, so it is red and it is loud. **Needs-
attention** is everything the reconciliation layer surfaces for judgment — a proposal, a
possible duplicate, an inferred rule — which is bronze and resolvable, never red. Keeping red
rare is what keeps it meaningful; this mirrors DESIGN_STANDARD §4's core "reserve the alarm
color" move (bronze `--accent` carries caution/attention; brick `--danger` is reserved for
"blocking / this is wrong").

## 4. Reuse the sidebar glyph + color vocabulary exactly

The hub is the full-screen expansion of the sidebar rollup, so it must speak the sidebar's
existing visual language rather than invent a parallel one:

- `Sidebar.jsx` line 23: `MARK_COLOR = { '✓': --success, '!': --danger, '·': --text-secondary }`.
- `Sidebar.jsx` lines 24–27: `TONE_COLOR` maps `danger` / `success` / `warning` / `secondary`.
- Glyphs are **fixed-width** and color is **never the only carrier** (lines 7–9, 180–186): `!`
  is a distinct glyph *and* carries the word "needed"; `✓` carries a count. The hub inherits
  this rule — every state pairs glyph + word + color, so it survives greyscale and color-vision
  deficiency exactly as the sidebar does.

The two states the six-state layer adds beyond today's three glyphs — `–` (Not-applicable) and
`⋯` (In-progress) — extend this vocabulary in the same spirit (distinct glyph, a word, a muted
color role) and should be reflected back into the sidebar rollup so the two surfaces never
disagree.

## 5. Keep the honest one-sentence summary

`describeSetupGaps` stays as the hub's headline. **Blocking truth first**, then a quiet
needs-attention count line beneath it. For example:

> **One thing still needed before you can build a week: Activities.**
> 3 items could use your attention.

The blocking sentence is `describeSetupGaps(getSetupGaps(...))` unchanged. The second line is
the additive layer's count of Needs-attention items and is visually quieter (secondary text),
so it can never be mistaken for a blocker. Ready-state headline remains the existing
`'Ready to build a week.'`

## 6. Two doors per category

Every category on the hub offers **two doors to the same room**:

> `[ Review on screen ]  [ Download worksheet ]`

Both lead to the identical reconciliation layer (the in-app editor and the workbook are two
renderings of one `ReconciliationPlan`; see `ONBOARDING_UX_OPTIONS.md`). The worksheet is not a
bypass — it re-enters through the same non-skippable preview and atomic commit. This unifies the
two import paths the current-state audit flagged as *not* sharing a reconciliation layer
(per-screen `downloadTemplate` xlsx vs `ImportScreen.jsx`).

## 7. Location + Staffing appear as Optional / Not-applicable — never blocking

Location and Staffing surface on the hub as categories, but only ever in **Optional** or
**Not-applicable** states. They **never** enter Missing and never block a week:

- The schedule always generates with zero staffing (synthesis §6); staffing is captured as
  durable facts, never a readiness gate.
- Location is already an engine factor (contention via `locationKey`), so promoting it is an
  onboarding concern, not a new blocker (synthesis §7).

This is a hard invariant: `getSetupGaps` must **not** gain Location or Staffing entries.
`REQUIRED_AREAS` stays the five it is today. Location/Staffing live only in the additive layer.

## 8. Move a minimal read-only hub shell earlier

The early source-intake steps (S0–S2 in the sequence) need somewhere to surface state before the
full hub is built. So a **minimal, read-only hub shell** moves earlier in the sequence, alongside
S0–S2, rather than waiting for the full six-state screen (S5). It shows the blocking truth and
the two-doors affordance; the richer six-state rendering lands later. This gives the reconciler
a home from the first slice without front-loading the whole design.

## 9. Invariants any implementation must preserve

1. `getSetupGaps` and `REQUIRED_AREAS` are unchanged blocking truth — the five required areas,
   Programs absent, optional areas never gaps.
2. The six-state layer is **additive** and reads *from* `getSetupGaps`, never replacing it.
3. **No percentage / progress bar.** The honest sentence stays.
4. Missing (red, blocking) and Needs-attention (bronze, resolvable) are distinct and must not
   collapse back into one "gap."
5. Glyph + word + color together — color is never the sole carrier (DESIGN_STANDARD §1; Sidebar
   lines 7–9).
6. Location and Staffing never appear as blocking; `REQUIRED_AREAS` never grows.
7. The hub and the sidebar rollup read from one source and never disagree.
