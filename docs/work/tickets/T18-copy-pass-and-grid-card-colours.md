---
title: T18-copy-pass-and-grid-card-colours
document_type: ticket
status: parked
created: 2026-07-29
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
archive_when: superseded by an approved design spec
---

# T18 — Copy pass across the app, and the schedule grid's card colours

**Status: parked.** Raised by the product owner 2026-07-29 as future work, explicitly after the
current T15 route-separation work. Recorded so it is not lost. **Not a design — no approach
chosen.** Two related but separable pieces.

---

## 1. Wording and phrasing, app-wide

> "we need to clean up the wording and phrasing for all suggestions and how things work
> within the app"

Scope is every string a director reads: suggestions and findings, empty states, button labels,
confirmations, error messages, tooltips, and the explanatory copy describing how a feature
works.

The standard already exists and is not being met uniformly — `CONSTITUTION.md` Article V:
*"The user is a camp director, not a software operator. They know schedules and camp
operations. They do not know what an op-log is, and must never need to."*

Known instances, as starting evidence rather than a complete list:

- The grid legend rendered the raw enum `UNFILLABLE` in screaming caps until it was fixed on
  the T15 branch. That fix covered the legend only — the same class of wording very likely
  survives elsewhere.
- Findings and flag copy is the highest-value surface: it is what a director reads when
  something is wrong, which is exactly when jargon costs the most.
- The T15 work introduced substantial new copy (route offers, captions, export choice,
  confirmations). It should be reviewed in this pass rather than grandfathered.

### The strongest single case: the two routes name the same thing differently

Found 2026-07-29, after the T15 route separation landed. This is the best argument for doing
the pass, because it defeats a design intention that was deliberately paid for.

The whole point of a **shared flag vocabulary** across the manual and generated routes was that
a director learns it once. Today they would learn it twice. From the stat tiles
([`ScheduleScreen.jsx:1878-1908`](../../../src/screens/ScheduleScreen.jsx)), where every label
is a ternary on `isManual`:

| Manual route | Generated route | Same underlying data? |
|---|---|---|
| `Placed` | `Filled` | **Yes** — both `stats.filled` |
| `Still needed` | `Underserved` | **Yes** — both `f.kind === 'UNDERSERVED'` |
| `Spread across the week` | `Distribution` | **Yes** — both `f.kind === 'DISTRIBUTION'` |
| `Overlapping` | `Unfillable` | **No** — genuinely different flags per route |

The last row is correct and must stay: those are different concepts, and the routes share a flag
*vocabulary*, not an identical flag *set*. The first three rows are the defect — identical data
wearing two names.

**Direction, for confirmation:** adopt the manual route's wording everywhere. `Still needed` and
`Spread across the week` are what a director would say; `Underserved` and `Distribution` are
engine vocabulary that leaked into the interface, and Article V is unambiguous about which wins.
This is the rare copy fix that makes the app both plainer and more consistent at once.

Note the stat tiles differ by *shape* between routes on purpose — a comment at
`ScheduleScreen.jsx:1874` calls that "itself an orientation cue", and it is a reasonable one.
Which tiles appear may keep differing. What must not differ is the name of one concept.

### Two mechanical notes that will otherwise surprise the copy pass

- **The shouting is not in the strings.** Labels are written in sentence case and rendered
  uppercase by `textTransform: 'uppercase'` in
  [`StatBadge.jsx:17`](../../../src/components/schedule/StatBadge.jsx). Rewriting the words will
  not stop `SPREAD ACROSS THE WEEK` from shouting — that is a styling decision to make
  deliberately, and a long label in caps is markedly harder to scan than a short one.
- The `↗` affordance on clickable tiles is unexplained; a director does not necessarily read it
  as "open the details".

### How to work it

The useful unit of work is probably a **copy inventory first** — enumerate every user-facing
string with its screen and state — then a pass over it. Judging strings one screen at a time is
what produces the inconsistency in the first place, and the table above is exactly what a
screen-at-a-time review fails to notice.

Tone question for the product owner, since it governs every rewrite: findings should read as
*what the week still owes you* rather than *errors you have made*. That framing was settled for
the manual grid specifically; confirm whether it applies app-wide.

## 2. Card colours on the schedule grid

> "we need to clean up the card colors on the schedule grid"

This is the grid colour work parked earlier in the same session, now un-parked as future work.
**Read the prior audit before redoing it** — a Designer pass on 2026-07-28 found:

- The grid's colour tokens already match `DESIGN_STANDARD.md` exactly — no hardcoded hex in any
  of the eleven grid style objects, and the six-entry `ACTIVITY_COLORS` array verbatim.
- Therefore the dissatisfaction is **not** a conformance problem, and a second conformance
  audit will report "nothing wrong" again. The question is whether the *standard's* grid values
  are right, which is a token-value change and a product-owner approval gate.
- That audit was performed by reading source only. Nobody has evaluated the six activity
  colours **rendered**, at real cell width, across a full week of real activities — which is
  the condition the product owner is actually reacting to.

So the first step is to look at the rendered grid with real data, not to re-read the tokens.
`T17` (dead `colorIdx` field) is adjacent and should be closed out in the same area of code.

Note the grid gained an `OVERLAP` treatment during T15; whatever is decided must cover it.

## Sequencing

After the T15 route separation lands. Both pieces touch surfaces T15 is actively changing, and
doing them first would mean doing them twice.
