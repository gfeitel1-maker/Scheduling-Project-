---
title: "S5 — Setup Readiness Hub: Design Spec"
document_type: design-spec
status: draft
authority: constraint-for-maker
created: 2026-08-08
author: Designer
program: onboarding-reconciliation
governing_docs:
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/work/onboarding-reconciliation/SETUP_READINESS.md
  - docs/work/onboarding-reconciliation/ONBOARDING_UX_OPTIONS.md
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
related_tickets: [T73, T75]
archive_when: superseded by an approved implementation plan
---

# DESIGN SPEC — S5 Setup Readiness Hub

The onboarding home base: a full-screen expansion of the sidebar's setup rollup. It answers
one question loudly — *can this camp build a week yet, and if not, what is missing* — then offers
a calm, per-category way in. This spec is a hard constraint for Maker. **No production code is
authored here.** Every colour, type, spacing, and motion value cites `DESIGN_STANDARD.md`; where a
value is not cited, it is a spacing/layout number chosen here and Maker uses it verbatim.

This spec reuses the existing sidebar vocabulary (`Sidebar.jsx`, `sidebarState.js`) and the
existing held-resolution surface (`ImportScreen.jsx`'s `HeldResolution`). It invents **no** second
visual language. Where it extends the vocabulary (two new glyphs, the ledger), it extends in the
same spirit — glyph + word + colour together, colour never the sole carrier.

---

## 0. Scope decisions (read first)

| # | Decision | Recommendation | Confidence |
|---|---|---|---|
| D1 | Does the hub replace or augment the landing screen? | **Replace** the current `tiers` default landing with the hub; add a `readiness` nav row at the top of Camp Set Up. | High |
| D2 | Does the reconciliation-preview **ledger** (T75) belong in S5? | **Yes — in S5.** It is the "nothing saved until you commit" surface both import paths must share. Spec'd in §7. | High |
| D3 | Is Programs shown as a category? | Shown, but permanently **Ready** and de-emphasized — never a step, never blocking (matches `readiness.js`). | High |
| D4 | Are Locations / Staffing shown? | Shown, but only ever **Optional** or **Not-applicable** — they never enter Missing. `REQUIRED_AREAS` must not grow. | High |
| D5 | Where do the two new glyphs (`–`, `⋯`) live? | Added to the hub AND reflected back into `sidebarState.js`/`Sidebar.jsx` rollup so the two surfaces never disagree (SETUP_READINESS §4). | Medium — see Owner Flag OF-2 |

Owner flags that genuinely need the product owner are collected in §11. Nothing below is a licence
to change `getSetupGaps`, `REQUIRED_AREAS`, or `DESIGN_STANDARD` — those are their own gates.

---

## 1. Layout

### Component structure

```
<ReadinessHub>                         // new screen, SCREENS['readiness'] in App.jsx
  <HubHeadline>                        // the honest one-sentence summary + quiet attention line
  <HubLedger?>                         // T75 preview — rendered ONLY when a plan is staged (§7)
  <CategoryList>                       // the per-category rows, grouped
    <CategoryGroup label="Required">
      <CategoryRow area="tiers" .../>       // Units
      <CategoryRow area="groups" .../>
      <CategoryRow area="days" .../>
      <CategoryRow area="timeblocks" .../>
      <CategoryRow area="activities" .../>
      <CategoryRow area="activityrules" .../>   // derived, never blocking (§4)
    </CategoryGroup>
    <CategoryGroup label="Optional">
      <CategoryRow area="anchors" .../>     // Fixed Events
      <CategoryRow area="locations" .../>
      <CategoryRow area="staffing" .../>
    </CategoryGroup>
    <CategoryGroup label="Programs" collapsed-by-default />  // Programs, quiet (§3, D3)
  </CategoryList>
</ReadinessHub>
```

`ReadinessHub` receives the same `counts`, `campId`, `role`, `onNavigate` props the sidebar
already threads, plus a new `plan` prop (the staged `ReconciliationPlan`, or `null`). It derives
per-category state from `getSetupGaps(counts)` exactly as `Sidebar.jsx`'s `countGaps` does — one
source of truth, never a second copy.

### Positioning and rhythm

- Screen is a single centered column, `maxWidth: 760` (matches `ImportScreen.jsx`), left-aligned
  content, sitting on `var(--bg)`. No card wraps the whole screen — the hub is a document, not a
  modal.
- Vertical rhythm: headline block, then `28px` gap, then ledger (if any) with `24px` below it,
  then the category list. Groups are separated by a `1px solid var(--border)` hairline with
  `20px` padding above/below — the same divider grammar the sidebar uses between sections
  (`Sidebar.jsx` line 91).
- Each `CategoryRow` is a full-width row, `padding: 12px 0`, hairline divider between rows within a
  group (quieter: `border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent)`).

### Anatomy of a CategoryRow

```
[glyph]  Label                      status text            [ Review on screen ] [ Download worksheet ]
 13px    flex:1                     mono, secondary        two-door affordance (§5), right-aligned
```

- `[glyph]`: fixed-width `13px` span, exactly as `Sidebar.jsx` lines 182–186 — colour from the
  state, `fontWeight: 700`, `fontSize: 11`. Fixed width so labels never shift as state changes.
- `Label`: `var(--font-sans)` 14px, `var(--text)`, `fontWeight: 500`. (Sidebar uses 13px; the hub
  is the full-screen expansion, so one step larger reads as the "home" version of the same row.)
- `status text`: `var(--font-mono)` 12px, colour keyed to state (§3). Short: a count, or a word
  like `needed` / `optional` / `not started`.
- Two-door buttons: right-aligned, only on rows where a worksheet exists (§5).

---

## 2. The headline — blocking truth first, attention second

The headline is two stacked lines. **Line 1 is `describeSetupGaps(getSetupGaps(counts))`
verbatim** — the unchanged blocking-truth core. Line 2 is the additive Needs-attention count, and
is visually quieter so it can never be mistaken for a blocker.

### Ready state

```
 ✓  Ready to build a week.
    3 items could use your attention — nothing blocking.
```

### Blocking state (rare, loud)

```
 !  One thing still needed before you can build a week: Activities.
    2 more items could use your attention.
```

### Copy rules

- Line 1 string comes from `describeSetupGaps` — **do not re-author it in the component.** Ready
  headline stays `'Ready to build a week.'`.
- Line 1 glyph: `✓` in `var(--success)` when no gaps; `!` in `var(--danger)` when gaps exist.
  Glyph is `18px`, `fontWeight: 700`, in a fixed `24px` lead column so line 1 and line 2 align.
- Line 1 text: `var(--font-condensed)` (IBM Plex Sans) `600`, `20px`, `var(--text)`. This is the
  one display-weight moment on the screen.
- Line 2 text: `var(--font-sans)` `13px`, `var(--text-secondary)`. Rendered **only** when the
  Needs-attention count > 0. Never render "0 items need attention" — a zero invites a director to
  look at something that is fine (the `sectionRollup` rule in `sidebarState.js` lines 20–24).
- Line 2 count = number of categories currently in **Needs-attention** or **In-progress** state
  (§4). It is a count of *categories*, not of individual field diffs — the field-level count lives
  in the ledger (§7).
- **Percentage is forbidden.** No `3/5`, no bar, no "60% complete" on this headline. The sidebar
  rollup may keep its `done / total` fraction (it is a compressed glance); the hub headline is the
  honest sentence and stays a sentence. (SETUP_READINESS §3, §5.)

---

## 3. The six states — reuse the sidebar vocabulary exactly

Every state is **glyph + word + colour**, never colour alone (`Sidebar.jsx` lines 7–9;
DESIGN_STANDARD §1). The first three glyphs and their colours are lifted directly from
`Sidebar.jsx` line 23's `MARK_COLOR`. The last three extend it in the same grammar.

| State | Glyph | Colour token | `status text` word | Meaning |
|---|---|---|---|---|
| **Ready** | `✓` | `var(--success)` | the count, e.g. `12` | Satisfied; nothing to do. |
| **Needs-attention** | `!` | `var(--accent)` (bronze) | `review` / `n to check` | Resolvable — a proposal, an inferred value, an ambiguity. **Does not block.** |
| **Missing** | `!` | `var(--danger)` (brick) | `needed` | **Blocks a week.** A required area is empty. Rare and loud. |
| **Optional** | `·` | `var(--text-secondary)` | `optional` | An optional area with nothing set — finished, not unfinished. |
| **Not-applicable** | `–` | `var(--text-secondary)` at `opacity: 0.5` | `not used` | Does not apply to this camp. |
| **In-progress** | `⋯` | `var(--accent)` (bronze) | `staged` | A reconciliation plan is staged for this area, not yet committed. |

### The one distinction that justifies this whole layer

> **Missing** (`!` brick, blocking, rare) reads as a *different emotion* from
> **Needs-attention** (`!` bronze, resolvable, common).

They share the `!` glyph deliberately — both are "look here" — but **colour and word carry the
emotional split**: brick + `needed` is "the schedule cannot build"; bronze + `review` is "worth a
look, your week is safe." This mirrors DESIGN_STANDARD §4's core move: reserve the alarm colour so
red stays scarce and therefore loud.

**Keeping red scarce is a hard constraint.** Only the five `REQUIRED_AREAS` can ever render
brick, and only when genuinely empty (`getSetupGaps` returns them). Activity Rules, Fixed Events,
Locations, Staffing, and Programs **can never render brick.** If a Maker finds themselves painting
a sixth category red, that is a bug against this spec.

### The two new glyphs

- `–` (Not-applicable): the en-dash, not a hyphen. Distinct from `·` (Optional) because
  "doesn't apply here" is a firmer statement than "you could add this and haven't." Rendered
  dimmed (`opacity: 0.5`) like the sidebar's `·` treatment (`Sidebar.jsx` line 185).
- `⋯` (In-progress): horizontal ellipsis (U+22EF), bronze. Means "a plan is staged; commit it or
  discard it." When any row is In-progress, the ledger (§7) is present above the list.

These two extensions must be reflected back into `sidebarState.js`'s `sectionRollup` and
`Sidebar.jsx`'s `MARK_COLOR` so the sidebar and hub never speak different dialects (Owner Flag
OF-2 covers whether the sidebar rollup surfaces In-progress at all).

