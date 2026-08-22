---
title: Roots-as-Hub Setup IA — implementation slices
document_type: spec
status: approved
created: 2026-08-22
archive_when: all slices ship (merged, deferred, or reassigned) or the ADR is superseded
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
---

# Roots-as-Hub Setup IA — implementation slices

Implements `docs/adr/2026-08-22-roots-as-hub-setup-ia.md`. Each slice is one PR
through the Maker → parallel review → Verifier gate → Grader loop. Colors are the
app tokens, unchanged (ADR §8). No schema/op-log/engine changes in any slice.

## Slice ordering (small, reversible, independently shippable)

### Slice A — Remove explainer copy (lowest risk, highest owner-signal)
**Do:** delete the `SCREEN_INTRO` narration (`src/components/screenIntroText.js` and
its render sites), the schedule caption `captionSub: 'Drag anything to move it.'` +
`caption: 'The week the app proposed'` (`ScheduleScreen.jsx`), and the Roots census
header explainer line. Where a screen currently renders `SCREEN_INTRO[key]`, remove
the element (do not replace with other prose).
**Do not:** remove genuine inline field hints that describe *input format* (e.g. the
PIN hint) — those are not screen-purpose narration.
**Success:** no screen shows a "this screen is for…" sentence; `npm run verify`
green; a Tester pass confirms each setup screen still reads clearly from its
controls alone.
**Seams/tests:** update any test asserting the removed strings; add a guard test
that `screenIntroText` is gone (or the map is empty) so it can't creep back.

### Slice B — Sidebar: entity screens collapsible under Roots; System behind Settings
**Do:** nest the entity rows (Program, Age Divisions, Groups, Days, Time Blocks,
Activities, + optional Locations/Fixed Events/Special Days) as a collapsible list
under the Roots nav item; keep the green ✓ / count affordance. Move Camp / Conflicts
/ Trash / LAN & Devices behind a Settings affordance (Conflicts keeps its badge;
Devices role-gated). Keep both Schedule routes as their own rows.
**Reuse:** the W2 stash work (`navSections.js` ADMIN_MENU_ITEMS / ADMIN_ONLY_MENU_ITEMS,
Sidebar gear) is a starting point — but the schedule-route collapse from that stash
is REJECTED; keep the two routes.
**Success:** sidebar shows Roots (expandable) ↔ Schedule (2 rows) ↔ Settings; every
old destination still reachable; gate green; Tester confirms nav.

### Slice C — Import: single, state-aware entry
**Do:** remove the duplicate Import path so there is one. Empty camp → Import is the
Roots header action (calm, not a banner). Populated → Import recedes to Settings
(re-import), keeping the existing non-destructive diff-preview. An empty camp reads
as "open and waiting," not "empty."
**Success:** exactly one Import entry point per camp state; re-import diff intact;
gate green.

### Slice D — Inferred rules on entity screens, with provenance
**Do:** on the Activities screen (first; pattern then extends to other entity
screens that carry inferred rules), surface each inferred rule as a row tagged
observed / inferred / confirmed with a Confirm/Change control. Reuse
`CONFIDENCE_COPY` / `plainEvidenceSentence` and the roots-census provenance model —
this surfaces data the app already holds; it is not new inference. Not on the Roots
dashboard; not framed as "what Shoresh learned."
**Success:** a director can see and confirm/correct the rules inferred for an
activity, with honest provenance; gate green; Tester (director-eye) confirms the
rules are legible and the stakes are clear.
**Depends on:** verifying what inferred-rule data actually exists today (some rule
columns render "—"); if inference is thin, Slice D may split into "surface existing"
+ a follow-up ingest ticket. Coordinate with the fixed-activity mislabel ingest bug.

### Slice E (follow-on, not blocking) — Motion + depth pass
`/improve-animations` + `/apple-design`, emil-validated, on the app motion tokens
(`--motion-fast 140ms`, `--motion-base 220ms`, `--motion-settle 340ms`,
`--ease-out cubic-bezier(0.22,1,0.36,1)`). Address the owner's "cards feel flat"
note (elevation/hover/press depth). Motion only where purposeful — press feedback,
card-fill-on-root, confirm flip — never on constantly-used nav (emil).

## Non-goals / guardrails
- No palette change (ADR §8). If a contrast issue arises, fix by *usage* (dot not
  text, darker text token), never by inventing a color.
- No schema, op-log, sync, or engine change.
- Do not collapse the two schedule routes.
- Do not add Roots-dashboard rules or "learning" framing.
- Keep the shipped roots-visual layout; refine, don't replace.
