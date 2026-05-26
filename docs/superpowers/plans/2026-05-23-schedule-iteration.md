# Schedule Iteration Plan

## Tasks
1. Add `_reason` strings to all 4 flag types in buildSchedule.js
2. Add `_dismissed` support to FlagDetailModal
3. Update SlotCell to show reason on hover, hide dismissed dots
4. Add Dismiss button to FlagDetailModal rows
5. Add `is_locked` to activities table (migration)
6. Add `is_released` to template_slots table (migration)
7. Update SlotCell: locked styling (amber border, corner triangle)
8. Wire lock/release handlers in ScheduleScreen Day view
9. Create `schedule_snapshots` table (migration)
10. Auto-save snapshot before each regeneration
11. Build VersionsDropdown component
12. Wire restore/rename/save-named in ScheduleScreen
