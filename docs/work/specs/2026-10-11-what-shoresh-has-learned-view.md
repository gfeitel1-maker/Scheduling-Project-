---
title: "What Shoresh has learned" view and import review-card labels - design spec
document_type: spec
status: draft
created: 2026-10-11
archive_when: PR 2 of the answer-memory ADR is merged and Verifier PASS recorded
governing_docs: [docs/adr/2026-10-11-import-answer-memory.md, docs/governance/standards/DESIGN_STANDARD.md]
---

# DESIGN SPEC - "What Shoresh has learned" view and review-card labels

For PR 2 of the accepted ADR `docs/adr/2026-10-11-import-answer-memory.md` (read 3.3 to 3.7).
Designed for a non-technical camp director who knows schedules, not software. Every colour, type
and motion value cites a token from `DESIGN_STANDARD.md`; nothing here restates a hex. All styles are
inline React style objects (`var(--token)`). No new stylesheet: this view and these cards are outside
`src/components/schedule/`, so the `scheduleGrid.css` exception does not apply.

Hard rules applied throughout (owner standing rules and ADR 3.7):
- **No banners.** Status is shown as a small inline **flag** (defined in 0.2) on the row it describes. The one quiet permission line (4.4) is plain secondary text, not a box.
- **No disabled coming-soon controls.** A control a viewer may not use is **not rendered**. A control that is unavailable because the thing is not ready (for example Keep this answer on a row that does not need it) is also not rendered.
- **Every write failure is surfaced** on the row that failed, with a retry (0.4).
- Personality: Professional. Grounded. Warm. Quiet. Precise. Never playful. Motion explains; it never entertains.

---

## 0. Shared primitives (used by both the view and the cards)

### 0.1 Vocabulary (the words the director sees)

The director never sees "pattern", "evidence", "qkind", "NEAR", "SUGGEST" or "ESTABLISHED". Mapping:

| Internal | Director word |
|---|---|
| Tier 0 instance record | "answer" (a remembered answer) |
| Tier 1 pattern | "habit" in headings is avoided; use **"pattern"** only in the verbs "Remember as a pattern" / "Forget this pattern", which the ADR already fixes. Otherwise say "Shoresh has learned that ..." |
| ESTABLISHED | **"Applies automatically"** (eligible kinds) / **"Pre-selects for you"** (non-eligible kinds) |
| SUGGEST | **"Suggested"** |
| ASK | **"Still asks"** |
| NEAR / baseline mismatch | **"Similar to an earlier answer"** |
| `asRecorded` | **"as recorded"** (kept: ADR 3.2 and 3.5 fix this phrase) |
| `looks_right` evidence | **"You confirmed"** |

Confidence is **words plus counts, never a percentage** (ADR 3.4): "Suggested - 2 agree" / "Applies automatically - 3 agree, 5 earlier disagreed".

### 0.2 The flag (replaces every banner)

A flag is a small inline marker, never a full-width block.
- Shape: `display:inline-flex; alignItems:center; gap:4; padding:'1px 7px'; borderRadius:999; fontSize:11; fontWeight:600; lineHeight:'16px'; fontFamily:var(--font-sans)`; text colour is tone-ink, fill is tone at 10% over `var(--surface)` via `color-mix`, hairline `1px` tone at 35% over `var(--border)`. Same `color-mix` family as `S.cautionBanner`/`S.errorBanner`, scaled down to a pill. Route all flags through one local `flagStyle(tone)` const at the bottom of the file (and the card file imports it from the same module: one definition).
- Tones (semantic, from DESIGN_STANDARD 4):
  - `neutral` - `var(--text-secondary)` ink, `var(--text)` 6% fill. For "as recorded", "this computer only".
  - `caution` - `var(--accent)` bronze (ink `color-mix(in srgb, var(--accent) 65%, var(--text))`, the `S.cautionBanner` text mix). For "Your camp changed since you answered", "Always asks you".
  - `success` - `var(--success)`. For "Applies automatically" and "Remembered".
  - `primary` - `var(--primary)` navy. For "Suggested".
  - `danger` - `var(--danger)`. Only for a failed write on that row (0.4). Never for learning state.
- A flag carries text always; colour is never the only channel. Outline icon (12px, `stroke-width:1.5`) optional and only for success (check) and danger (alert).

### 0.3 Async control feedback (ADR 3.7 "Design standards": immediate pressed state, inline pending, result on the row)

Applies to Change, Forget this answer, Forget this pattern, Keep this answer, Remember as a pattern, Undo for this import.

1. **Pressed** (0 ms, on `pointerdown`/`:active` via a local `pressed` state or `onMouseDown`): `transform: scale(0.97)`, transition `transform var(--motion-fast) var(--ease-out)`. Press feedback 140 ms.
2. **Pending** (from click until the call resolves): the control's label swaps in place to a present-participle with a trailing ellipsis and `fontWeight` steps from 500 to 600; the control gets `aria-busy="true"`, `cursor:'wait'`, `pointerEvents:'none'`. Labels: "Forgetting...", "Saving...", "Keeping...", "Remembering...", "Undoing...". No spinner (quiet), no layout shift: the button has a `minWidth` equal to its longest label. Control and its row siblings stay readable.
3. **Result on the row**, not in a toast:
   - Success: the row's own state text changes (for example "Forgotten" - see 2.5) for the confirmation window, using a **Fade** of the changed text (`opacity 0 to 1`, `--motion-fast`).
   - Failure: see 0.4.
4. Reduced motion (`prefers-reduced-motion: reduce`): the pressed scale is dropped; feedback is **the text and weight change on the same element, never no feedback** (ADR). Pending label swap, weight step and `aria-busy` still occur. The fade becomes instant.

### 0.4 Write failure (every mutation surfaces failures)

