---
title: "Can locations be inferred from a schedule? (needs a conversation first)"
document_type: ticket
status: open
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
archive_when: an owner conversation has produced either a design worth building or an explicit decision not to
---

# T147 — Can locations be inferred from a schedule?

**Spun off T114, owner, 2026-09-13.** Explicitly NOT ready to build. The owner
asked for it to be recorded and said it needs to be talked through, probably not
in the session that raised it. **No design, no approach chosen, no code
authorized.**

## Why it came up

T114 originally proposed inferring three activity rule columns from an imported
schedule, one of them `is_outdoor`. The owner rejected that specific one on
sound grounds: **outdoor-vs-indoor is a property of the PLACE, not of the
placement.** A schedule cell reads `Archery / Barn`; nothing in it says whether
the Barn is outdoors. The only source that could carry that fact is a locations
list.

Which raises the real question underneath: a schedule names places constantly —
`Barn`, `Lake`, `Loft`, `302` — and the app has a `locations` entity those
strings are already partially resolved against during ingest. So what, exactly,
can be learned about a camp's places from its schedule, and what can only come
from the director?

## What to talk through (not to answer here)

- **Existence vs. properties.** That a place named "Lake" exists is directly
  observable from a schedule. Its capacity, its indoor/outdoor-ness, whether
  "302" and "Room 302" are one room — none of those are. Where is the line?
- **What ingest already does.** Locations are already minted from schedule cells
  (`src/ingest/buildPlan.js` `fieldsFor('locations', …)`, and the
  `location_unresolved` held-conflict path). So some inference exists today —
  this ticket is partly about naming what that already is before extending it.
- **Capacity from co-occurrence.** If three groups are in the Lake in the same
  block across a whole season, is that evidence the Lake holds three? Or just
  evidence that the camp overbooked it? These are not the same claim.
- **The provenance rule.** Anything inferred must be labelled as inferred and
  must never be presented as a director-confirmed value
  (`src/utils/ruleProvenance.js`, and the `import_evidence` tagging T119
  established for capacity). This constrains the design more than it may appear.
- **Whether this is even wanted.** A director who has never entered a locations
  list may not want the app guessing at one.

## Non-goal

Guessing indoor/outdoor. That was rejected on the reasoning above, and nothing in
this ticket reopens it.

## Next step

A conversation with the owner. This ticket exists so the question is not lost,
not because a build is queued.
