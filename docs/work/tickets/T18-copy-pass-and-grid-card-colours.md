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

The useful unit of work is probably a **copy inventory first** — enumerate every user-facing
string with its screen and state — then a pass over it. Judging strings one screen at a time is
what produces the inconsistency in the first place.

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
