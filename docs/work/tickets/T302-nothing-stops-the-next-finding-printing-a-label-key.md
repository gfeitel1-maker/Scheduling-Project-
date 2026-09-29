---
title: "Nothing stops the next elective finding from printing a label key"
document_type: ticket
status: completed
created: 2026-09-29
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T300-findings-name-activities-as-the-director-does.md]
archive_when: "a finding kind added to `buildElectiveAssignments` or `findMismatches` that names an activity by its label key fails a deterministic check — planted and verified red — rather than reaching a director's screen; and the check's own blind spots are written down where the next author of a finding will read them"
---

# T302 — Nothing stops the next elective finding from printing a label key

Found while closing [T300](T300-findings-name-activities-as-the-director-does.md). T300 fixed four
findings **and** the render they share. This ticket is about the fact that the fix is per-instance
where it needs to be structural.

## The gap

`src/screens/elective/assignment/findingDisplayMessage.js` resolves a display name for a finding
that carries `labelKey`, `activity_id` or `choice_ids`, **and whose producer wrapped the key in
quotes**. Four of the roughly eleven finding kinds that reach that list are covered by a test.

A new finding kind silently reintroduces T300's bug in at least three ways:

1. **It interpolates a label key without quoting it.** The substitution is quote-anchored on purpose
   — an elective named `Run` would otherwise turn "campers it needs to run" into "campers it needs
   to Run" — so an unquoted key is invisible to it.
2. **An existing producer changes its quoting or wording.** T300's render tests drive the real
   producers precisely so this turns them red, but only for the four kinds those tests cover.
3. **It carries a different identifier.** A finding keyed by, say, `set_id` or `occurrence_id`
   resolves nothing, and the resolver returns the message unchanged — which is the correct
   fallback and also a silent one.

Nothing catches any of these: not ESLint, not the type system (there isn't one here), not a test.
The failure surface is a sentence a camp director reads.

## Why this is its own ticket and not a T300 round 2

T300's scope was the four findings that are wrong **today**, and it closed them with evidence. The
guard is a different kind of work — it is test/gate infrastructure with its own blind spots to
enumerate, and it should not be smuggled into a rendering fix.

This is the "guard the choke point, not the instance" shape: T300 guarded the choke point for
*rendering*, but the choke point for *authoring a finding* is still unguarded.

## Approaches, for Architect to choose between

Listed with the tradeoff, not as a menu for the owner to pick from — the recommendation is (a), on
the grounds that it needs no producer change and fails loudly at the exact seam that rotted.

- **(a) An enumerating test.** Collect every `kind:` a producer can emit, and assert that a finding
  carrying a label renders a name rather than a key. Cost: it needs a fixture per kind, and a kind
  it cannot construct must be reported as `unknown`, never skipped silently.
- **(b) Producers emit a marked slot** (`{label}`) that the renderer fills. A forgotten slot shows
  up as literal `{label}` on screen — loud, not silent. Cost: changes every producer's message and
  the tests that pin them, and leaks markers to any future consumer of `message`.
- **(c) A lint rule** banning `labelKey` interpolation inside a `message:`. Cheap and structural,
  but a text-level rule with the blind spots text-level rules always have (a key reached through a
  helper, a template built in two steps).

**Whichever is chosen, the non-vacuity plant must be a shape the guard cannot obviously see.** T300
learned this the hard way: its first guard survived the planted defect, because in that fixture the
key never appeared in the message at all, so the test could never have earned the design it claimed
to protect. See `feedback_plant_the_defect_the_guard_cannot_see`.

## Non-goals

- Not a re-design of the finding vocabulary or of any existing message's wording.
- Not a general "no internal identifiers in UI copy" sweep across the app. This is scoped to the
  elective findings rail, which is where the defect was measured.
- Not a type system.

## Evidence required to close

- The guard, planted red and restored green, with the planted shape written down.
- A written list of what the guard structurally cannot observe, in the guard's own header — an
  accurately described narrow guard is fine; a narrow guard described broadly is the defect.

## Closed — what shipped, and how narrow it is

`src/screens/elective/assignment/findingLabelCoverage.test.js`, approach **(a)**, the enumerating
test. The kinds are read OUT OF THE PRODUCER SOURCE rather than hand-listed, so a new `kind:`
literal in either producer fails the file until it has a fixture. Nine kinds covered — seven from
`buildElectiveAssignments`, two from `findMismatches` — each driven through the real producer.
Modelled on `electron/ops/mergeActivity.test.js`, including its bidirectional check: a fixture for a
kind nobody emits any more also fails, so a stale entry cannot make the file look broader than it is.

Each kind declares whether its message may name an activity, and **the declaration is proved rather
than trusted** — a kind declared label-free must demonstrate its message holds no key. Without that
half the table would be an escape hatch: a future author could silence a real bug by declaring the
kind label-free. Every fixture must also actually emit its kind; a fixture that stopped triggering
is reported by name, never skipped, which is how T300's first guard came to survive its own plant.

**Planted red three times, one per failure mode the ticket names, each restored:**

1. A kind DECLARED label-free starts carrying a key unquoted (added `(${here[0].labelKey})` to
   `NO_CAPACITY`) — red on `NO_CAPACITY` alone. This is the plant a reader would expect the table to
   hide, which is why it is the one that matters.
2. An existing producer stops quoting its label (removed the curly quotes from `BELOW_MINIMUM`) —
   red, quoting the key and the remedy.
3. A brand-new kind appears (renamed `UNRANKED_OFFERING` to `BRAND_NEW_FINDING`) — red twice, and
   both correct: the divergence check named the new kind and its file, and `UNRANKED_OFFERING`'s own
   test failed because its fixture no longer emitted it.

**Where the blind spots are written down.** The guard's own header lists what it structurally cannot
see. Because the next author of a finding works in a PRODUCER and may never open the test, a short
pointer sits at `const findings = []` in `src/engine/buildElectiveAssignments.js` and above
`findMismatches` in `src/screens/elective/assignment/buildOfferings.js`, naming the quoting rule and
sending the reader to the guard's header rather than implying it covers them.

**Deliberately NOT covered, and stated so the guard is not read as broader than it is.** The rail is
composed from five sources in `AssignmentPanel.jsx`; only the two this ticket names are scanned.
`UNMATCHED_DIVISION` / `AMBIGUOUS_DIVISION` quote a DIVISION value off the sheet, never an activity
label key; the coordinate residue names day and period labels (`resolvePreferenceCoordinates.js`
contains no `labelKey`); `deriveOccurrences`' findings never reach this rail. Verified 2026-09-29 —
those two producers are the only ones that can emit an activity-label-keyed finding. Also not
covered: the render wiring, since these assertions call `findingDisplayMessage` directly. That is
pinned separately, for four kinds, by `AssignmentPreview.test.jsx` — do not delete those tests on the
grounds that this file exists.
