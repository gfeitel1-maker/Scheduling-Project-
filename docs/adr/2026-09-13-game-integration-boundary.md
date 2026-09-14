---
title: "ADR: The camp game talks to Shoresh through a boring explicit contract, never through its data"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-09-13
decided: 2026-09-14
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: []
---

# ADR: The camp game talks to Shoresh through a boring explicit contract, never through its data

**Accepted by the product owner, 2026-09-14.** It still authorizes no
implementation work — `implementation_state` stays `not_started` — but the
boundary below is now normative: when the game integration is built, it is built
this way, and a design that crosses one of these lines needs a superseding ADR
rather than a judgement call in a pull request.

It was written before anything was connected because that is the cheapest moment
to fix a boundary. The game (`~/dev/gesher-mapworld`) is a separate project.

## Context

An external architecture review (2026-09-13, item 13) asked that the integration
not be allowed to collapse the current domain boundaries. The concern is
specific and correct: a simulation that needs "where is everyone at 10am" is
one `readFileSync` away from the camp database, and that shortcut is invisible
until someone tries to change the schema.

## Decision

**Shoresh owns camp and schedule semantics. The game owns world representation
and simulation.** They meet at one explicit, versioned, read-oriented contract
carrying only what the game actually needs — locations and their topology,
schedule state, time, occupants, and whatever operational state a scene has to
reflect.

Four things are out of bounds, each because of what it would cost later:

- **The game must not read Shoresh's SQLite directly.** SQLite is a rebuildable
  projection of the Automerge document, and its shape changes with every
  migration (59 so far). A reader outside this repo would turn every future
  migration into a cross-project breaking change nobody in this repo can see.
- **Shoresh must not store Phaser entities.** Sprites, tiles, atlases and scene
  graphs belong to a rendering choice; the camp model outlives it. (`locations`
  already carries dormant tile-world columns from a removed spatial layer —
  that is the shape of the mistake, already made once.)
- **Scheduling rules must not be reimplemented in the game.** `buildSchedule.js`
  is the single place eligibility, capacity and contention are decided. A second
  implementation would be wrong in a different way from the first, which is
  worse than being wrong the same way twice.
- **Tile and sprite concepts must not leak into the canonical camp model.** A
  location has a capacity because the engine contends on it, not because
  something has to be drawn there.

## The invariant this exists to protect

**The game implementation must be replaceable without a scheduling-engine or
persistence rewrite.** If replacing Phaser with something else would require
touching `src/engine/`, `electron/ops/` or the schema, the boundary has already
been broken.

## Consequences

The contract is a serialization step Shoresh owns and the game consumes —
almost certainly the same shape the existing machine-access surface already
produces (`scripts/mcp/tools.js`'s `export_schedule` / `schedule_state`), which
is evidence the boundary is natural rather than imposed. Reusing it is the first
thing to try.

The cost is an explicit translation layer instead of a direct read. That is the
point: the translation is where the coupling is allowed to live, and it is one
file to update when either side moves.