On rejection or a `{ok:false}` result the control returns to its idle label, the row gains a **danger flag** directly under the row's title line: `alert icon + "Couldn't save that. <plain reason>. Try again"` where "Try again" is a link-button (`var(--primary)`, underline offset 2) that re-fires the same action. The row stays in its prior (unchanged) data state: nothing is optimistically removed. The flag stays until the next attempt or the view reloads. Reason copy (never raw errors):
- permission lost mid-session: "You no longer have permission to change imports."
- stale (record already superseded on another device): "Someone else changed this just now. Showing the latest." (the row re-renders from `liveRecords()`; no retry link, because retry would act on stale data).
- any other: "Something went wrong saving that. Nothing was changed."
Motion: **Slide + Fade** per DESIGN_STANDARD 5c (translateY -4px to 0, opacity 0 to 1, `--motion-base`), resolve fades out `--motion-fast`. Reduced motion: opacity only.

### 0.5 Buttons and type

- Text actions on rows are **quiet link-buttons**: `border:'none'; background:'none'; padding:'4px 6px'; fontFamily:'inherit'; fontSize:12; fontWeight:500; color:'var(--primary)'; cursor:'pointer'; borderRadius:6`. Hover (`@media (hover:hover)` equivalent: use `onMouseEnter` state, `pointer: fine` only): background `color-mix(in srgb, var(--primary) 8%, transparent)`, `--motion-fast`. Focus-visible: 2px `var(--primary)` outline, offset 2.
- **Forget** actions are the same shape but `color: var(--danger)` (destructive role) and sit last in the row. Forget never happens in one blind click for a **pattern** (see 3.3) but is a single click for one answer (cheap and recoverable by answering again).
- Section label: `S.sectionLabel`-style (`--font-condensed` 700 13px uppercase 0.05em); counts via `S.sectionCount`. Screen title `--font-condensed` 22px 700 `var(--text)` (match other view screens' title via TopBar `TITLES`).
- Body text 13px `var(--text)`; meta text 12px `var(--text-secondary)`; example/why text 12px `var(--text-secondary)`; numbers `fontVariantNumeric:'tabular-nums'`.
- Touch targets stay >= 32px tall on rows; the layout is desktop-first (Electron), min usable width 760px.

---

## 1. Sidebar footer entry

**Placement.** Directly under `{role === 'admin' && <RestoreControl />}` (`src/components/layout/Sidebar.jsx`, ~line 477) and above the "About & Legal" button. **Ungated** (no `role` check): staff and directors both see it. Own label, own destination key `learned`, `onNavigate('learned')`.

**Copy.** Label: **"What Shoresh has learned"**. No count badge, no dot: the footer stays quiet. (A numeric badge would invite attention to something that never needs action.)

**Style.** Copy the About button's style object exactly so the footer reads as one family: `display:'block', width:'100%', textAlign:'left', padding:'4px 0 0', border:'none', background:'none', fontFamily:'inherit', fontSize:11, cursor:'pointer'`, colour `current === 'learned' ? 'var(--text)' : 'var(--text-secondary)'`. The About button's `padding:'4px 0 0'` then becomes consistent spacing between the two (both 4px top). No icon (the footer links are text-only).

**States.** Default: secondary text. Hover (`pointer:fine`): `color: var(--text)`, `--motion-fast`. Active (pressed): `transform: scale(0.97)`, `--motion-fast`. Focus-visible: 2px primary outline. Current screen: `var(--text)` plus `fontWeight:600`. No disabled state exists (it is always available).

**Motion.** None on the entry beyond hover colour. Screen change itself follows whatever `App.jsx` does for screens today (no new transition invented here).

**Blast radius reminder for Maker (ADR 3.7).** New `SCREENS` key `learned` fans out to ~5 enumerator and guard files (`screenKeys.js`, `TopBar` `TITLES`, `screenDestinationsExist.test.js`, ...). Only the full `npm run verify` finds them all. TopBar title: **"What Shoresh has learned"**. The back control, if the screen has one, uses `S.backBar` ("Back"); other footer-only screens (`about`, `pairAgain`) are the model.

---

## 2. The view: layout

Component: `src/screens/LearnedScreen.jsx` (+ small row components in the same folder). Scrollable page, `padding: 24px 28px`, content column `maxWidth: 880`, centred left-aligned (match `AboutScreen`).

```
+--------------------------------------------------------------------------+
| What Shoresh has learned                                                 |
| Shoresh remembers the answers you give during an import, and spots       |
| patterns after three similar answers. Nothing here changes a schedule    |
| you've already imported.                                                 |
|                                                                          |
| (viewer without groups.import only:)                                     |
| You can see what Shoresh has learned. Changing it needs import           |
| permission.                                                              |
|                                                                          |
| (only when count > 0:)                                                   |
| [!as recorded] 3 answers are from people who no longer import.          |
|                                                                          |
| (only past 15 rows:)  [ Search answers and examples...      ] [All kinds v]
|                                                                          |
| CLASSIFICATION  (12)                                              [v]    |
|  - PATTERNS                                                              |
|  | Lunch 1 to 3 are fixed events        [Applies automatically]          |
|  | Why: You answered "Fixed event" for Lunch 1, Lunch 2 and Lunch 3      |
|  |      (Dana 3 Jul, you 12 Oct).                                        |
|  | Progress: 3 of 3 answers - from 2 imports - 1 you edited.             |
|  | Confidence: 3 agree, 5 earlier disagreed.                             |
|  | Answered by Dana and you - last 12 Oct        Change  Forget pattern  |
|  - ANSWERS                                                               |
|  | Lunch 4 is a fixed event             [Remembered]                     |
|  | Why: You answered "Fixed event" on 12 Oct.                            |
|  | Answered by you on 12 Oct                     Change  Forget answer   |
|  Show 25 more                                                            |
|                                                                          |
| ALL CAMP EXCEPT...  (4)                                           [v]    |
| VALUES  (9)                                                       [v]    |
| SPLITS AND MERGES  (3)                                            [v]    |
| ELECTIVES AND OTHER  (6)                                          [v]    |
|                                                                          |
| REMEMBERED ON THIS COMPUTER ONLY  (5)                             [v]    |
| ...                                                                      |
+--------------------------------------------------------------------------+
```

### 2.1 Header block

- Title: TopBar title carries "What Shoresh has learned"; the page itself opens with the explainer paragraph (no duplicated H1): 13px `var(--text-secondary)`, `maxWidth: 62ch`, `marginBottom: 16`.
- Explainer copy: **"Shoresh remembers the answers you give during an import and re-uses them next time. After three similar answers it starts to spot patterns. Nothing here changes a schedule you have already imported."**
- Permission line (viewers without `groups.import`), directly under the paragraph, same style, `marginTop: -8, marginBottom: 16`: **"You can see what Shoresh has learned. Changing it needs import permission."** (ADR-fixed copy.) Plain text, not boxed.

### 2.2 Groups and rows

Groups, in this order, each a collapsible section (header = `S.sectionLabel` + `S.sectionCount` + chevron, one `<button>` with `aria-expanded`, `aria-controls`):

1. **Classification** (kind `classify`)
2. **All camp except...** (`exclusion`)
3. **Values** (value confirmations: `value`, `drift_ack`)
4. **Splits and merges** (`split`, `merge`)
5. **Other** (`residue`, anything else)
6. Then, separated by `marginTop: 28` and a hairline `border-top: 1px solid var(--border)`: **Remembered on this computer only** (2.7).

Empty groups are not rendered (no zero-count headers).

Within a group: sub-heading **"Patterns"** first (only if any), then **"Answers"**. Sub-headings: 11px 600 uppercase `var(--text-secondary)` `0.05em`, `margin:'12px 0 6px'`. Patterns that do not exist in a group simply leave out the "Patterns" sub-heading.

Default open state: group **open** if it holds a pattern or the total rows <= 15; otherwise open only the group the viewer last used (per-viewer `localStorage`, wrapped in try/catch, per the `setupReviewed.js` pattern; missing means all open). Rows per group: first **25**, then a link-button **"Show 25 more"** (appends; no pagination). Count in header always shows the full count.

**Row anatomy** (a `<li>` in a `<ul>`, `borderBottom: 1px solid var(--border)`, `padding: '12px 0'`, no card, no shadow; the page is calm paper):

```
Line 1  [title 14px/600 --text]                         [state flag]
Line 2  Why: <sentence from the examples, 12px secondary>
Line 3  Progress: <progress line>              (patterns only; see 3)
Line 4  <confidence>   (patterns only; words + counts)
Line 5  Answered by <who> on <date>   [as recorded?]   [row actions, right-aligned]
```

- Title is the plain-language "what" ("Lunch 1 to 3 are fixed events", "Boys' Cabin Day is all camp except CIT", "Swim Test: 'looks right' kept as written"). Written by the same explanation function as the card (single source, ADR 3.4 "Explanation"), never re-spelled in the view.
- **Why** is the ADR explanation sentence: up to 3 example names then "and N more"; dates short ("3 Jul"), "you" for the viewer.
- **Who and when** line: `Answered by Dana on 3 Jul`; `Answered by you on 12 Oct`; for a pattern with several authors: `Answered by Dana and you, latest 12 Oct`. Author from `users` by `confirmed_by`; absent user shows **"a former user"** and gets the `as recorded` neutral flag (ADR 3.5). A non-qualifying author (no longer holds `groups.import`) also shows `as recorded`.
- State flag (right of title): `Remembered` (success, answers), `Applies automatically` (success, patterns), `Pre-selects for you` (primary, established but non-eligible kind), `Suggested` (primary, 2 agree), `Still asks` (neutral, ASK; a pattern in ASK stays visible so the director sees why), `as recorded` (neutral; additive, sits beside the state flag).
- Camp changed flag: if `camp_shape` differs from `last_shown_shape` (per-viewer localStorage, ADR 3.5) show a caution flag **"Your camp changed since you answered"** and expand its group.
- Row action area, right-aligned on Line 5, wraps under on narrow widths: `Change` (primary link), `Keep this answer` (only for `as recorded` due to a former importer, 2.6), then `Forget answer` / `Forget this pattern` (danger link). **Exact label per row kind:** answers get **"Forget answer"**, patterns get **"Forget this pattern"**. Viewers without `groups.import`: **the whole action area is not rendered** (not greyed). Row height reflows; nothing is disabled.
- Hover: row background `color-mix(in srgb, var(--text) 3%, transparent)`, `--motion-fast`, `pointer: fine` only. This is a quiet scan aid, not a click target (rows are not clickable as a whole).

### 2.3 Why a pattern row shows its supporting answers

Patterns have a disclosure **"Show the N answers behind this"** (link-button, secondary colour, chevron). Expanded, it lists the supporting answers as compact indented rows (Line 1 + Line 5 only, no actions: they are managed in their own "Answers" list). Collapsed by default. Expand/collapse = **Accordion / Collapse** (see 6).

### 2.4 Search and filter (only past 15 rows)

Total rows (all groups, excluding the device-local section) **> 15** shows a single row above the groups:
- Search input: `S.input`-style, placeholder **"Search answers and examples"**, matches title, why text and example names (ADR 3.7). Clear control (x) appears when non-empty. Debounce 120 ms; results filter in place.
- Kind filter: native `<select>` styled like other setup selects, options: "All kinds", then the five group names, then "Remembered on this computer only". 
- Both hidden entirely at 15 rows or fewer. When a filter yields nothing: calm line **"Nothing matches 'x'."** + link-button **"Clear search"**. Filtering never unmounts the filter row (no focus loss while typing).
- Search mode forces all matching groups open and shows all matches (no "Show 25 more" while searching).

### 2.5 After Forget / Change (result on the row)

- **Forget answer** succeeded: the row's title gets strikethrough-free treatment (we do not strike text), the flag becomes neutral **"Forgotten"**, Line 2 changes to **"Shoresh will ask this question again."**, the action area is replaced by one link-button **"Undo"** for **8 seconds** (re-writes the same answer through the same Change path; see 3.4), then the row **collapses out** (Accordion/Collapse) and the group count decrements. Reduced motion: no collapse animation; row simply leaves after the same time, count updates.
- **Forget this pattern** succeeded: flag becomes **"Pattern forgotten"**, Line 2 **"Your earlier answers are kept. New similar questions will ask you again."**, row moves to "Answers" list implicitly (the pattern row leaves; the supporting answers were already listed). No Undo (a veto is the deliberate action; the director can rebuild by answering three more times) - see 3.3 for the confirm step instead.
- **Change** saved: flag fades to **"Updated"** for 4 seconds then returns to the recomputed state flag.

### 2.6 Answers from people who no longer import

- A single plain sentence under the explainer (not a banner): flag `as recorded` + text **"N answers are from people who no longer import."** Singular: **"1 answer is from a person who no longer imports."** Shown only when N > 0.
- Rows affected carry the `as recorded` flag and, for `groups.import` viewers only, a **"Keep this answer"** link-button (primary) as the first action. Tooltip (`title` and an `aria-describedby` hint) text: **"Re-record this under your name so Shoresh can count it. The answer doesn't change."** Pending label "Keeping...", result flag "Kept under your name" then the `as recorded` flag leaves. Patterns supported by such answers list the same action once per pattern ("Keep these N answers").
- If the viewer lacks `groups.import`: the count line and the flags still show; the action is not rendered.

### 2.7 "Remembered on this computer only" (read-only)

The five legacy device-local stores (compound-cell, declined two-row splits, location "not a place", mapping aliases kept locally, and the older setup/consent remembered choices as inventoried in the ADR). They are not synced and are forgotten if this computer is replaced.
- Header: **"Remembered on this computer only"** + count. Subtext (12px secondary): **"These older answers live on this computer and don't sync to other devices. They're listed so you can see them; they can't be changed here."**
- Rows: Line 1 title, Line 2 where it applies ("Used when a cell reads 'Lunch + Leave'"), flag `This computer only` (neutral). **No Change, no Forget, no actions of any kind, no disabled buttons.** No "who" line if unknown; no confidence line.
- Collapsed by default, count in header. If empty, the section is not rendered.

### 2.8 Empty state (DESIGN_STANDARD 5a)

Only when there are no remembered answers at all and no device-local items: centred block `padding: 60px 16px`, no card, no border, no shadow. Outline icon ~40px, `stroke-width:1.5`, `var(--text-secondary)` (a simple "memo with a check" glyph; outline only, no cartoon). Title `--font-condensed` 600 15px `var(--text)`: **"Nothing learned yet"**. Body 13px `var(--text-secondary)`, one line: **"When you answer an import question, Shoresh remembers it here, and starts to spot patterns after three similar answers."** (ADR copy, kept verbatim.) No CTA (nothing to do here; no "Go to Import" button, to avoid a dead-end nag). Motion: Fade + Lift, translateY 8px to 0, opacity 0 to 1, `--motion-base`, `--ease-out`; reduced motion: opacity only.

### 2.9 Loading and error for the screen

- Loading (first read): skeleton rows per DESIGN_STANDARD 5b (`color-mix(in srgb, var(--text) 6%, var(--surface))`, `borderRadius:6`), three row-shaped blocks, shimmer `1200ms linear infinite`, static under reduced motion. Fade in `--motion-fast`.
- Read failure: DESIGN_STANDARD 5c recoverable inline error (danger-tinted bar, alert icon, **"Couldn't load what Shoresh has learned. Check this device is still signed in."** + link-button **"Try again"**). This is the standard's recoverable inline error pattern, not a banner on learning state.
- Diagnostics footer (ADR 3.2): if the diagnostics tally is nonzero show one quiet line at the very bottom, 11px secondary: **"N remembered answers couldn't be read on this device and were skipped."** Hidden when zero.

---

## 3. Progress toward auto-apply

Computed by the same recall code as the tiers (ADR 3.7), exposed as one object per pattern row: `{ agree, needed: 3, imports, importsNeeded: 2, hasExplicit, eligible, missing: [...] }`. The view only formats; it never recounts.

### 3.1 The progress line (patterns only; answers have none)

Format: **"<Progress meter> <N> of 3 answers"** followed by the missing conditions as a comma-joined sentence.

- Meter: 3 small segments (6px circles in a row, `gap:4`, `margin-right:8`), filled = `var(--primary)`, unfilled = `var(--border)` with a 1px `var(--text-secondary)` 30% ring. Not colour alone: the text "2 of 3 answers" is always present. A 4th+ agreeing answer shows 3 filled. No animation on the dots on load; when a count increases while the screen is open they fill with a **Fade** (`--motion-fast`).
- Text: 12px `var(--text)` for "2 of 3 answers", then secondary for the missing parts.
- **Missing-condition copy** (only those that apply, in this order, joined by " - "):
  - fewer than 3 distinct instances: handled by the count itself ("1 of 3 answers"); no extra text.
  - needs a second import: **"needs one more import"** (singular always; the bar is 2 imports).
  - needs an explicit answer: **"needs one answer you edited or declined"**. (ADR 3.4 wording preserved.)
  - baseline mismatch caps it: **"capped at Suggested because the new question is a different shape (for example a weekly event instead of a daily one)"** shown only on a decision row/card (4.2), not in the view.
  - newest answer disagrees (demoted): **"your latest answer disagrees - needs 2 more agreeing answers to suggest again"**.
- Established & eligible: **"3 of 3 answers - Shoresh now applies this on its own, and tells you each time."**
- Established & non-eligible: see 3.2.

Examples (verbatim, for the Maker's fixtures):

| State | Progress line |
|---|---|
| 1 example | "1 of 3 answers" |
| 2 agree, one import | "2 of 3 answers - needs one more import" |
| 3 agree, 2 imports, no explicit | "3 of 3 answers - needs one answer you edited or declined" |
| 2 of 3, one import, no explicit | "2 of 3 answers - needs one more import, needs one answer you edited or declined" |
| Established, eligible | "3 of 3 answers - Shoresh applies this on its own, and tells you each time" |
| Demoted | "Your latest answer disagrees - 2 more agreeing answers to suggest again" |

### 3.2 Kinds that never auto-apply

Per the authority registry (`AUTO_APPLY_ELIGIBLE`; ADR 3.4): all-camp-except, electives, any rejection/decline/"Not an event", and every kind not allow-listed.
- Replace the progress line with a **caution** flag + sentence: flag **"Always asks you"**; sentence **"Always asks you: this kind only pre-selects."** (ADR-fixed wording; verbatim.)
- Keep a counted line below it so growth is still visible: **"2 of 3 answers agree - once established it pre-selects the answer, and you still confirm."** Meter shown as usual (it still tracks agreement) but the flag text "Pre-selects for you" replaces "Applies automatically" when established.
- Tooltip / `title` on the flag, plain reason: **"Only you know whether this group had a trip, so Shoresh never decides it for you."** For rejections: **"Shoresh only ever applies answers that say yes. It never decides to leave something out."**

### 3.3 Forget a pattern vs Forget an answer (the difference, stated in the UI)

| | **Forget answer** | **Forget this pattern** |
|---|---|---|
| Label | "Forget answer" | "Forget this pattern" |
| Click behaviour | Single click, no confirm, inline "Undo" for 8 s | Inline two-step confirm (below) |
| What happens | That exact question asks again next import; any patterns it supported are recomputed (may drop a level); nothing already imported changes | The pattern stops pre-selecting/applying; **your individual answers are kept** and still answer their exact questions; only three **new** matching answers rebuild it |
| Row result | "Forgotten" + "Shoresh will ask this question again." | "Pattern forgotten" + "Your earlier answers are kept. New similar questions will ask you again." |

**Pattern confirm (inline, no modal).** Clicking "Forget this pattern" replaces the action area with a single plain line + two buttons, in place (same height): **"Stop using this pattern? Your N answers behind it stay."** `[Forget pattern]` (danger link-button, label "Forget pattern") `[Keep pattern]` (primary link-button). Focus moves to "Keep pattern" (the safe option). Esc cancels. Motion: **Crossfade** of the action area, `--motion-fast`; reduced motion instant. This is not a banner and not a dialog.

Row-level helper line under the label, 11px secondary, visible only in the confirm state: **"Forgetting one answer only affects that question."** (so the director understands the difference at the moment of choosing).

### 3.4 Change

"Change" opens the **same editor used on the review card** (ADR 3.7 "Change: the same editor as the card"). For a row that is an answer or pattern with a binary choice: an inline **segmented control** replaces Line 2/3 content: the available answers as `S.chip`-style options (selected = filled primary, others surface); below it `[Save]` (primary, `S.btnPrimary`-small) and `[Cancel]`. Save is the only control that writes. Pending/failed/success per 0.3 and 0.4. For value-type answers needing a typed value, the same input the card uses. Saving a different answer on a pattern row writes a superseding record (agreement or contradiction, per ADR) - no extra copy needed except the success flag "Updated". Esc closes without saving. Disclosure animation: **Accordion/Collapse** of the editor strip (6).

---

## 4. Review cards in the import

Locations: `src/components/reconciliation/reconciliationCards.jsx`, `RootMapPanel.jsx`, and the summary line in `ReconciliationScreen.jsx`. Cards keep their current structure, border and layout; this spec **adds** one memory strip and states. Do not restyle the card shell.

### 4.1 Recalled card (exact match, applied): "Remembered from <who>'s answer on <date>"

A **memory strip** is the first thing inside the card body, above the existing question. 12px, one line, `var(--text-secondary)`, with a small outline "memory" glyph (12px, `stroke-width 1.5`) and the success-tone `Remembered` flag.

- Copy (ADR 3.5): **"Remembered from your answer on 12 Oct"** / **"Remembered from Dana's answer on 12 Oct"** / **"Remembered from a former user's answer on 12 Oct"** / non-qualifying: **"Remembered from Dana's answer on 12 Oct (as recorded)"** with the neutral `as recorded` flag, and such a card is never pre-answered (it is NEAR-only, so the strip belongs to the Similar state in 4.2).
- Right of the strip: two link-buttons **"Change"** and **"Forget"** (quiet, 12px; Forget danger-coloured). Visible only to viewers with `groups.import` (not rendered otherwise; the strip text still shows).
  - **Change**: focuses the card's own answer controls (they are already on the card) and removes the "answered" look: the card returns to unanswered/open, strip text becomes **"You're changing a remembered answer"**. Saving writes a record whose `overrode` = the recalled ids (ADR 3.5); no extra confirm.
  - **Forget**: removes the memory for this question going forward and returns this card to unanswered **for this import**. Copy shown inline after press: **"Forgotten. Shoresh will ask this every time from now on."** Same pending/failure treatment as 0.3 and 0.4 (the strip is the "row").
- The card's answered state remains visually the existing answered state (checked/selected chip); the strip is the only new element. Hover and focus on the strip: none (it is information).
- Exact-recall seeded answers count in the per-import summary "N answers remembered - review" (4.3).
- If the strip's camp-changed condition holds (`camp_shape` differs from `last_shown_shape`): add caution flag **"Your camp changed since you answered"** to the right of the strip text, and expand the Remembered group (4.3).

### 4.2 Pre-selected (Suggested / Similar) state with its reason

For NEAR, SUGGEST and capped ESTABLISHED: the card is **pre-selected but still asks**. Visual: the suggested answer chip shows a "selected" look but with a **dashed 1px primary outline** and the label **"Suggested"** (primary flag) directly above the chips, so it cannot be mistaken for something the director chose. Never the green/applied look. The director must click once to confirm (clicking the chosen chip confirms; clicking the other chip changes).

- **Reason line** (12px secondary, under the flag, `maxWidth 60ch`), from the ADR explanation sentence, three forms:
  - Pattern (SUGGEST): **"You answered Fixed event for Lunch 1 and Lunch 2. Lunch 4 looks like the same kind of thing."**
  - Established pre-select (non-eligible): **"You answered Fixed event for Lunch 1, Lunch 2 and Lunch 3. Lunch 4 is the same kind of thing. Pre-selected, but you always confirm this kind."**
  - Near (baseline mismatch): **"Similar to your answer on 12 Oct, but something is different: <what>. Check it still applies."** where <what> is the named baseline dimension in plain words ("this group now also attends", "the stored value has changed", "it runs weekly, not daily"). Never expose the raw baseline name.
  - Capped ESTABLISHED: add **"Shoresh didn't apply this on its own because this is a different shape from your earlier answers."**
- **"Remember as a pattern"** (offered on SUGGEST/NEAR cards, ADR 3.4/3.5): a quiet link-button below the chips: label **"Remember as a pattern"**; helper (11px, secondary): **"Next time, similar questions will be pre-selected for you."** Written as evidence by default on a plain confirm; this tap is the explicit write, **default off**. After tap: flag changes to **"Pattern remembered"** (success). Only rendered for `groups.import` holders. Not rendered on kinds with no template.
- **"Remember this"** (NEAR cards, ADR 3.5 "Remember this", default off): a separate small checkbox-style option **"Also remember this for next time"** under the chips, unchecked. Keep these two controls distinct: "Remember as a pattern" (generalises) vs "Also remember this" (this one question). If the card is NEAR via `name_key`, only "Also remember this" appears.
- Motion on appearance: the Suggested flag and reason line use **Fade** (`--motion-fast`); no movement of the card.

### 4.3 Per-import summary: "N answers remembered - review" and "Auto-applied: N"

Placed on the review screen at the top of the list as **one line** (not a banner: no fill, no border, no icon background), 13px, two inline items separated by a spaced middle dot, `marginBottom: 12`:

```
12 answers remembered - review      Auto-applied: 4 - Undo for this import
```

- **"N answers remembered - review"**: a link-button (primary) that toggles the **Remembered group** (collapsed by default, ADR 3.5). Singular **"1 answer remembered - review"**. When 0, the whole item is not rendered. Opening the group lists those cards (strip 4.1) in normal card style under a small group header **"Remembered answers (N)"**.
- Cards whose `camp_shape` differs from `last_shown_shape` are expanded automatically with the caution flag; the group header then reads **"Remembered answers (N) - 2 need a look"** and defaults open.
- **"Auto-applied: N"**: plain text with `fontVariantNumeric:'tabular-nums'`; **"Undo for this import"** is a link-button right after it. Rendered only if N > 0 **and** the import has not yet been committed. After commit this item is removed and replaced by nothing (the existing grace-window "Undo this import" owns that; do not duplicate it).
  - Press: pending label **"Undoing..."** (0.3). On success, the line becomes **"Auto-applied: 0 - these questions are back for you to answer"** for 5 s, then the "Auto-applied" item disappears; the returned cards animate from applied-look to open (4.4). On failure, 0.4.
  - Helper copy on hover/focus (`title` and a visible 11px line beneath for the first-ever auto-apply in a camp, per ADR "first auto-application ... shown expanded"): **"Undoing only affects this import. Shoresh keeps the pattern."**
- First auto-application in the camp: the line is accompanied once by an expanded group listing each auto-applied card with the strip "Applied automatically because you answered Fixed event for Lunch 1, Lunch 2 and Lunch 3." (the 4.2 reason in past tense) so the director sees *why* before committing. Not shown again after the first commit.
- No auto-applied card appears in a different visual weight from other answered cards beyond the strip; there is no green wash.

### 4.4 Returning cards to unanswered (Undo for this import)

When Undo runs, the affected cards transition from the answered look to the open look: the answered chip loses its filled state (Fade, `--motion-base`), the memory strip is replaced by **"Back to unanswered for this import."** (12px secondary) for the rest of the session. The card does not slide or reorder (spatial consistency). These cards are in the session suppression set (ADR 3.5) and will not re-apply on re-render.

### 4.5 "Not an event, treat as an activity" on fixed-event cards

Appears only on `confirm_value` cards for `fixed_events` (including the low-confidence / partial confidence cards in the ADR inventory row 8).

- Label: **"Not an event, treat as an activity"**.
- Placement: a secondary control in the card's action row, to the right of the existing answer chips ("Looks right" / edit), never the primary: link-button (primary colour, 12px). The existing primary answers remain visually dominant.
- Helper (11px secondary, below, always visible, one line): **"Choose this if it's a regular activity, not something that blocks the schedule."**
- Behaviour on press: pressed and pending per 0.3 (label "Saving..."), then the card resolves in the existing resolved style with a neutral flag **"Treated as an activity"**. The memory strip appears on later imports as a recalled rejection-type answer; note this answer **never auto-applies** (rejections only pre-select, ADR 3.4). So the strip on a later recall reads **"Remembered from your answer on 12 Oct"** + pre-selected, with the Suggested look (4.2), not an applied look.
- Undo: the standard resolved-card edit path (clicking the answer chip again) reverts it; no special undo.
- Permission: rendered only for `groups.import` (every import-answering role has it). If somehow absent, not rendered.
- Failure: 0.4 on the card.

---

## 5. Microcopy table (every state)

| Where / state | Copy |
|---|---|
| Sidebar link | What Shoresh has learned |
| TopBar title | What Shoresh has learned |
| Explainer | Shoresh remembers the answers you give during an import and re-uses them next time. After three similar answers it starts to spot patterns. Nothing here changes a schedule you have already imported. |
| Read-only line | You can see what Shoresh has learned. Changing it needs import permission. |
| Former importers | N answers are from people who no longer import. / 1 answer is from a person who no longer imports. |
| Keep action | Keep this answer (hint: Re-record this under your name so Shoresh can count it. The answer doesn't change.) |
| Keep pending / done | Keeping... / Kept under your name |
| Empty title | Nothing learned yet |
| Empty body | When you answer an import question, Shoresh remembers it here, and starts to spot patterns after three similar answers. |
| Search placeholder | Search answers and examples |
| No search result | Nothing matches "x". / Clear search |
| Kind filter | All kinds |
| Group headers | Classification, All camp except..., Values, Splits and merges, Other, Remembered on this computer only |
| Sub-headers | Patterns, Answers |
| Show more | Show 25 more |
| Pattern disclosure | Show the N answers behind this / Hide the N answers |
| Device-local subtext | These older answers live on this computer and don't sync to other devices. They're listed so you can see them; they can't be changed here. |
| Device-local flag | This computer only |
| Flags | Remembered - Applies automatically - Pre-selects for you - Suggested - Still asks - Always asks you - as recorded - Your camp changed since you answered - Forgotten - Pattern forgotten - Updated - Pattern remembered - Treated as an activity |
| Never auto-apply | Always asks you: this kind only pre-selects. |
| Never-apply reason (exclusion/electives) | Only you know whether this group had a trip, so Shoresh never decides it for you. |
| Never-apply reason (rejection) | Shoresh only ever applies answers that say yes. It never decides to leave something out. |
| Forget answer result | Forgotten. Shoresh will ask this question again. |
| Forget pattern confirm | Stop using this pattern? Your N answers behind it stay. [Forget pattern] [Keep pattern] |
| Forget pattern result | Pattern forgotten. Your earlier answers are kept. New similar questions will ask you again. |
| Forget difference helper | Forgetting one answer only affects that question. |
| Undo (answer) | Undo (8 s window) |
| Card strip | Remembered from your answer on 12 Oct / Remembered from Dana's answer on 12 Oct / Remembered from a former user's answer on 12 Oct |
| Card strip, changing | You're changing a remembered answer |
| Card forget done | Forgotten. Shoresh will ask this every time from now on. |
| Suggested flag | Suggested |
| Near reason | Similar to your answer on 12 Oct, but something is different: <what>. Check it still applies. |
| Pattern reason | You answered Fixed event for Lunch 1 and Lunch 2. Lunch 4 looks like the same kind of thing. |
| Remember as a pattern | Remember as a pattern (helper: Next time, similar questions will be pre-selected for you.) |
| Remember this | Also remember this for next time |
| Summary | N answers remembered - review / 1 answer remembered - review |
| Remembered group header | Remembered answers (N) [ - M need a look ] |
| Auto-applied line | Auto-applied: N - Undo for this import |
| Undo helper | Undoing only affects this import. Shoresh keeps the pattern. |
| Undo pending / done | Undoing... / Auto-applied: 0 - these questions are back for you to answer |
| Returned card | Back to unanswered for this import. |
| Not an event | Not an event, treat as an activity (helper: Choose this if it's a regular activity, not something that blocks the schedule.) |
| Load error | Couldn't load what Shoresh has learned. Check this device is still signed in. / Try again |
| Write error: stale | Someone else changed this just now. Showing the latest. |
| Write error: permission | You no longer have permission to change imports. |
| Write error: generic | Something went wrong saving that. Nothing was changed. / Try again |
| Diagnostics footer | N remembered answers couldn't be read on this device and were skipped. |

Tone rules: second person ("you answered"), no jargon, no exclamation marks, no emoji, no "Oops". Dates are short ("12 Oct"); the current viewer is "you"; others by first name only.

---

## 6. Animation notes (DESIGN_STANDARD 8; no bounce, no elastic, distances 4 to 12 px)

Vocabulary: Fade, Lift, Slide, Settle exactly as defined in the standard. All transitions use CSS `transition` on `opacity`, `transform`, and `max-height` only (interruptible; not keyframes), `var(--ease-out)`. Animate nothing on keyboard-driven repeated actions (arrow navigation inside lists, Tab).

| Moment | Trigger | Type | Duration / ease | Notes |
|---|---|---|---|---|
| Screen mount | enter `learned` | Fade + Lift (translateY 8px to 0, opacity 0 to 1) | `--motion-base` 220ms, `--ease-out` | One block, no stagger; reduced motion: opacity only |
| Empty state | mount | Fade + Lift | `--motion-base` | Per 5a |
| Loading | first read | Skeleton, Fade-in | `--motion-fast` 140ms; shimmer 1200ms linear infinite | Static blocks under reduced motion |
| Group expand/collapse | click header | **Accordion / Collapse**: `max-height` + opacity | `--motion-settle` 340ms, `--ease-out` | Content measured via ref `scrollHeight`; set `overflow:hidden`; chevron rotates 90deg over `--motion-base` (rotation is an indicator, not motion for its own sake). Reduced motion: instant, chevron swap |
| "Show the N answers behind this" | click | Accordion / Collapse | `--motion-base` 220ms | Smaller panel, shorter |
| Change editor open | click Change | Accordion / Collapse on the editor strip | `--motion-base` | Reduced motion: instant |
| Press feedback (all link-buttons) | `:active` | Press: `scale(0.97)` | `--motion-fast` | Never scale text-only footer entries; those get colour only |
| Async pending | click | Label swap + weight 500 to 600 + `aria-busy` | instant swap | Reduced motion: same (text/weight is already the fallback) |
| Result flag appear | success/failure | Fade; failure uses Slide + Fade (translateY -4px to 0) | `--motion-fast` / `--motion-base` | Reduced motion: opacity only |
| Row leaves after Forget | 8 s after success | Accordion / Collapse (row `max-height` to 0 + opacity) | `--motion-settle` | Count in group header updates on collapse start; reduced motion: instant |
| Forget-pattern confirm | click Forget this pattern | Crossfade of action area | `--motion-fast` | Same height, no layout shift |
| Progress dot fills | count increases while visible | Fade | `--motion-fast` | On first render, dots are static |
| Review card: strip appearance | cards render | none (static) | | Static; the card is the focus |
| Undo for this import | click | Answered look to open look: Fade on chip fill and strip text swap | `--motion-base` | No card movement |
| Remembered group expand (review) | click "N answers remembered - review" | Accordion / Collapse | `--motion-settle` | Same as view groups |
| Suggested flag/reason | card renders | Fade | `--motion-fast` | |

`@media (prefers-reduced-motion: reduce)` fallback is mandatory and specified per row above; the shared pattern is: drop transforms and `max-height` animation, keep opacity (or instant), and keep every text/weight/state change so feedback never disappears. Implement via the existing `useEnterTransition('slideFade', {})` hook where the standard fits (it already handles reduced motion) rather than a new hook; the accordion needs a small local `useCollapse` helper in the screen folder honouring `matchMedia('(prefers-reduced-motion: reduce)')`.

---

## 7. States checklist (view)

| Element | Default | Hover (pointer:fine) | Active | Focus-visible | Pending | Success | Error | Disabled |
|---|---|---|---|---|---|---|---|---|
| Sidebar entry | secondary text | `--text` | scale .97 | 2px primary outline | n/a | n/a | n/a | never rendered disabled |
| Group header | label + count + chevron | row bg 3% | colour only | outline | n/a | n/a | n/a | n/a |
| Change | primary link | bg 8% primary | scale .97 | outline | "Saving..." | "Updated" flag | danger flag + Try again | **not rendered** without groups.import |
| Forget answer | danger link | bg 8% danger | scale .97 | outline | "Forgetting..." | "Forgotten" + Undo 8 s | danger flag + Try again | **not rendered** without groups.import |
| Forget this pattern | danger link, then inline confirm | same | same | same | "Forgetting..." | "Pattern forgotten" | danger flag + Try again | **not rendered** without groups.import |
| Keep this answer | primary link | bg 8% | scale .97 | outline | "Keeping..." | "Kept under your name" | danger flag + Try again | **not rendered** unless former-importer row and viewer has groups.import |
| Search / filter | input + select | border to `--text-secondary` | n/a | 2px primary | n/a | n/a | n/a | **not rendered** at <= 15 rows |
| Row (read-only) | static | bg 3% | n/a | n/a | n/a | n/a | n/a | n/a |

---

## 8. Prototype

No HTML mockup is produced: the layouts above are fully specified by the ASCII diagrams, the token citations and the copy table, and this spec ships in the same worktree as the backend build. If the owner wants a visual before the Maker starts (owner standing preference: "show me the running UI"), the cheapest route is `npm run dev` with the `src/localClient.mock.js` mock (add mock data for `listImportAnswers`/`matchImportAnswers`); the first Maker slice should be the view with mock rows so the owner sees it, not just reads this.

---

## 9. Implementation notes for Maker

1. **Single source of text.** The row title, the "why" sentence, the confidence words and the progress line come from the explanation/progress objects returned by the recall code (`src/ingest/answerPatterns.js`; ADR 3.4 and 3.7). The view and the review card must call the same formatter; do not recount or re-word in JSX. A guard test: the card strip and the view row for the same record produce identical title and why strings.
2. **Permission-gating.** View = `import_answers.read` (everyone signed in). Controls = `groups.import`. Gate by **not rendering**; never `disabled`. The quiet permission line shows only when the viewer lacks `groups.import`. Test: a staff role without `groups.import` renders zero Change/Forget/Keep controls and the permission line.
3. **Do not read `camp_seedlings` directly** in any view code: only through the `liveRecords()`-backed IPC (ADR 3.2, guard test). Device-local legacy stores come from their existing IPCs; the section has no write calls at all.
4. **`as recorded`, `a former user`**: derived by the backend payload (`asRecorded`, `answeredBy`); the view displays them and never infers.
5. **Flags, not banners.** One `flagStyle(tone)` definition, shared with the review cards. Do not use `S.cautionBanner` / `S.errorBanner` for these (those are block banners); only borrow their `color-mix` recipes. The load-error bar in 2.9 is the standard's 5c recoverable error and is the single exception because it is a system error, not learning state.
6. **No new CSS file.** Hover and active states via `onMouseEnter/Leave` and `onMouseDown/Up` local state, as `RestoreControl.jsx` and the footer buttons do; gate hover with a `matchMedia('(hover: hover) and (pointer: fine)')` check once at module level (try/catch).
7. **localStorage keys** (per viewer, per device, try/catch around every read and write; render correctly without it): `learned.groups.open` (last-used open groups) and the existing `last_shown_shape` pattern from `src/utils/setupReviewed.js`. Do not store anything that must be shared.
8. **8-second Undo after Forget answer** re-writes the same answer through the Change path (a new record, fresh id, `supersedes` the retired one), exactly like any Change; do not add an "un-supersede" IPC. After the window the row is removed from the DOM; the retired record is already gone from `liveRecords()`.
9. **Keyboard.** All row actions reachable by Tab; Enter/Space activates. Pattern confirm moves focus to "Keep pattern"; Esc cancels. Group header buttons toggle with Enter/Space; `aria-expanded` kept in sync. The Remembered group on the review screen is a `<button aria-expanded>` too. Pending states set `aria-busy` and announce via a visually hidden `aria-live="polite"` region at the page root ("Forgotten. Shoresh will ask this question again.").
10. **Mocks.** `src/localClient.mock.js` needs mock handlers for the new IPCs so `npm run dev` shows populated, empty, error and former-user states (including a >15-row dataset, which exercises search/filter).
11. **Visual verification expected** from the Tester/Verifier: screenshots (CDP `Page.captureScreenshot`, not shell `screencapture`) of: populated, empty, >15 rows with search, former-importer flag + Keep, forget-pattern confirm, a recalled card strip, a Suggested card, the per-import summary line, and a "Not an event" card. Each must contain a distinguishing frame (the Suggested dashed outline vs the Remembered strip), not merely "a screen rendered".
12. **Open copy for the owner** (no blocker): "Applies automatically" vs a plainer "Applies on its own"; keep the former unless the owner prefers the latter. Recommend "Applies automatically" (medium confidence; both fit the quiet tone).
13. **Dependencies on the ADR open questions** (Q3: extra attending group is NEAR; Q5: mirror legacy five stores into the document, S4): if Q5 is later accepted, the "Remembered on this computer only" section shrinks and each moved row gains the normal actions; nothing in this layout needs to change.
