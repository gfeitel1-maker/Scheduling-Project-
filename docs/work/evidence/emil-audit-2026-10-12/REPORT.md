---
title: "Design audit (Emil Kowalski lens), 2026-10-12"
document_type: evidence
status: active
created: 2026-10-12
archive_when: findings 1-8 are fixed and a later audit supersedes this one
---
# Design audit (Emil Kowalski lens) — 2026-10-12

How the app *acts*, not only whether it works. Driven over CDP against packaged build `3ae9fb9` (port 9870), source read-only. Screenshots in this directory. Not driven: Restore from backup (native picker), real device pairing, Elective assignment past empty state, Special Day grid editor.

Overall: motion is well-tuned (140/220/340ms tokens, one ease-out, no bounce); reduced-motion verified; drag is good; screen switches 2–30ms; Generate ~1.1s wall with a bar at ~230ms. An early 22–29s "freeze" reading was the probe's own polling — not a finding.

## Ranked findings

1. **HIGH, larger — add-row loses focus and remounts after every add.** `src/screens/LocationsScreen.jsx:834`, `src/components/setup/InlineAddRow.jsx:56-60`. Enter → input replaced, focus to BODY, CLS ~0.016. Breaks DESIGN_STANDARD §6a. Fix: no `loading=true` on post-mutation reload; refocus first input after reset. Check other add-row screens (`GroupsScreen.jsx:51`).
2. **HIGH, larger — dialogs not keyboard-first.** `ConfirmRegenModal.jsx:17`, `ExportChooserModal.jsx:14`, `DeleteWeekDialog.jsx:71,96`, `ExclusionConfirmDialog.jsx:6`, `DeleteRecordDialog.jsx:176`, `RecordHistory.jsx:70`, `ConfirmDangerDialog.jsx:42`. Focus stays on BODY, Escape ignored, no dialog role (17 overlays: Escape 4, role 4, focus 6). Fix: shared `useModalA11y({onCancel, initialFocusRef})` — role=dialog aria-modal, Escape cancels, focus Cancel on mount, restore on close.
3. **HIGH, quick — press/hover feedback is opt-in and patchy.** `src/styles/shared.js:159-183`, `src/index.css:69-74`. 223 `press-9x` vs 374 buttons; primary/secondary have no hover. Fix: global `button:not(:disabled){transition:transform var(--motion-fast) var(--ease-out)} button:not(:disabled):active{transform:scale(0.97)}`; `nav button:active{transform:none}`; primary hover `--primary-dark` under `@media (hover:hover) and (pointer:fine)`.
4. **MEDIUM-HIGH — resolved review card vanishes in one frame, list jumps (CLS 0.038).** `src/components/reconciliation/RootMapPanel.jsx:122-135`, `src/styles/shared.js:754-764`. Fix: 340ms collapse (max-height/opacity/margin/padding, ease-out) reusing `mergeCard`; reduced-motion opacity 140ms.
5. **MEDIUM, quick — "Loading…" flashes, then content jumps.** `src/styles/shared.js:821-825` (~20 screens). Fix: `S.stateLoading` gets `animation: loading-in 140ms var(--ease-out) 150ms both` (`from{opacity:0}`).
6. **MEDIUM — modal motion lifts the scrim; no exit.** `src/styles/shared.js:21-52, 303-312`. Fix: scrim opacity only; lift (+ optional scale 0.97→1) on the card; 140ms opacity exit by delaying unmount.
7. **MEDIUM, quick — Versions popover: no motion, no Escape.** `src/components/schedule/VersionsDropdown.jsx:56-61, 27-35`. Fix: `useEnterTransition('popFade',{transformOrigin:'top right'})`; Escape → `onToggle()`.
8. **LOW-MEDIUM, quick — footer shift after backup; silent first-run wait.** `Sidebar.jsx:455-475`, `CampBootstrapScreen.jsx:93`. Fix: reserve 20px for Show in Finder; "Backing up…" past 150ms; `IndeterminateBar` after 300ms on camp creation (~2.5s).

## Smaller polish
- "Rebuild it" (`ConfirmRegenModal.jsx:28-33`) and `ConfirmDangerDialog.jsx:46` confirm lack press — covered by 3.
- Manual Build empty state pinned to top: `ScheduleScreen.jsx:1292-1293` lacks `padding:'60px 16px'` (`22-screen-manual-build.png`).
- `Sidebar.jsx:179` `background 0.1s` → `background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)`.
- Special Events offer row and new Locations rows pop in → `useEnterTransition('slideFade')`.

## Deliberately not flagged
Generate/Rebuild flow; drag-and-drop ghost; instant main-nav switches; reduced motion; scoped `chipAttentionPulse`.

## Order
1 and 2 first (keyboard/focus bugs); 3 next (one rule, most perceived polish); batch 5, 7, 8. Keep the sidebar quiet. No motion on grid cells, nav switches, or row add/delete. Existing tokens only.
