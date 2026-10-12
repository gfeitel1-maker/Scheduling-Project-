# Copy, clarity, accessibility & consistency audit — 2026-10-12 (build 3ae9fb9)

Not covered (load 150–280): Rebuild/Weather/Manual blank/Restore/Add-a-device dialogs. Label-class axe items skipped per owner.

## Copy & clarity
- A1 MAJOR quick — "Needs your attention" partial-pattern cards (RootsHomeScreen.jsx:178, reconciliationReport.js:561): "Only some groups showed this pattern…" + only "Dismiss". → "Only some groups have {name} in your file. Add it for the others too?" [Add for all groups] [Leave as is]; drop "Scheduling" chip.
- A2 MAJOR quick — Days (DaysScreen.jsx:316) "DAY | DAY OF WEEK" duplicates. → pick weekday; name defaults to it; custom label optional.
- A3 MAJOR — Time Blocks (TimeBlocksScreen.jsx:476): Name is a zero-padded copy of times ("12:55-01:35"); Part of Day "—" on all rows. → name optional/derived display; derive or remove Part of Day.
- A4 MAJOR quick — Roots "Schedule →" bar unexplained → "Build or generate the schedule →" + readiness line.
- A5 minor — Generated/Manual named two ways (ScheduleScreen.jsx:880,884).
- A6 minor — Activities headers ALT / MIN–MAX/WK / CO-SCHEDULE (ActivitiesScreen.jsx:1261) → Rain plan / Times per week / Groups at once.
- A7 minor — aria "Provenance: inferred…" (ActivitiesScreen.jsx:228) → "3 of 4 details guessed from your file. Check them."
- A8 minor — "23 / 14–42 wk", "×/wk" (ImportScreen.jsx:2854,2938) → "23 placed (needs 14–42)".
- A9 minor larger — Fixed/Recurring events one row per day (25/37 rows) → group by name, "Mon–Fri".
- A10 minor — PortMappingFlag.jsx:31-32 router error → plain consequence copy.
- A11 — done in #976.
- A12 minor — empty-state wording inconsistent (SpecialEventsScreen.jsx:37 etc.).
- A13 minor — "Delete All" styled as plain link beside utilities.
- A14 minor — Settings gear unlabelled; "Camp" screen sparse; footer Backup/Restore read as build info.

## Accessibility (axe-core 4.10.2)
- Build tag #848b92 on #fcfbf8 3.33:1 at 10px (Sidebar.jsx:427) — every screen.
- Roots attention chips 4.27:1 (RootsHomeScreen.jsx:178).
- Schedule inactive view toggles 4.19:1 (ScheduleScreen.jsx:1050); palette counts 10px 4.11:1.
- About grey paragraph 3.51:1 (AboutScreen.jsx:148); scrollable-region-focusable on About main.
- No keyboard traps; no focus-order failures.

## Cross-screen consistency
- C1 — "← Roots" missing on Fixed/Recurring Events (TopBar.jsx SETUP_SCREENS).
- C2 — Locations extra "← Back to Activities" (LocationsScreen.jsx:802); forward "Recurring Events →" skips (809).
- C3 larger — add control varies: inline row vs "+ Add X" modal (ActivitiesScreen.jsx:1239, FixedEventsScreen.jsx:928); "+ Add" wraps on Locations.
- C4 — utilities/next footer varies; Fixed Events "Go to Schedule" (FixedEventsScreen.jsx:915).
- C5 — "12 BLOCKS" vs screen "Time Blocks".
- C6 — empty states: one pattern (title + one line).
- C7 — Activities row actions stacked/unspaced; double-height rows.
- C8 — casing "Age Divisions" vs "AGE DIVISION"; placeholder examples inconsistent.
- C9 — Activities review dot wraps on long names; place markers consistently.
- C10 — table max-widths differ; Fixed Events crowded.
