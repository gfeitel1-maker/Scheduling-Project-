---
title: "Finding dismissals are coordinate-only, so a materially-changed finding at the same coordinates is masked"
document_type: ticket
status: in-progress
created: 2026-09-16
task_class: schedule-ui
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/work/specs/2026-09-16-payload-addressed-finding-dismissal-design.md]
depends_on: "None (base-independent). Spun off from T182 round-2 review 'Known residuals'. Composes cleanly once T182 (ANCHOR_DUPLICATE, branch claude/anchor-dup-finding-eager) lands — that kind falls through to the binary key path."
archive_when: findingDismissKey is the single shared source of the dismissal key, both the activeFindings filter and the dismiss write route through it, a materially-worse UNDERSERVED/DISTRIBUTION finding at unchanged coordinates is no longer masked after a slot-edit recompute, tests pin the pure key + the masking scenario, and `npm run verify` is green
---

# T185 — Payload-addressed finding dismissal

## Confirmed problem (premise corrected against code — do not re-litigate)
`dismissedFindingKeys` (`src/screens/schedule/useRouteState.js`, per-route in-memory `Set`) keys a
dismissed finding by `groupId|activityId|kind` only (`src/screens/ScheduleScreen.jsx` — the
`activeFindings` filter and the `dismissFinding` write). The key carries **no material payload**.

T182's round-2 residual note framed this as "not reset on regenerate." **That framing is inaccurate.**
`generate()`/`regenFromScratch()` DO reset the route's dismissed set to empty
(`src/screens/schedule/useGeneration.js:100`, also 161/180/227); snapshot restore resets it
(`useSnapshots.js:172`); a fresh screen load resets it (`ScheduleScreen.jsx:453`). So the
dismiss→regenerate→recur cycle the note describes does **not** reproduce — a dismissed finding
resurfaces after any regenerate.

The genuine defect is the ONE recompute path that recomputes findings WITHOUT resetting dismissals:
the slot-edit path, `recalcFindings(next)` in `src/screens/schedule/useSlotMutations.js`
(lines 637, 932, 1087, 1408, 1594 — drag/drop, replace, release, etc.). Because the key is
coordinate-only:

> A director dismisses "Swim UNDERSERVED **2/3**". They drag a swim out of the week → findings
> recompute via `recalcFindings` (no dismissal reset) → it is now "Swim UNDERSERVED **1/3**", a
> materially WORSE finding at the same `(group, activity, kind)` → the stale coordinate-only
> dismissal masks it. The director never sees it got worse.

This bites the magnitude-bearing kinds (`UNDERSERVED`, `DISTRIBUTION`). `ANCHOR_DUPLICATE` (T182) and
`DANGLING_LOCATION` are binary (presence only). `UNFILLABLE`/`OVERLAP`/`WEEK_CLOSED` are NOT in
`dismissedFindingKeys` at all (they dismiss via per-slot flags), so they are out of scope.

## Product decision (owner-approved 2026-09-16)
A dismissal covers exactly the finding that was dismissed. It survives incidental edits that leave the
finding materially identical, but a finding that changes materially — worse, or a genuinely new one at
the same coordinates — is NOT masked and resurfaces. (Because the store is a `Set` with no memory of
the dismissed magnitude, an *improving-but-still-present* finding also resurfaces. Accepted: honest,
and not worth a magnitude-comparison mechanism — YAGNI.)

Rejected alternatives: reset dismissals on every recompute (a dismissal would evaporate the moment the
director touches any cell — worse UX); leave-as-is + document (leaves the masking hole open).

## Fix
Route every dismissal key through ONE shared pure helper so the write-key and read-key cannot drift
(the T62 two-places-that-drifted lesson).

- [ ] New pure module `src/screens/schedule/findingKey.js` exporting `findingDismissKey(finding)`:
      base `groupId|activityId|kind`, plus a kind-specific material suffix — `UNDERSERVED` →
      `|got:<got>|needed:<needed>`, `DISTRIBUTION` → `|before:<beforeCount>|req:<requiredBefore>`,
      everything else (`ANCHOR_DUPLICATE`, `DANGLING_LOCATION`, unknown) → base only (binary presence).
- [ ] `ScheduleScreen.jsx` `activeFindings` filter uses `findingDismissKey(f)` (raw finding retains the
      magnitude fields).
- [ ] `ScheduleScreen.jsx` `findingsRows` activeFindings map carries `dismissKey: findingDismissKey(f)`.
- [ ] `dismissFinding` takes the precomputed key; `dismissFindingsRow` passes `row.dismissKey`.
- [ ] Tests: (a) pure `findingKey.test.js` — identical coords+magnitude → equal key; worse magnitude →
      different key; binary kinds ignore absent magnitude fields. (b) the masking scenario — dismiss
      UNDERSERVED 2/3, recompute at 1/3, assert the finding is active again (and that an unchanged 2/3
      recompute stays dismissed).
- [ ] `npm run verify` green.

## Scope boundaries (why this is small and low-risk)
`dismissedByRoute` is ephemeral in-memory component state — never written to the DB (snapshot save
persists slots only). So NO migration, NO stored-shape change, NO op-log/sync surface, NO Red Hat
data-shape trigger. Renderer/hook layer only; the engine is untouched.