---

## 4. Per-category state mapping (deterministic — the source of each state)

This table is the contract for *how* each category derives its state. It is deterministic; Maker
does not choose.

| Category | Source of state | Can be Missing (red)? | Two doors? |
|---|---|---|---|
| **Programs** | Always Ready (auto-created "Main", `ensureCohort.js`). | No | No — review only |
| **Units** | `getSetupGaps` → Missing if empty, else Ready (count). | **Yes** | Yes |
| **Groups** | `getSetupGaps`. | **Yes** | Yes |
| **Days** | `getSetupGaps`. | **Yes** | Yes |
| **Time Blocks** | `getSetupGaps`. | **Yes** | Yes |
| **Activities** | `getSetupGaps`. | **Yes** | Yes |
| **Activity Rules** | Ready if every activity has confirmed rules; Needs-attention if any rule is still `_inferred` (from `ImportScreen`'s `activityRules`); Optional if no activities yet. | No | Yes (embedded in the Activities worksheet) |
| **Fixed Events** | Optional if none; Ready (count) if some exist; In-progress if a plan stages any. | No | Review only |
| **Locations** | Not-started → Optional (`·`); Not-applicable (`–`) if the director marked the camp as single-site. | No | Review only |
| **Staffing** | Not-started → Optional (`·`); Not-applicable (`–`) if the camp supplies no staff. | No | Review only |

Notes:
- **Activity Rules** is the natural home for bronze Needs-attention: an import infers `min_per_week`,
  `max_per_week`, `priority`, and eligibility, and those inferences are exactly "worth checking,
  week is safe." It is *derived from* Activities and never blocks — if Activities is Missing,
  Activity Rules renders **Not-applicable** (`–ﾂ nothing to rule yet`), not a second red.
- **In-progress** overrides the base state for any category the staged `plan` touches. A staged
  plan for Activities shows Activities as `⋯ staged`, regardless of its underlying count, until the
  director commits or discards via the ledger (§7).
- Locations and Staffing default to Optional. The Not-applicable variant needs a place for the
  director to say "single-site" / "no staff" — that toggle is out of scope for S5's first slice
  (Owner Flag OF-3); until it exists, both render Optional.

---

## 5. Two doors to the same room

Every category that a worksheet can carry shows two doors, right-aligned in the row:

```
[ Review on screen ]   [ Download worksheet ]
```

- Both lead to the **same** `ReconciliationPlan` (ONBOARDING_UX_OPTIONS §2, §7). The worksheet is
  not a bypass — an edited worksheet re-enters through the identical preview + atomic commit
  (`ImportScreen.jsx`'s `handleWorkbookReimport` → `runCommit`, already the single commit path).
- **Which rows get two doors:** the five required areas + Activity Rules — i.e. exactly the
  categories the existing `downloadWorkbook` export covers (`INGESTIBLE_ENTITIES`, with rules
  embedded in the Activities sheet). Programs, Fixed Events, Locations, Staffing get a single
  **[ Review on screen ]** door until their worksheet coverage exists.
- **[ Review on screen ]** styling: `S.btnSecondary` (existing shared style), `fontSize: 12`,
  `padding: 4px 10px`. Navigates via `onNavigate(area.screen)` to the existing setup screen — the
  hub does not duplicate those editors, it routes to them.
- **[ Download worksheet ]** styling: a **link-button**, not a filled button — `var(--primary)`
  text, no border, `fontSize: 12`, underline on hover only. Downloading is a quieter act than
  navigating; a link keeps the row calm and keeps the two doors visually unequal in weight
  (navigate is the primary path, worksheet the alternate). It calls the existing
  `downloadWorkbook` flow scoped to that category where possible; if the export is whole-camp only
  today, the button downloads the whole worksheet and the row's `title` says so.
- **Downloading is an Explicit-permission-free action** here (the user clicked the button that
  says "Download worksheet"); no extra confirm dialog. Show a transient `Preparing…` label on the
  link while it generates, mirroring `ImportScreen`'s `exporting` state (line 600).

Owner Flag OF-4: whether the worksheet export can be scoped to a single category or stays
whole-camp is an engineering question that shapes this affordance. Recommendation: ship whole-camp
first (it exists), scope later.

---

## 6. The category list — ASCII wireframe (blocking state)

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                                                                                │
 │  !  One thing still needed before you can build a week: Activities.            │
 │     2 more items could use your attention.                                     │
 │                                                                                │
 │  ── REQUIRED ─────────────────────────────────────────────────────────────    │
 │                                                                                │
 │  ✓  Units                       6            [ Review on screen ]  Download…    │
 │  ✓  Groups                     18            [ Review on screen ]  Download…    │
 │  ✓  Days                        5            [ Review on screen ]  Download…    │
 │  ✓  Time Blocks                 8            [ Review on screen ]  Download…    │
 │  !  Activities              needed           [ Review on screen ]  Download…    │  ← brick
 │  !  Activity Rules          4 to check       [ Review on screen ]  Download…    │  ← bronze
 │                                                                                │
 │  ── OPTIONAL ─────────────────────────────────────────────────────────────    │
 │                                                                                │
 │  ·  Fixed Events            optional         [ Review on screen ]              │
 │  ·  Locations               not started      [ Review on screen ]              │
 │  ·  Staffing                not started      [ Review on screen ]              │
 │                                                                                │
 │  ── PROGRAMS ─────────────────────────────────────────────  (collapsed) ───    │
 │  ✓  Programs                    1 · Main                                        │
 │                                                                                │
 └──────────────────────────────────────────────────────────────────────────────┘
```

Ready state differs only in the headline (`✓ Ready to build a week.`) and Activities/Activity
Rules resolving to `✓` counts. The Programs group is collapsed by default (a disclosure the
director rarely needs, present for completeness) and expands on click with the same chevron
grammar as `Sidebar.jsx` (line 109–114).

---

## 7. The reconciliation-preview ledger (T75) — in S5

**Recommendation: the ledger lives in S5.** It is the "nothing is saved until you commit" surface,
and both import paths (in-app preview and workbook re-import) already funnel through one commit
(`ImportScreen`'s `runCommit`). Putting the ledger on the hub makes the hub the honest home base
ONBOARDING_UX_OPTIONS §2 describes: the director returns here, sees a staged plan, reviews it, and
commits — or leaves and nothing changed.

The ledger renders **only when a plan is staged** (`plan != null`), between the headline and the
category list. When present, the categories it touches render **In-progress** (`⋯ staged`).

### 7.1 Ledger-first, exception-expanded (ONBOARDING_UX_OPTIONS §5)

At 40–60 activities a flat per-row list is unreadable. The ledger collapses the reassuring
majority to counts and auto-expands only what needs a decision.

```
 ┌── Reviewing “Camp Willowbrook — Summer 2026 schedule.xlsx” ────────────────────────┐
 │                                                                              │
 │  ✓  46 activities unchanged                                        [ show ]  │
 │  ✓  2 updated        Basketball (min 2→3),  Hike (priority low→high)         │
 │  ──────────────────────────────────────────────────────────────────────     │
 │  !  4 need your attention — commit is held until these are resolved          │  ← bronze
 │                                                                              │
 │    ⚠ CONFLICT   Archery                                                      │
 │        where it happens   Upper Field  →  Lower Range                        │
 │                           (was, muted)     (from the file, full)             │
 │        [ Keep Upper Field ]   [ Use Lower Range ]   [ Skip ]                 │
 │                                                                              │
 │    ≟ SAME THING?   “Ropes” ≟ “Ropes Course”                     [ open card ]│
 │                                                                              │
 │    ⌫ CLEAR       Swim — how many times a week (most)   3  →  (cleared)       │
 │        This removes a value. Confirm you meant to clear it.                  │
 │        [ Clear it ]   [ Keep 3 ]                                             │
 │                                                                              │
 │  ────────────────────────────────────────────────────────────────────────   │
 │                                                                              │
 │           [ Commit 52 activities ]   (held until 4 resolved)   [ Discard ]   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 The counts ledger

Five ledger lines, each a count with a state glyph. Order: reassurance first, exceptions last, so
the eye lands on "mostly fine" before "here's the work."

| Ledger line | Glyph | Colour | Behaviour |
|---|---|---|---|
| **Unchanged** | `✓` | `var(--success)` | Collapsed to a count. `[ show ]` disclosure expands to a plain list (no diffs — nothing changed). |
| **Updated** | `✓` | `var(--success)` | Count + inline one-line summaries of the changed fields (muted→full, §7.3). Expands for the full field diff. |
| **Clear** | `⌫` | `var(--accent)` | **Firmer than an update** — its own line, its own confirm per row (§7.4). Never collapsed into Updated. |
| **New** | `+` | `var(--success)` | Count of net-new records. Collapsed to a count; expands to a list. |
| **Needs attention** | `!` | `var(--accent)` (bronze) | Conflicts + ambiguous identities. **Auto-expanded, always. Gates the commit.** |

- Counts derive from the `ReconciliationPlan` diff, a pure function → diff object recomputed
  verbatim at commit (ONBOARDING_UX_OPTIONS §10.3). The ledger renders the diff; it holds no state
  of its own beyond which collapsed sections the director has expanded.
- **Unchanged never auto-expands.** It is the reassuring majority; 46 lines of "no change" is the
  noise the ledger exists to remove.
- **Needs-attention always auto-expands and always gates commit.** The commit button is disabled
  and labelled `held until N resolved` until every attention row is answered — reuse
  `ImportScreen`'s existing gate math (`allAnswered`, `waiting` in `HeldResolution`).

### 7.3 Field-level diff — muted was / full will-be

Only **changed** fields render. The provenance grammar is the muted/full treatment already live in
`ImportScreen`:

```
 where it happens    Upper Field   →   Lower Range
                     └ muted           └ full contrast
```

- **was** value: `var(--text-secondary)`, i.e. muted. This is the current value being replaced.
- **will-be** value: `var(--text)`, full contrast — where the plan lands.
- Arrow `→`: `var(--accent)` (DESIGN_STANDARD §4 caution/attention), `12px`, `4px` horizontal
  margin each side.
- Field name: rendered in **camp language** via the existing `FIELD_LABEL` map in
  `ImportScreen.jsx` lines 51–64 (`location` → "where it happens", `max_per_week` → "how many times
  a week (most)"). Reuse that map verbatim — do not author a second one.
- **Do not** render unchanged fields. A diff that shows twelve identical rows to surface one change
  buries the change.

Note on the three-look provenance grammar (inferred=muted / confirmed=full / unknown=full+cue,
ONBOARDING_UX_OPTIONS §9): the muted/full pair used here is already established in the codebase and
is safe to use. The **third look** (unknown = full-contrast + "worth checking" cue) is a *proposed
DESIGN_STANDARD addition* and is **human-gated** — S5 must not ship the third look until the
standard is amended (Owner Flag OF-5). Until then, unknown-eligibility rows keep their existing
`ActivityRuleRow` "Worth checking" treatment and nothing new is introduced.

### 7.4 Clear rows — firmer than an update

Clearing a value is destructive in a way an update is not (ONBOARDING_UX_OPTIONS §5). So:

- Clear gets its **own ledger line** with the `⌫` glyph in `var(--accent)`, never folded into
  Updated.
- Each Clear row carries a per-row confirm: `[ Clear it ]  [ Keep N ]`, with a one-line
  explanation "This removes a value. Confirm you meant to clear it."
- The will-be value renders as `(cleared)` in `var(--text-secondary)` italic — the absence is
  stated, not left blank. (This also sidesteps the blank-vs-clear tri-state hazard
  ONBOARDING_UX_OPTIONS §7 flags for the workbook: on screen, clear is always explicit.)
- Clear rows **do not** gate commit by themselves (they have a safe default: `Keep N`), but an
  un-reviewed Clear is surfaced, never silent.

### 7.5 Conflict rows — reuse the T73 held-resolution surface

The **CONFLICT** and **SAME THING?** rows are the T73 held-import decisions
(`ImportScreen.jsx`'s `HeldResolution`, `IdentityCard`, `StaleCard`). **Reuse that surface — do
not rebuild it.** The ledger's Needs-attention section is the entry banner; expanding it (or
clicking `[ open card ]` on an identity row) drops the director into the existing focused
one-decision-at-a-time queue with its orientation rail.

- Identity rows use `≟` (not `=`) — "is this the same thing?", never an assertion (§6 of
  ONBOARDING_UX_OPTIONS; the `IdentityCard` already does this).
- The rail's glyph grammar (`✓` answered / `●` current / `○` waiting, `HeldResolution` lines
  1067–1093) is already correct and consistent with this hub's vocabulary. Keep it.
- The "Remember this" alias checkbox (confirm once, ever) stays on the identity card as spec'd in
  ONBOARDING_UX_OPTIONS §6. No change here.

### 7.6 Commit and discard

- **[ Commit N activities ]**: `S.btnPrimary` (navy). Disabled + labelled `held until N resolved`
  until every attention row is answered. On success, the ledger clears, the touched categories
  drop out of In-progress into their committed state (Ready/Needs-attention), and the headline
  recomputes. This is the **only** write; it is the existing atomic `ingestCommit`.
- **[ Discard ]**: `S.btnSecondary`, right of Commit with a gap. Discards the staged plan; nothing
  was ever written, so this is a plain reversible action, not a scary one — copy is
  "Discard" not "Delete." No confirm dialog (there is nothing to lose — the plan is a proposal).
- Leaving the hub with a staged plan is safe (nothing is written). On return, the ledger is still
  there — the plan is durable-enough-to-resume per the program's local-first model, OR it is
  renderer-state and lost on reload (matches today's `HeldResolution`, which is honestly ephemeral
  because the backend wrote nothing). Owner Flag OF-6: decide whether a staged plan survives a
  reload. Recommendation: match today's honest ephemerality for the first slice; persistence is a
  later enhancement.

---

## 8. States (every visual state)

| State | Appearance |
|---|---|
| **Loading** (counts not yet resolved) | Category rows render as skeletons per DESIGN_STANDARD §5b — skeleton fill `color-mix(in srgb, var(--text) 6%, var(--surface))`, `borderRadius: 6`, shaped to a row. **Never flash "Ready"** — a missing collection counts as empty, not satisfied (`readiness.js` lines 99–101). Headline shows a skeleton line, not a sentence, until `counts` resolve. |
| **Ready (all satisfied)** | Headline `✓ Ready to build a week.` Required rows all `✓` with counts. Line 2 present only if attention items exist. |
| **Blocking (≥1 required empty)** | Headline `!` brick + the `describeSetupGaps` sentence. The empty required rows render brick `! needed`. Red appears on at most five rows, usually one. |
| **Needs-attention only (no blocking)** | Headline is Ready; bronze `!` rows present (Activity Rules, or categories with staged inferences). Week is buildable — the copy says so. |
| **Plan staged (In-progress)** | Ledger present above the list (§7). Touched categories show `⋯ staged`. Headline unchanged (a staged plan is not itself a blocker). |
| **Row hover** | Row background lifts to `var(--bg)` (matches `Sidebar.jsx` line 177). The two-door buttons are always visible — never hover-revealed. A director who does not know a door exists will never hover to find it (the sidebar's own chevron rationale, lines 94–96). |
| **Button focus** | `2px` focus ring in `var(--primary)` per the app's established focus treatment. |
| **Empty camp (brand-new, no import yet)** | Headline `! N things still needed…`. All five required rows brick. This is the honest first-run state; it is not an error and gets no error styling. A calm one-line hint sits under the headline: "New here? **Import last year** to fill most of this in at once, or add each below." with `Import last year` as a `var(--primary)` link to the import screen. |
| **Error (a count failed to load)** | Per-row inline: the row shows `–` dimmed with mono `couldn't check` in `var(--text-secondary)` and a `retry` link (`var(--primary)`). Do **not** paint the row red — a failed *check* is not a *missing* area, and conflating them re-teaches the director to distrust red (DESIGN_STANDARD §4). |

---

## 9. Interactions

| Action | Response |
|---|---|
| Click **[ Review on screen ]** | `onNavigate(area.screen)` → the existing setup screen. No new editor. |
| Click **[ Download worksheet ]** | Existing `downloadWorkbook` flow; link shows `Preparing…` while generating. No confirm. |
| Click **Import last year** hint | `onNavigate('import')`. |
| Expand **Programs** group | Chevron rotates (same grammar as `Sidebar.jsx`), group reveals with a Settle (§10). |
| Click **[ show ]** on Unchanged ledger line | Expands the count into a plain list (no diffs). Chevron/label toggles to `[ hide ]`. |
| Expand an **Updated** ledger line | Reveals per-record field diffs (§7.3). |
| Answer a **CONFLICT / identity** row | Enters the existing `HeldResolution` queue; on answer, the rail echoes the choice and advances (existing behaviour). |
| Answer a **Clear** row (`Clear it` / `Keep N`) | Row collapses to a one-line resolved echo (`→ cleared` / `→ kept 3`) in `var(--text-secondary)`. |
| Click **Commit** | Disabled until attention rows resolved; then runs the atomic `ingestCommit`. On success the ledger clears and the hub recomputes. |
| Click **Discard** | Clears the staged plan; hub returns to no-ledger state. |

---

## 10. Animation

All motion uses DESIGN_STANDARD §8 tokens. No bounce, no elastic. Every animation ships a
`@media (prefers-reduced-motion: reduce)` fallback (crossfade or instant).

| Moment | Type | Trigger | Values |
|---|---|---|---|
| Hub mount | **Fade + Lift** | Screen first renders | opacity 0→1, translateY 8px→0, `--motion-base` (220ms) `--ease-out`. No per-row stagger — the list is data, not a reveal show. |
| Skeleton → real row | **Crossfade** | `counts` resolve | opacity crossfade, `--motion-base`. Never slide a row into place — its position is meaningful. Skeleton shimmer: `1200ms linear infinite`, static under reduced-motion (§5b). |
| Glyph state change (e.g. `!`→`✓` after a commit) | **Fade** | State recompute | The glyph and status text crossfade over `--motion-fast` (140ms). **Do not** animate colour transitions on the glyph — a brick→green tween would pass through muddy intermediates; crossfade the whole glyph span instead. |
| Ledger appears (plan staged) | **Fade + Settle** | `plan` becomes non-null | opacity 0→1, translateY 12px→0, `--motion-settle` (340ms) `--ease-out`. A large new region earns the longer settle. |
| Ledger section expand/collapse (Unchanged `[ show ]`, Updated diff) | **Settle** (max-height) | Disclosure click | animate `max-height` + opacity, `--motion-settle` `--ease-out`. This matches the existing merge-card collapse. Reduced-motion: instant. |
| Attention row resolved → collapses to echo | **Slide + Fade** | Answer given | translateY -4px→0 on the echo, opacity, `--motion-base`. Reuses `HeldResolution`'s existing `importCardIn` feel. |
| Commit success → ledger clears | **Fade out** | Commit resolves | ledger fades `--motion-base`, then the recomputed headline Fade+Lifts in. Sequential, not simultaneous, so the director sees "the plan went in, and here is where we stand now." |
| Programs group expand | **Settle** (max-height) | Chevron click | `--motion-settle`, same as any disclosure. |

Only animate `opacity`, `transform`, and `max-height`/`clip` (DESIGN_STANDARD §8). Never animate
layout or colour except the established merge-card transition.

---

## 11. Owner flags — product/UX choices that genuinely need the owner

| # | Flag | Why it needs the owner | Designer recommendation |
|---|---|---|---|
| **OF-1** | **Hub replaces the `tiers` landing screen.** | Changes the first thing every director sees on every launch, including returning directors whose camp is already set up. | Replace, and add a top `readiness` nav row. For a set-up camp the hub is a calm "all ready" home; for a new one it is the honest starting point. High confidence — but it is a visible product change, so it is the owner's call. |
| **OF-2** | **Does the sidebar rollup surface In-progress (`⋯`)?** | SETUP_READINESS §4 says the two new glyphs should reflect back into the sidebar. But the sidebar rollup is a *compressed* glance; adding a fourth tone may crowd it. | Reflect `–` (Not-applicable) into the sidebar, but keep `⋯` (In-progress) hub-only for the first slice — a staged plan is a hub activity, and the sidebar's `done/total` already tells the blocking truth. Revisit if directors miss it. Medium confidence. |
| **OF-3** | **The Locations/Staffing "not-applicable" toggle.** | Rendering `– not used` requires the director to declare "single-site" / "no staff" somewhere. That control does not exist. | Ship S5 with both as Optional (`·`). Add the not-applicable toggle when the Locations/Staffing slices land. Do not block S5 on it. |
| **OF-4** | **Can the worksheet export be scoped to one category?** | Shapes whether `[ Download worksheet ]` is per-row honest or whole-camp. Engineering-dependent. | Whole-camp first (it exists); scope later. Row `title` states the scope so the affordance is never misleading. |
| **OF-5** | **The three-look provenance grammar (unknown = full+cue) is a DESIGN_STANDARD change.** | ONBOARDING_UX_OPTIONS §9 marks it human-gated; the standard outranks the code. | Ship S5's ledger with the existing muted/full pair only. Do **not** introduce the third look until the standard is amended. This spec assumes the two-look pair throughout. |
| **OF-6** | **Does a staged plan survive a reload?** | Determines whether the ledger is durable or honestly-ephemeral like today's `HeldResolution`. | Match today's ephemerality for the first slice (the backend wrote nothing, so losing a staged plan loses no data). Persistence is a clean later enhancement. |

---

## 12. Decision-artifacts to prototype (ranked)

Per ONBOARDING_UX_OPTIONS §8, prototype in this order. These are the HTML mockups that become part
of Maker's brief:

1. **The ledger at 52 activities** (§7) — ledger-first, exception-expanded, with real-scale counts
   (46 unchanged / 2 updated / 4 attention). This is the artifact most likely to reveal a density
   problem; build it first, with realistic camp data, not lorem counts.
2. **The readiness hub, three states side by side** — Ready, Blocking (one brick row), and
   Needs-attention-only. The point of the prototype is to confirm brick reads as a *different
   emotion* from bronze at a glance, and that red stays scarce.
3. **A single CategoryRow, all six states stacked** — to lock the glyph + word + colour grammar and
   the two-door affordance weight (button vs link).
4. **The field-diff micro-component** (muted was → full will-be) reusing `FIELD_LABEL` camp
   language, including a Clear row.

Prototypes are visual references, not production code. They may use plain HTML/CSS with the
`DESIGN_STANDARD` §9 token values inlined.

---

## 13. Implementation notes for Maker

- **Reuse, do not rebuild.** The state vocabulary is `Sidebar.jsx`'s `MARK_COLOR` + two extensions;
  the conflict/identity resolution is `ImportScreen.jsx`'s `HeldResolution` / `IdentityCard` /
  `StaleCard`; the field labels are `ImportScreen`'s `FIELD_LABEL`; the worksheet export is
  `downloadWorkbook`; the commit is `ingestCommit` via `runCommit`. S5 is a new *screen* composed
  of existing parts, plus the ledger shell.
- **Do not touch `getSetupGaps` or `REQUIRED_AREAS`.** The six-state layer reads *from*
  `getSetupGaps` and wraps it; it never replaces the binary blocking-truth core (SETUP_READINESS
  §9, invariant 1–2). Deriving per-category state is a pure function over `counts` + `plan`; keep it
  out of the component so it is testable without React (mirror `sidebarState.js`'s split).
- **The headline sentence is not authored in the component.** Line 1 is
  `describeSetupGaps(getSetupGaps(counts))` verbatim. If that sentence needs to change, that is a
  `readiness.js` change with its own review — not a hub concern.
- **Red is scarce by construction.** Only the five required areas can render brick. Enforce this in
  the state-deriving function (Activity Rules/Fixed Events/Locations/Staffing/Programs have no code
  path to `--danger`), and add a test asserting no non-required category ever yields the Missing
  state. This is the load-bearing guarantee of §3; make it a test, not a convention.
- **The ledger holds no domain state.** It renders the `ReconciliationPlan` diff (a pure function →
  diff object) and owns only view state (which collapsed sections are open). The commit recomputes
  the diff verbatim (ONBOARDING_UX_OPTIONS invariant 3). Do not cache the diff across the commit.
- **Skeletons, never a spinner, and never a premature "Ready."** Until `counts` resolve, the
  headline and rows are skeletons (§5b). A flashed "Ready to build a week" on a camp that is still
  loading is the most damaging way to be wrong (`readiness.js` lines 99–101).
- **Two new glyphs are `–` (U+2013 en-dash) and `⋯` (U+22EF horizontal ellipsis).** Not a hyphen,
  not three periods — the exact codepoints keep the fixed-width column aligned.
- **No CSS class file.** Per the Designer constitution, everything here is inline React style
  objects referencing `var(--token)`. The scheduleGrid CSS exception does not apply — the hub is
  not under `src/components/schedule/`.
```
