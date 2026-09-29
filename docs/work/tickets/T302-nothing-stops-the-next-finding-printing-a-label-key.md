---
title: "Nothing stops the next elective finding from printing a label key"
document_type: ticket
status: open
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
