---
title: T251-t199-acceptance-fixture
document_type: ticket
status: in-progress
created: 2026-09-23
archive_when: the spec §6 acceptance fixture passes under electron:dev with no manual database edits, the full gate is green, and T199's own exit condition is satisfied
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T199-individual-electives-end-to-end.md]
---

# T251 — T199 acceptance fixture and release closure

The integrated end-to-end pass T199 itself describes: the spec §6 acceptance fixture, visual/
accessibility QA, and closing T199. This ticket does not duplicate T199's content — it is the
"assemble and verify everything T243-T250 built" slice, and its own completion is what allows T199
to close.

## Scope

- Run the spec §6 acceptance fixture end to end under `electron:dev` (not the `:5200` mock — T199
  is explicit this must exercise real persistence and sync).
- Visual/accessibility QA pass on the Draft and Final screens (T250) per DESIGN_STANDARD.
- Confirm the D8 disclosure (T249) is present at every entry into the flow, not only the literal
  first render.
- Confirm the release-precondition copy (Delete cost honesty per D10, encryption gate per D8) reads
  as T199 requires.
- Full gate green (`npm run verify` — respect the machine-wide lock; do not run concurrently with
  another session's gate).
- Close T199: flip its `status` in the same commit that references `closes T199`, per
  WORK_RECORD_STANDARD §3.1 — do not let a later commit discover the drift.

## Non-goals

Any new code beyond what's needed to make the fixture pass — this ticket surfaces gaps in
T243-T250, it does not silently patch around them with scope those tickets should have owned.
If the fixture reveals a real gap in an earlier slice, that is a finding against that slice, fixed
there (or spun to a follow-up ticket), not absorbed here.

## Test seam

The acceptance fixture itself **is** the integration-harness-mandatory case — it is the canonical
example TESTING_STANDARD's "touching sync, auth, or schema" rule exists for.

## Dependencies

T243, T244, T245, T246, T247, T248, T249, T250 — all of them. This is the terminal ticket in the
decomposition and cannot start meaningfully before the others are substantially done, though QA
prep (fixture data assembly, accessibility checklist) can begin in parallel once T250 has a
renderable screen.

## State — 2026-09-30 (round 2, escalated)

The spec §6 fixture is built and asserted; see
[docs/work/runs/2026-09-30-t251-t199-acceptance-fixture.md](../runs/2026-09-30-t251-t199-acceptance-fixture.md)
and the screenshots under `docs/work/evidence/T251/`.

**This ticket cannot close, and neither can T199, because T199's exit condition is not met.** Driving
the real Electron app against this fixture's own camp found four gaps in the director flow, each
confirmed against `src/` and none of them absorbed here per this ticket's own Non-goals:

- No Finalize control exists anywhere in the app, so `FinalRunView`, the `OUTER_RESOURCE_CONFLICT`
  refusal and the linked-bundle rendering are unreachable by a director.
- No reachable regenerate control, so locking a seat has no observable consequence.
- The same-name refusal renders as a screen-reader-only announcement when the camp has two candidate
  schedules; the sheet then solves and offers to commit, silently merging the duplicate pair.
- No Delete control for an elective run, so ADR D10's honest-cost copy has nothing to sit on.

The D8 at-rest-encryption disclosure passes at every entry tested.

These are findings against T249/T250 and are for the owner's board, not for this ticket to fix.

## Walk 2026-09-30 — real app, screen access granted

The board worker drove the real `electron:dev` app by hand against this ticket's own acceptance
camp (19:10-20:16, with the owner's screen grant), the first time this flow was exercised end to
end as a director rather than through a jsdom-rendered component. The first capture attempt failed
honestly before anything was written: `screencapture` from the shell has no screen-recording
permission on this machine, so its 24 frames were 24 copies of the desktop wallpaper, not the app.
That evidence was deleted and the walk was re-captured through the Chrome DevTools Protocol
(`Page.captureScreenshot` against the renderer of an Electron instance relaunched with
`--remote-debugging-port=9222`), which writes real renderer pixels. The 16 new frames (2800x1694,
200-410 KB, dated 2026-09-30) live at `docs/work/evidence/T251/`, alongside the 13 frames from the
2026-09-29 pre-fix walk, which stay as the record of that state.

**The loop is reachable end to end**: import a sheet, map it, solve it (Manual and Generated
routes), commit, lock a seat, finalize, read the Final view, export, and start a new version from a
stale run. That resolves the four gaps this ticket's "State — 2026-09-30 (round 2)" section
reported — a Finalize control, a regenerate path, and a Delete control were all found; the
same-name refusal is reachable too, but see below. The spec §6 condition "JSON, XLSX, UI, CLI and
MCP agree" (condition 11 of the twelve pass conditions) is now met by T198 (#665).

**But the walk surfaced four new director-facing defects at this same seam**, which is why status
stays as it is rather than closing: under the owner's rule that a director-facing defect found at
an owned seam is a reason the work is not finished, not a reason to record it and move on (subject
to the owner's own override):

- **`i-write-ipc-freezes-app-after-commit-and-finalize`** — Commit and Finalize each froze the main
  process (sampled CPU-bound, pure JS stack) for 5-6 minutes on a 47-placement run, with every
  renderer click dead for the duration. See `09b-generated-run-after-finalize-recovered.png`.
- **`i-final-run-always-reads-out-of-date-since-v76`** — every Final run shows "This run was
  finalized before a later change on another device synced in. It is out of date." even on a
  single-device camp with no other device. This is a false alarm:
  `electron/ops/finalizedAgainstStaleGeneration.js` compares every distinct
  `elective_run_outer_snapshots.solver_generation` to the run's own, and rows inherited from a
  parent carry `NULL` rather than the parent's value — 234 `NULL` rows against 78 matching rows for
  the run in `09-final-run-view-identity-false-stale-row-start-new-version-export.png`. This is
  spec §6's "changing the template marks the run stale and prevents finalization" condition
  (condition 9) firing on every run, not just a changed one — the "marks the run stale" half stays
  an asserted gap, now with a known false-positive cause rather than an unknown one.
- **`i-same-name-sheet-solves-silently-dropping-a-camper`** — importing a sheet with two
  same-named campers in different groups (`docs/work/specs/samples/fabricated-camper-preferences-
  same-name.csv`) reaches the route chooser rather than being refused, and the Manual route then
  solves "2 campers placed" against three distinct campers on the sheet — the second same-named
  camper is silently merged into the first, dropping their rows rather than refusing or
  disambiguating. `scripts/preferenceSheetCli.test.js` expects this exact file to be refused on the
  CLI; the UI path does not refuse it. See `12a`/`12`/`12b`-prefixed frames.
- **`i-bundle-tier-not-covered-wall-and-raw-codes`** — seen in the first, uncaptured pass: a wall of
  repeated `BUNDLE_TIER_NOT_COVERED`-style paragraphs and raw `OUTER_RESOURCE_CONFLICT` code
  bullets rendered on both routes, session-scoped to riding a commit result rather than appearing
  on a cold open. Not reproduced in the captured pass because resolving the underlying Lakefront
  capacity conflict (a legitimate director fix, 3->10 groups-at-once on the Locations screen) was
  needed to reach Finalize at all.

Spec §6 condition 4 ("no camper violates eligibility") remains an asserted gap, unchanged by this
walk — the walk did not newly test it either way.

Reduced motion stays unverified: DevTools' reduced-motion emulation could not be driven in this
pass; the console read `matchMedia('(prefers-reduced-motion: reduce)').matches === false` with a
0.14s transition observed, so no frame is filed for it and the claim is not made.

Full evidence table, freeze measurements, and the fixture-script fix made along the way are in
[docs/work/runs/2026-09-30-t251-electron-dev-walk-director-flow.md](../runs/2026-09-30-t251-electron-dev-walk-director-flow.md).
