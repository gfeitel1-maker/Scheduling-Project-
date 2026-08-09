---
title: "T73 — Held-Import Conflict Resolution (Design Spec)"
document_type: design-spec
status: draft
created: 2026-08-08
author: designer
governing_docs:
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/governance/constitution/CONSTITUTION.md
related_adrs:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
related_docs:
  - docs/work/onboarding-reconciliation/ONBOARDING_UX_OPTIONS.md
  - docs/work/onboarding-reconciliation/SETUP_READINESS.md
ticket: docs/work/tickets/T73-held-conflict-resolution-ui.md
program: onboarding-reconciliation
archive_when: T73 ships and the held-conflict resolution surface is implemented in ImportScreen
---

# DESIGN SPEC — Held-Import Conflict Resolution

This spec extends **`src/screens/ImportScreen.jsx`** — it does not introduce a new screen. The
resolution experience lives inside the same screen the director already used to open the file, so a
held import is the *same task continuing*, not a new place they were sent.

**Design DNA it inherits (do not re-derive):** the tick-chip vocabulary (success-green selected,
struck-through unselected), the bordered advisory blocks (`--accent` for recoverable/attention,
`--danger` for terminal), the `borderLeft: 3px solid var(--…)` status bars, `S.btnPrimary` /
`S.btnSecondary`, the `press-97` class, `S.errorBanner`, the muted-vs-full text-color grammar already
in `ActivityRuleRow`, and the camp-plain voice of every existing sentence on the screen ("Nothing is
added until you have looked at the list and said so."). Everything below is built out of these, not
alongside them.

**Personality anchor (DESIGN_STANDARD §1):** Professional. Grounded. Warm. Quiet. Precise. Never
playful. A held import is a moment of mild anxiety for a director — the machinery must read as *calm
and in control*, never alarmed. Red is reserved; bronze carries "I need you here."

---

## 0. The two questions, in camp language

The whole surface exists to ask a director exactly two kinds of question. Everything is subordinate to
getting these two right. Backend reasons in parentheses are **never shown**.

1. **"Is this the same thing?"** (`ambiguous_identity`) — the file says `Art`, and your camp already
   has *two* things that could be it (`Art` and `art `), or one that is close but not exact. Shoresh
   will not guess which. → the **Confirm-identity card**.

2. **"You changed this by hand — the file disagrees. Keep yours, or take the file's?"** (`stale`) — the
   file would overwrite a value the director typed themselves. → the **Kept-change card**.

**Banned vocabulary anywhere the director can see it:** op, entity, conflict, conflict reason,
provenance, stale, ambiguous, identity (as a noun), plan, commit (as a noun), record (verb),
source, field (use the thing's name — "location", "how often"), merge, reconcile.

---

## 1. Entry state — how a held import announces itself

Today `commit()` sets `result` on success and renders a green-barred success card. The backend now can
return **`{ held: true, conflicts: [...] }`** instead. This is **not an error and must not use
`S.errorBanner`** — nothing went wrong, and nothing was damaged (the whole import wrote nothing). It is
a *pause*, rendered in `--accent` bronze, the caution/attention hue (DESIGN_STANDARD §4).

### 1.1 Component structure

In `ImportScreen`, add a `held` state object alongside `result`:

```
held = { conflicts: [...], approvedContext: {…the params that were submitted…} }
```

When `held` is set, the screen renders the **HeldEntry banner** in place of the success card, and — on
the director's action — swaps the preview body for the **Resolution surface** (§2–§4). The file-picker
card stays visible and disabled-looking above; the director is mid-task on *this* file.

### 1.2 HeldEntry banner — copy and layout

Bronze left-bar card, same geometry as the existing `result` card (`borderRadius: 8`,
`padding: '12px 14px'`, `fontSize: 13`, `lineHeight: 1.6`), `borderLeft: 3px solid var(--accent)`,
`background: color-mix(in srgb, var(--accent) 6%, var(--surface))`.

```
 ┌ (bronze bar) ─────────────────────────────────────────────────┐
 │  Almost there — your import is ready except for 3 items        │
 │  I need you on.                                                │
 │                                                                │
 │  Nothing has been added or changed yet. Once you've answered   │
 │  these 3, the whole import goes in together.                   │
 │                                                                │
 │      [ Review the 3 items ]        [ Not now ]                 │
 └────────────────────────────────────────────────────────────────┘
```

**Copy rules for the headline (this is the emotional load-bearing line):**
- Lead with reassurance and progress ("Almost there", "ready except for").
- **Count the handful, never the problem.** "3 items I need you on" — never "3 conflicts", "3 problems",
  "3 errors".
- **State the safety fact plainly:** "Nothing has been added or changed yet." A held import that wrote
  nothing is the *reassuring* truth; say it, because a director's first fear is that a half-import
  broke their camp.
- **Name the payoff:** "the whole import goes in together" — this is the honest face of hold-the-whole
  atomicity, phrased as a benefit (all-or-nothing = tidy), not a constraint.
- Singular/plural throughout (`1 item I need you on`).

**Buttons:**
- `[ Review the N items ]` — `S.btnPrimary` (navy). Enters the Resolution surface (§2).
- `[ Not now ]` — `S.btnSecondary`. Dismisses to the untouched pre-import state. See §5.3 (leaving) for
  the honest consequence copy — because nothing was written, "Not now" means *start this import over
  later*, and the button must not pretend the work is saved.

### 1.3 States of the banner

| State | Trigger | Rendering |
|---|---|---|
| **Held (default)** | commit returns `{held:true}` | Bronze banner as above. |
| **Entering** | click `Review the N items` | Banner collapses (Settle, §6); Resolution surface fades in. |
| **All resolved** | every item answered in the queue | Banner is gone; replaced by the Finish card (§4.2). |

---

## 2. The Resolution surface — one queue, one decision at a time

### 2.1 The core layout decision: focused card + orientation rail

**Recommendation (confidence: high).** Show **one decision at a time** as a single focused card, with a
**slim orientation rail** above it listing all the items and their state. Not a long scroll of all
cards; not a bare one-at-a-time with no sense of the whole.

*Why not a flat list of all cards:* an identity question and a kept-change question are different
shapes and each deserves the director's whole attention; stacked, they become the "50 lines of noise"
the ledger-first preview (`ONBOARDING_UX_OPTIONS.md` §5) exists to avoid. *Why not bare one-at-a-time:*
a director dropped into a lone card with no map feels trapped and can't tell if they're near done. The
rail gives orientation (the map); the card gives focus (the work). This mirrors the ledger-first
principle — the reassuring whole is always in view, the exception is expanded.

```
 ┌───────────────────────────────────────────────────────────────┐
 │  A few things to sort out before this import goes in           │  ← header
 │  You're on 1 of 3.                                             │
 │                                                                │
 │  ● Is “Art” the same as before?        ← now                   │  ← rail
 │  ○ Is “Ropes” the same as before?                              │
 │  ○ Swim’s location changed                                     │
 │  ───────────────────────────────────────────────────────────  │
 │                                                                │
 │   ┌── the focused card for the current item (§3) ──────────┐   │
 │   │                                                        │   │
 │   │   … Confirm-identity card  OR  Kept-change card …      │   │
 │   │                                                        │   │
 │   └────────────────────────────────────────────────────────┘  │
 │                                                                │
 │  ───────────────────────────────────────────────────────────  │
 │  Nothing goes in until all 3 are answered.   [ Finish import ] │  ← footer (§4)
 │                                              (waiting on 2)     │
 └───────────────────────────────────────────────────────────────┘
```

### 2.2 The rail — item rows

Each row = glyph + one plain-language question + state. Reuse the sidebar glyph discipline
(SETUP_READINESS §4): **glyph + word + colour together, colour never the sole carrier.**

| Row state | Glyph | Colour | Text treatment |
|---|---|---|---|
| **Answered** | `✓` | `--success` | full `--text`, a quiet trailing summary of the choice (e.g. "→ kept your location") |
| **Now (current)** | `●` | `--accent` | full `--text`, bold-600, trailing "← now" |
| **Waiting** | `○` | `--text-secondary` | `--text-secondary` |

Rows are **clickable** — a director may jump back to an answered item to change their mind, or skip
ahead. Clicking sets that item as *current*. (No drag, no reorder.) Answered items are re-openable, not
locked; the footer gate (§4) is what enforces completeness, not row-locking.

### 2.3 Ordering

Sort the queue **most-fundamental-first**, stable:

1. **Identity questions** (`ambiguous_identity`) before **kept-change questions** (`stale`). Rationale:
   an identity answer decides *which thing we're even talking about*; it reads as more foundational to a
   director and clears the "who is this?" fog before "what changed?" questions. Both are equally blocking
   under hold-the-whole, so this is a comprehension order, not a dependency order.
2. Within each kind, **group by the thing's name** in the order it appears in the import list
   (Units, Groups, Days, Time Blocks, Activities — the existing `INGESTIBLE_ENTITIES` order), so a
   director who knows their setup screens sees a familiar sequence.

Ordering is computed once when the queue opens and **does not resort as items are answered** — a list
that reshuffles under the director's hand is disorienting. Answered rows stay in place, checked.

### 2.4 How resolved items "drop off"

They do **not** vanish from the rail — they flip to the `✓ answered` state in place (§2.2), carrying a
one-line echo of the choice. What "drops off" is the *focus*: on answering the current card, the surface
auto-advances the focused card to the **next still-`○`-waiting** item (Settle transition, §6). When the
last waiting item is answered, the focused card is replaced by the **Finish card** (§4.2) and the rail
shows all `✓`.

Progress is honest and always visible in two places: the header ("You're on 1 of 3") and the footer gate
("waiting on 2"). Prefer "**answered / total**" framing over a percentage — SETUP_READINESS §3 rejects
progress-bar dishonesty and this surface inherits that rule.

---

## 3. The two decision cards

Both cards sit inside the focused slot, on `--surface-elevated` (white, the lifted-surface token,
DESIGN_STANDARD §2) with `1px solid var(--border)`, `borderRadius: 10`, `padding: 16px 18px`. They read
as *lifted above* the surrounding surface because they are the one thing to act on.

### 3.1 Confirm-identity card (`ambiguous_identity`)

Refines the card already drawn in `ONBOARDING_UX_OPTIONS.md` §6. Two named things **side by side**,
joined by **`≟` (not `=`)**, each with **its evidence**, three **equal-weight** choices, **no auto-pick,
no pre-selection**.

**The one-vs-many shape.** The backend may hand back *more than one* existing candidate (the
`"Art"` / `"art "` case — `evidence.candidates` is a set). The card must handle both:

**(a) One incoming label, one near-miss existing thing** — the canonical side-by-side:

```
 ┌── Is this the same thing? ──────────────────────────────────────┐
 │                                                                 │
 │   In your camp            ≟            In this file             │
 │   ─────────────                       ─────────────            │
 │   Art                                  Art                      │
 │   used 3× last year                   shows up 5×              │
 │   Unit: Seniors                       Upper Field              │
 │                                                                 │
 │   ┌───────────────────────────┐  ┌───────────────────────────┐ │
 │   │  Same thing               │  │  A different, new one     │ │
 │   │  Use my existing “Art”    │  │  Add “Art” as new         │ │
 │   └───────────────────────────┘  └───────────────────────────┘ │
 │                    ┌───────────────────────────┐               │
 │                    │  Skip this for now        │               │
 │                    └───────────────────────────┘               │
 └─────────────────────────────────────────────────────────────────┘
```

**(b) One incoming label, several existing candidates** — the `"Art"` / `"art "` ambiguity. Stack the
candidates as a chooser; "add new" and "skip" remain peers below:

```
 ┌── Which one is this? ───────────────────────────────────────────┐
 │                                                                 │
 │   In this file:  “Art”  — shows up 5×, Upper Field              │
 │                                                                 │
 │   You already have two things this could be. Which is it?      │
 │                                                                 │
 │   ○  Art        used 3× last year · Unit: Seniors              │
 │   ○  art        used 1× last year · Unit: Juniors             │
 │                                                                 │
 │   ┌───────────────────────┐   ┌───────────────────────────┐    │
 │   │  Add “Art” as new     │   │  Skip this for now        │    │
 │   └───────────────────────┘   └───────────────────────────┘    │
 └─────────────────────────────────────────────────────────────────┘
```

**Evidence lines (camp language, from the conflict's `evidence`):**
- Existing side: "used N× last year" (from the live row's seen-count / prior data), and the unit it
  sits under if known ("Unit: Seniors"). If a fact is unknown, **omit the line** — do not print "Unit:
  unknown" (SETUP_READINESS: absence must not masquerade as data).
- File side: "shows up N×" and any location/context the source carried ("Upper Field"). Same omit rule.

**Choice semantics (what each hands back):**
| Choice | Director-facing label | What it resolves to |
|---|---|---|
| Same thing | "Use my existing *Name*" | Map the incoming label to that existing thing (its `entity_id`); no new thing created. In case (b), enabled only once a candidate radio is picked. |
| Different, new one | "Add *Name* as new" | Create a new thing from the incoming label. |
| Skip for now | "Skip this for now" | Drop this one item from the import; everything else still goes in. |

**Equal weight, no default.** All three are the same visual weight — bordered buttons, `1px solid
var(--border)`, `--surface` fill, `--text` label, no navy-filled "primary". Nothing is pre-picked. The
card is *unanswered* until the director clicks. This is the `≟`-not-`=` principle made physical: Shoresh
is asking, not proposing.

**Selected state:** the chosen button gets `border: 1.5px solid var(--primary)`,
`background: color-mix(in srgb, var(--primary) 8%, var(--surface))`, and a leading `●` — matching the
keep-vs-replace selector already in `ImportScreen` (lines 566–586). In case (b), the candidate radios use
the same on-treatment.

**"Remember this" — DEFERRED, see §7.1.** The `ONBOARDING_UX_OPTIONS.md` §6 card carries a "Remember
this — treat 'Art' as 'Art' next time" checkbox. That writes a `source_alias`, which is **S1b and not
yet built**. **Do not render the checkbox in T73.** Ship the card without it; §7.1 flags the follow-up.

### 3.2 Kept-change card (`stale`)

The director hand-edited a value; the file would overwrite it. Question: **"Keep yours, or use the
file's?"** Default is **keep yours** (the safe, non-destructive answer). The card must make plain that
keeping yours means **the file's value is not applied** — no silent third outcome.

```
 ┌── You changed this by hand ─────────────────────────────────────┐
 │                                                                 │
 │   Swim — where it happens                                      │
 │                                                                 │
 │   You set this to     Lower Pool         ← the value you typed  │
 │   The file says       Upper Pool         (muted)               │
 │                                                                 │
 │   ┌─────────────────────────────┐  ┌──────────────────────────┐ │
 │   │  ● Keep mine (Lower Pool)   │  │  Use the file’s          │ │
 │   │    The file’s value won’t   │  │  (Upper Pool)            │ │
 │   │    be applied.              │  │  Replace what I typed.   │ │
 │   └─────────────────────────────┘  └──────────────────────────┘ │
 └─────────────────────────────────────────────────────────────────┘
```

**The diff, and the deliberate inversion of the muted/full grammar here.** In the ledger preview
(`ONBOARDING_UX_OPTIONS.md` §5) the muted value is the *old/was* and the full-contrast value is the
*incoming/will-be*, because there the file is winning. **In the stale card the default is the
opposite** — the director's value *wins by default* — so the **director's value is full-contrast** and
the **file's value is muted**. The contrast follows *what will actually happen*, not a fixed
old-vs-new rule. When the director flips to "Use the file's", the emphasis swaps (see selected states).
This is the honest application of "contrast = the value that will take effect", and it is consistent
with `ActivityRuleRow`'s existing rule that a value the director owns renders full `--text` while an
inferred value renders muted `--text-secondary`.

- **"You set this to"** row: `Lower Pool` in full `--text`, weight 600.
- **"The file says"** row: `Upper Pool` in muted `--text-secondary`.
- Labels ("You set this to" / "The file says") in `--text-secondary`, 12px.
- Between them, **no accent arrow** — this is a *contest*, not a flow (unlike the preview's `→`). Two
  labelled rows, not an arrow diff, precisely because we are not asserting the change will happen.

**Field name in camp language.** The card titles the field by the thing + a plain name for the field —
"Swim — where it happens", not "swim.location". Maker needs a **field-label map** (below); never show
the raw column name.

**Choice semantics:**
| Choice | Label | Resolves to |
|---|---|---|
| Keep mine (default, pre-selected) | "Keep mine (*value*)" + "The file's value won't be applied." | Drop this field update. The director's value stays; nothing is written for this field. |
| Use the file's | "Use the file's (*value*)" + "Replace what I typed." | Accept the import value → routes through the **`stale_accept: true`** path so the field is written `source:'import'` (ADR S2b §3a — this is what makes the acceptance stick and stops it re-asking every future import). |

**Keep-mine is pre-selected** (leading `●`, navy-tinted) because it is the safe, reversible-by-inaction
choice and matches the director's likely intent (they typed that value on purpose). This is the **one
card that ships with a default**, and it is deliberate: unlike the identity question (a genuine "I don't
know, you tell me"), the stale question has a safe answer the system can stand behind. The director can
still flip it. An item with keep-mine pre-selected **still counts as answered** for the gate the moment
the director has *seen* it — see §4.1 for how "seen the safe default" vs "must actively choose" is
handled.

**Selected states:**
- *Keep mine selected:* keep-mine button navy-tinted + `●`; the director's value stays full-contrast, the
  file's value muted.
- *Use-the-file's selected:* use-the-file's button navy-tinted + `●`; **the emphasis swaps** — the
  file's value becomes full `--text` 600 and the director's value goes muted with a subtle strike
  (`textDecoration: line-through`, `--text-secondary`), visually saying "this is being replaced". The
  strike reuses the unselected-chip grammar already on the screen, repurposed truthfully: the struck
  value is the one being dropped.

---

## 4. The commit gate — hold-the-whole made visible

### 4.1 What "answered" means (and the one product nuance)

Hold-the-whole (ADR S1a §2, S2b §3): **nothing commits until every held item is resolved.** The footer
gate enforces exactly this.

- An **identity** item is *answered* only by an explicit click (no default). Until clicked it is `○`.
- A **kept-change** item ships with keep-mine pre-selected. **Recommendation (confidence: medium):**
  treat a kept-change item as *answered as soon as the director has opened it* — i.e. it has been the
  focused card at least once — so the safe default doesn't force a pointless click, but the director is
  never allowed to finish the import having *never looked* at a hand-edit the file wanted to change.
  This preserves the ADR's core promise ("a hand-edit is never silently overwritten") without nagging.
  **Flag for owner (§7.2):** the alternative is to require an explicit click on every stale item too.

The footer button is disabled until answered-count === total.

### 4.2 The footer, and the Finish card

**Footer (always visible while resolving):**

```
 ─────────────────────────────────────────────────────────────────
 Nothing goes in until all 3 are answered.     [ Finish import ]
                                               (waiting on 2)
```

- Left: the honest gate sentence, `--text-secondary`, 12–13px. Updates live: "waiting on 2" →
  "waiting on 1" → gone.
- Button `[ Finish import ]` is `S.btnPrimary`, **disabled** (`opacity: 0.45`, as the existing commit
  button does) until all answered. Disabled label may read the same; the "(waiting on N)" subline
  carries the *why*, so the button never lies about being clickable-but-inert without explanation.

**When all are answered**, the focused-card slot shows the **Finish card** — a quiet green-forward
summary, echoing the existing success-card geometry but *pre-commit*:

```
 ┌ (green bar) ───────────────────────────────────────────────────┐
 │  All sorted. Here’s what will go in:                           │
 │                                                                 │
 │   ✓  46 activities and setup items, unchanged                  │
 │   ✓  “Art” — using your existing one                           │
 │   ✓  “Ropes” — added as new                                    │
 │   ✓  Swim’s location — kept yours (Lower Pool)                 │
 │                                                                 │
 │             [ Finish import — add 48 items ]                    │
 └─────────────────────────────────────────────────────────────────┘
```

- Left-bar `--success`, `background: color-mix(in srgb, var(--success) 6%, var(--surface))`.
- Each line is a plain echo of a decision, `✓` in `--success`. Skipped items appear too, honestly:
  "*Name* — skipped, not added" in `--text-secondary`.
- Final button label **counts the outcome**: "Finish import — add N items", matching the existing
  screen's "Add N records" / "Replace with N records" convention (lines 678–683), but in camp words
  ("items", not "records" — note: consider aligning the *existing* button to "items" too; minor, §7.3).
- On click → re-commit with the resolutions applied. Backend re-runs the same atomic commit; on success,
  the normal green `result` card (already built) renders. The resolution surface is torn down.

### 4.3 What happens if the re-commit itself holds again

Edge case: the director resolves everything, clicks Finish, and a *peer device* changed something in the
window so the re-commit produces a **new** held item. Handle it honestly, not as an error:

- The new held item(s) re-enter the queue; the surface shows a bronze inline note at the top:
  "One more came up while you were working — someone else made a change. Just this one to go." Then the
  queue continues. Do **not** throw the director back to square one or show `S.errorBanner`; the earlier
  resolutions are preserved in state and re-submitted with the new one.
- This reuses the same queue; only the note is new. (Rare, but hold-the-whole + concurrent peers makes
  it reachable — ADR S1a §2, S2b §2 R6.)

---

## 5. Leaving mid-resolution

### 5.1 The honest fact

The backend wrote **nothing** (hold-the-whole). The held conflicts and the director's in-progress
answers live in **renderer state only**. If the director navigates away or closes, that state is lost
and the import must be **re-opened from the file** and re-resolved.

### 5.2 Recommendation

**Do not silently persist partial resolutions for T73** (confidence: medium). Persisting a half-resolved
held plan is real scope (where does it live? how does it survive a peer changing the world underneath
it?) and belongs to the Needs-Attention-queue / hub slice, not this thin renderer surface. Instead:

- Leaving is **allowed and safe** — nothing breaks, because nothing was written.
- On any navigation away from a surface with an *open, unfinished* held queue, show a quiet confirm:

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  Leave without finishing?                                        │
 │                                                                  │
 │  Your import hasn’t gone in yet, and the few answers you’ve      │
 │  given won’t be saved. You can start it again anytime from the   │
 │  same file — nothing in your camp has changed.                   │
 │                                                                  │
 │            [ Stay and finish ]      [ Leave ]                    │
 └─────────────────────────────────────────────────────────────────┘
```

- `[ Stay and finish ]` is `S.btnPrimary`; `[ Leave ]` is `S.btnSecondary`. This is a leave-confirm, not
  a destructive-action gate — brick `--danger` is **not** used; nothing is being destroyed.
- The `[ Not now ]` button on the entry banner (§1.2) triggers the same confirm if the queue was opened
  and partially answered; if the director never entered the queue, `Not now` dismisses without a prompt
  (there's nothing to lose).

### 5.3 Flag

Whether to persist a held import so it survives a session is a **real product question** (§7.4) — it is
the difference between "resolve now or redo" and "a durable Needs-Attention item on the hub". T73's
scope is the *resolve-now* surface; durability is the hub's job.

---

## 6. Animation

Every value below ships a `@media (prefers-reduced-motion: reduce)` fallback (crossfade or instant), per
DESIGN_STANDARD §8. **No bounce, no elastic — ever.** Only `opacity`, `transform` (translate), and
`max-height`/`clip` animate.

| Moment | Trigger | Motion | Values |
|---|---|---|---|
| **Held banner appears** | commit returns `{held:true}` | Slide + Fade | translateY -4px→0, opacity 0→1, `--motion-base` (220ms) `--ease-out`. Same family as the recoverable error banner (§5c), because it is an attention state, not an alarm. |
| **Enter resolution surface** | click "Review the N items" | Crossfade | banner max-height→0 + opacity→0 (`--motion-settle` 340ms), resolution surface opacity 0→1 + translateY 8px→0 (`--motion-base`). Reduced-motion: instant swap. |
| **Answer current item → advance** | a choice is committed | Settle | answered card collapses `max-height`→0 + fade (`--motion-settle` 340ms `--ease-out`); next card fades+lifts in (opacity 0→1, translateY 8px→0, `--motion-base`). This is the "collapsing merge card" case §8 names explicitly. Reduced-motion: instant. |
| **Rail row flips ✓** | item answered | Fade | glyph + summary crossfade `--motion-fast` (140ms). No slide. |
| **Emphasis swap in stale card** | toggle Keep mine ↔ Use the file's | Fade | the two values crossfade their colour/weight over `--motion-fast`. Do **not** animate the strike-through drawing; just crossfade to the struck state. Colour is normally not animated (§8), but this is a ≤140ms state confirm on two small spans and reads as a settle, not decoration — acceptable, and reduced-motion makes it instant. |
| **Footer gate enables** | last item answered | Fade | button opacity 0.45→1 `--motion-fast`; "(waiting on N)" subline crossfades to the Finish card. No motion on the button geometry. |
| **Finish card appears** | all answered | Fade + Settle | opacity 0→1, translateY 12px→0, `--motion-settle`. Matches the fatal-error/large-settle mount feel (§5d) minus any alarm. |

Motion here **explains state**: something was answered (it collapses away), the map updated (a row
ticked), the gate opened (the button lit). Nothing animates for delight.

---

## 7. Flags for the product owner / Governor

### 7.1 "Remember this" alias depends on S1b (not built) — DEPENDENCY
The confirm-identity card in `ONBOARDING_UX_OPTIONS.md` §6 carries a "Remember this — treat 'Art' as
'Art' next time" checkbox that writes a `source_alias`. **`source_aliases` is S1b and explicitly deferred
(ADR S1a scope).** This spec **omits the checkbox** so T73 doesn't imply a capability that doesn't exist.
When S1b lands, add the checkbox to §3.1's card per the ONBOARDING sketch. *No decision needed now — this
is a recorded dependency, not an open question.*

### 7.2 Does a kept-change item need an explicit click? — UX CHOICE (recommend "seen-is-answered")
§4.1: I recommend a stale item counts as answered once the director has *opened* it (keep-mine being the
safe default), rather than forcing a redundant click on the safe answer. The stricter alternative —
require an explicit click on every stale item — is safer-feeling but naggier. **Recommendation:
seen-is-answered, confidence medium.** Owner should confirm, because it trades a little friction against
the guarantee's visible strength.

### 7.3 "records" → "items" wording drift — MINOR
The existing success card and commit button say "records" (lines 332, 682); this spec says "items"
(warmer, less technical). Not a blocker, but for one voice across the screen, consider migrating the
existing copy to "items" when T73 touches this file. *Designer recommends "items"; trivial.*

### 7.4 Durability of a held import across sessions — PRODUCT QUESTION (out of T73 scope, flag only)
§5: T73 treats a held import as resolve-now-or-redo (nothing persisted). Whether a held import should
become a **durable Needs-Attention item on the readiness hub** (survives leaving, shows a `⋯ in-progress`
state per SETUP_READINESS §3) is a real product decision belonging to the hub slice, not this one. Flagged
so the resolve-now framing is a conscious choice, not an accident. *Owner input wanted before the hub
slice, not before T73 ships.*

### 7.5 Preview pre-classification of protected fields — deferred (ADR S2b OQ2)
ADR S2b Open Question 2 asks whether the *preview* should carry provenance to pre-warn that a field is
hand-edited (so the stale question is foreseeable before commit). That's a preview-fidelity enhancement,
not required for T73's resolve surface. **Out of scope; noted so it isn't lost.**

---

## 8. Decision-artifacts worth prototyping

Ranked. Prototype as self-contained HTML (per the Designer `prototype` skill) only where the interaction,
not the static layout, is what needs validating.

1. **The stale (kept-change) card's emphasis-swap** — HIGH value. The single most novel interaction: the
   contrast/strike inverting as the director toggles Keep-mine ↔ Use-the-file's is the thing most likely
   to be built subtly wrong or to read as alarming. A tiny interactive prototype de-risks it. This is the
   one artifact I'd build before Maker starts.
2. **The confirm-identity card, one-vs-many** — MEDIUM. The case-(a) side-by-side is already sketched in
   ONBOARDING §6; the *case-(b) candidate-chooser* (the `"Art"`/`"art "` radio stack) is new here and
   worth a static mock to confirm it reads as "which one?" not "pick a winner".
3. **The queue rail + auto-advance** — MEDIUM. Worth a lightweight prototype to feel whether
   collapse-and-advance is satisfying or jarring at 3–5 items, and whether the rail-as-map earns its
   space. Could be validated in the same prototype as #1.
4. **The held-entry banner copy** — LOW (copy, not interaction). Validate by reading aloud, not by
   building. The emotional tone ("Almost there… I need you on") is the deliverable; test it on the owner's
   ear.

I recommend building **#1 and #2 together** as one small interactive HTML prototype (the two cards, with
working toggles and the auto-advance between them), and treating #3's motion as part of that same file.
That single artifact covers every genuinely-novel interaction in T73; the rest is layout the existing
ImportScreen DNA already answers.

---

## 9. Implementation notes for Maker

- **This is `ImportScreen.jsx`, inline styles only.** The scoped-CSS exception in the Designer
  constitution is `src/components/schedule/` **only** — it does **not** reach this screen. Every style
  here is an inline React style object referencing `var(--token)`. No new stylesheet, no CSS class beyond
  the existing `press-97` utility.
- **The held branch in `commit()`.** `ingestCommit` can now return `{ held:true, conflicts:[…] }`. Branch
  on it: `held` → set the `held` state (do **not** set `result`, do **not** set `error`); `!held` → the
  existing success path, unchanged. A held return is **not** a thrown error — keep it out of the `catch`.
- **Resolutions are renderer state**, a map keyed by a stable per-conflict id the backend must supply in
  each `conflicts[]` entry (Maker: confirm the conflict objects carry a stable key; if not, that's a thin
  backend addition, per the ticket's "held-import resolution needs its own path"). Each resolution is one
  of: `{kind:'identity', choice:'same', entity_id}` / `{choice:'new'}` / `{choice:'skip'}`, or
  `{kind:'stale', choice:'keep'}` / `{choice:'accept'}`.
- **Stale-accept MUST route through the `stale_accept:true` path** (ADR S2b §3a) so the accepted value is
  written `source:'import'`, not the generic human seam. This is the correctness-critical wire: if
  "Use the file's" writes via the plain path, the field is re-tagged human and re-conflicts on every
  future import forever (the "NULL trap", ADR S2b §3a R1). Keep-mine writes **nothing** for that field.
- **The re-commit is the same atomic commit**, re-run with resolutions applied — never a partial write.
  All-or-nothing survives (ADR S1a §2). Handle a *second* held return (§4.3) by re-entering the queue with
  prior resolutions preserved.
- **Field-label map required.** Build a `FIELD_LABEL` map (mirroring the existing `LABEL` and
  `PRIORITY_LABEL` maps) turning column names into camp phrases: `location → "where it happens"`,
  `max_per_week → "how many times a week (most)"`, etc. Never render a raw column name in the stale card.
  If a field has no entry, fall back to a humanized version, but the common ones must be authored.
- **No red anywhere in this surface** except a genuinely fatal write failure on the final re-commit (which
  already routes through the existing `error` / `S.errorBanner` path). Held state, the queue, and every
  card are bronze/green/neutral. Reserving red keeps it loud (DESIGN_STANDARD §4).
- **Glyph + word + colour, always** (rail states, §2.2): never encode a row's state in colour alone.
- **Reduced-motion**: ship the §6 fallbacks. The auto-advance collapse in particular must degrade to an
  instant swap, or a reduced-motion user gets a 340ms freeze with no cue.
- **Reuse, don't reinvent:** the selected-button treatment is the keep-vs-replace selector already at
  `ImportScreen.jsx` lines 566–586 (`● ` prefix, `1.5px solid var(--primary)`, 8% navy tint). The
  bordered advisory blocks are lines 622–655. Match them exactly so the resolution surface reads as the
  same screen.
```
