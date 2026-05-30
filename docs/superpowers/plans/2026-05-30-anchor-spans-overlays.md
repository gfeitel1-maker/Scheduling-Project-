# Anchor Spans and Field Trip Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-block anchor spans (with unit scope) and a post-generation field trip overlay stamp tool to the scheduling app.

**Architecture:** Three coordinated changes: (1) the engine gains anchor `span_blocks` and `unit_id` scope so one anchor definition covers an entire unit and/or multiple consecutive blocks; (2) `ScheduleScreen` gains an overlay system backed by a new `template_overlays` DB table for field trip stamps that sit on top of the generated schedule; (3) a pull drawer UI lets users stamp overlay cells onto the schedule and extend them vertically via a fill handle drag.

**Tech Stack:** React (inline styles, no CSS modules), Supabase (SQL migrations applied via Supabase SQL editor — NEVER push to Shoresh project `nbfyaewcjxpcdupqnyhu`), Vitest (engine unit tests), @dnd-kit (existing, unchanged)

**Branch:** Create `feat/anchor-spans-overlays` before starting Task 1.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/20260530_01_anchor_spans.sql` | Create | Add `span_blocks` + `unit_id` to `anchor_activities` |
| `supabase/migrations/20260530_02_template_overlays.sql` | Create | `template_overlays` table + RLS + `overlays` column on `schedule_snapshots` |
| `src/engine/buildSchedule.js` | Modify | Anchor unit scope + span_blocks in `anchorLookup` build loop |
| `src/engine/buildSchedule.test.js` | Modify | New tests for anchor `unit_id` scope and `span_blocks` |
| `src/components/schedule/SlotCell.jsx` | Modify | Accept `rowSpan` prop and pass to `<td>` |
| `src/components/schedule/OverlayCell.jsx` | Create | Amber overlay cell with remove button and fill handle |
| `src/components/schedule/FieldTripDrawer.jsx` | Create | Slide-in pull drawer with stamp buttons |
| `src/screens/ScheduleScreen.jsx` | Modify | Overlays state/CRUD, merged anchor rendering, overlay rendering, drawer toggle, stamp mode, fill handle |

---

## Context for Subagents

**Project location:** `/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-/`

**Run tests:** `npm test` (Vitest). Only `src/engine/buildSchedule.test.js` has tests — that is the only file to add engine tests to.

**Style rules:** All styles are inline React objects. Shared constants are in `src/styles/shared.js` imported as `import { S } from '../styles/shared'`. No CSS files. No Tailwind.

**Supabase:** Apply migrations via the Supabase SQL editor (copy-paste the SQL). CRITICAL: only use the local/development Supabase project. Never touch project `nbfyaewcjxpcdupqnyhu` (Shoresh production).

**Key architecture facts:**
- `anchor_activities` table: currently has `id, camp_id, name, is_all_groups, group_ids[], day_id, time_block_id, activity_id`. Needs `span_blocks` (int default 1) and `unit_id` (uuid nullable).
- `template_slots` columns used in code: `id, template_id, group_id, day_id, time_block_id, activity_id, anchor_id, is_anchor, flags`. No `is_span_head` in DB — derive at render time.
- `groups` table has `tier_id` — this is the unit. Anchor `unit_id` matches `group.tier_id`.
- `template_overlays` will follow the same RLS pattern as `template_slots` (join through `schedule_templates` to get `camp_id`).
- The engine's `buildSchedule.js` is a pure function. The legacy `anchors` param flows through `_legacyAnchors` in `scheduleCohort`.
- `timeBlocks` in ScheduleScreen state is already sorted by `sort_order` (loaded with `.order('sort_order')`).

---

## Task 1: DB Migration — Anchor Spans

**Files:**
- Create: `supabase/migrations/20260530_01_anchor_spans.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Add span_blocks and unit_id to anchor_activities
-- span_blocks: how many consecutive blocks this anchor claims (default 1 = existing behavior)
-- unit_id: if set, anchor applies to all groups whose tier_id matches this value
--          (expands at engine time; takes precedence over is_all_groups / group_ids)

ALTER TABLE anchor_activities
  ADD COLUMN IF NOT EXISTS span_blocks int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES tiers(id) ON DELETE SET NULL;

-- Verify:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'anchor_activities'
--   AND column_name IN ('span_blocks', 'unit_id')
-- ORDER BY ordinal_position;
```

- [ ] **Step 2: Apply the migration**

Copy the SQL above into the Supabase SQL editor for the local/development project and run it.

Verify: run the verification query at the bottom. Expect two rows returned (`span_blocks` integer with default 1, `unit_id` uuid).

- [ ] **Step 3: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add supabase/migrations/20260530_01_anchor_spans.sql
git commit -m "feat: add span_blocks and unit_id to anchor_activities"
```

---

## Task 2: Engine — Anchor Unit Scope + span_blocks

**Files:**
- Modify: `src/engine/buildSchedule.js` (lines 95–114)
- Modify: `src/engine/buildSchedule.test.js` (add tests at end of file)

The engine's anchor loop (lines 95–101) currently only resolves `is_all_groups` / `group_ids`. It needs two additions:
1. `unit_id` scope: if set, expand to all groups where `group.tier_id === anchor.unit_id`
2. `span_blocks`: for each resolved group, mark the next N-1 consecutive blocks with `_isSpanHead: false`

The slot push for anchors (line 113) needs to use `anchor._isSpanHead` to set `is_span_head` correctly on the output slot.

**Fixtures already defined in the test file** (use these — don't redefine):
- `baseDay = { id: 'd1', day_of_week: 1, sort_order: 0 }`
- `blockA = { id: 'bA', sort_order: 0, part_of_day: 'morning' }`
- `blockB = { id: 'bB', sort_order: 1, part_of_day: 'morning' }`
- `blockC = { id: 'bC', sort_order: 2, part_of_day: 'morning' }`

- [ ] **Step 1: Write the failing tests**

Add this block at the end of `src/engine/buildSchedule.test.js` (after the last `describe` block):

```js
// ── Anchor unit_id scope ──────────────────────────────────────────────────────

describe('anchor unit_id scope', () => {
  const g1 = { id: 'g1', name: 'Aleph', tier_id: 'unit1', availability: 'all' }
  const g2 = { id: 'g2', name: 'Bet', tier_id: 'unit1', availability: 'all' }
  const g3 = { id: 'g3', name: 'Gimel', tier_id: 'unit2', availability: 'all' }

  it('unit_id anchor applies to all groups in the matching unit', () => {
    const anchor = { id: 'anc1', name: 'Swim', unit_id: 'unit1', is_all_groups: false, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots.map(s => s.groupId).sort()).toEqual(['g1', 'g2'].sort())
    expect(anchorSlots.some(s => s.groupId === 'g3')).toBe(false)
  })

  it('unit_id takes precedence over is_all_groups=true', () => {
    // Even if is_all_groups is true, unit_id should limit scope to unit1 only
    const anchor = { id: 'anc1', name: 'Swim', unit_id: 'unit1', is_all_groups: true, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots.map(s => s.groupId).sort()).toEqual(['g1', 'g2'].sort())
  })
})

// ── Anchor span_blocks ────────────────────────────────────────────────────────

describe('anchor span_blocks', () => {
  const anchorBase = { id: 'anc1', name: 'Theater', is_all_groups: true, group_ids: [], unit_id: null, day_id: 'd1', time_block_id: 'bA' }

  it('span_blocks=2 creates anchor slots for head and tail block', () => {
    const anchor = { ...anchorBase, span_blocks: 2 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(2)
    expect(anchorSlots.map(s => s.blockId).sort()).toEqual(['bA', 'bB'].sort())
  })

  it('span_blocks=2: head block has is_span_head=true, tail has is_span_head=false', () => {
    const anchor = { ...anchorBase, span_blocks: 2 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    const head = anchorSlots.find(s => s.blockId === 'bA')
    const tail = anchorSlots.find(s => s.blockId === 'bB')
    expect(head?.is_span_head).toBe(true)
    expect(tail?.is_span_head).toBe(false)
  })

  it('span_blocks=3 marks three consecutive blocks', () => {
    const anchor = { ...anchorBase, span_blocks: 3 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB, blockC],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(3)
  })

  it('span_blocks truncates gracefully when not enough blocks remain', () => {
    // span_blocks=3 but only 2 blocks available — fills what it can
    const anchor = { ...anchorBase, span_blocks: 3 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    // Should still anchor the 2 available blocks (does not crash)
    expect(anchorSlots.length).toBeGreaterThan(0)
    expect(anchorSlots.length).toBeLessThanOrEqual(2)
  })

  it('anchor span tail blocks prevent activity placement', () => {
    // anchor starts at bA with span=2 (covers bA + bB).
    // A single activity eligible for g1 should NOT be placed in bB.
    const anchor = { ...anchorBase, span_blocks: 2 }
    const act = { id: 'a1', name: 'Drama', priority: 'low', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB, blockC],
      activities: [act],
      anchors: [anchor],
      campId: 'test',
    })
    const dramaSlots = result.slots.filter(s => s.activityId === 'a1')
    // Drama should only be in blockC (bA and bB are anchored)
    expect(dramaSlots.every(s => s.blockId === 'bC')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — verify new tests fail**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm test -- src/engine/buildSchedule.test.js
```

Expected: the new `anchor unit_id scope` and `anchor span_blocks` describe blocks fail (existing tests still pass).

- [ ] **Step 3: Implement the engine changes**

In `src/engine/buildSchedule.js`, replace lines 95–114 (the anchor lookup build loop and the anchor slot push) with:

**Replace this block (lines 95–101):**
```js
  const anchors = _legacyAnchors || []
  for (const anchor of anchors) {
    const groupList = anchor.is_all_groups ? groups.map(g => g.id) : (anchor.group_ids || [])
    for (const gid of groupList) {
      anchorLookup.set(`${gid}|${anchor.day_id}|${anchor.time_block_id}`, anchor)
    }
  }
```

**With this:**
```js
  const anchors = _legacyAnchors || []
  for (const anchor of anchors) {
    // Scope resolution order: unit_id > is_all_groups > group_ids
    let groupList
    if (anchor.unit_id) {
      groupList = groups.filter(g => g.tier_id === anchor.unit_id).map(g => g.id)
    } else if (anchor.is_all_groups) {
      groupList = groups.map(g => g.id)
    } else {
      groupList = anchor.group_ids || []
    }

    const spanBlocks = anchor.span_blocks || 1
    for (const gid of groupList) {
      // Head block
      anchorLookup.set(`${gid}|${anchor.day_id}|${anchor.time_block_id}`, { ...anchor, _isSpanHead: true })
      // Tail blocks (span_blocks > 1)
      if (spanBlocks > 1) {
        const headIdx = blockOrder.get(anchor.time_block_id)
        if (headIdx !== undefined) {
          for (let i = 1; i < spanBlocks; i++) {
            const tailBlock = timeBlocksSorted[headIdx + i]
            if (tailBlock) {
              anchorLookup.set(`${gid}|${anchor.day_id}|${tailBlock.id}`, { ...anchor, _isSpanHead: false })
            }
          }
        }
      }
    }
  }
```

**Replace lines 112–115 (the anchor slot push):**
```js
        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'anchor', activityId: null, anchorId: anchor.id, is_span_head: true, flags: {} })
          continue
        }
```

**With:**
```js
        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'anchor', activityId: null, anchorId: anchor.id, is_span_head: anchor._isSpanHead !== false, flags: {} })
          continue
        }
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
npm test -- src/engine/buildSchedule.test.js
```

Expected: all tests pass including the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/engine/buildSchedule.js src/engine/buildSchedule.test.js
git commit -m "feat: engine supports anchor unit_id scope and span_blocks"
```

---

## Task 3: ScheduleScreen — Merged Anchor Cell Rendering

**Files:**
- Modify: `src/components/schedule/SlotCell.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

When an anchor has `span_blocks > 1`, the engine now generates anchor slots for all covered blocks (head + tails). The DB stores one `template_slot` per block, each with `anchor_id` pointing to the same anchor. At render time, detect consecutive same-anchor slots and render a single `<td rowSpan={N}>` for the head, skipping tails.

No unit tests needed here (pure render logic, covered by manual verification).

- [ ] **Step 1: Add `rowSpan` prop to SlotCell**

In `src/components/schedule/SlotCell.jsx`, every `<td>` that the component returns needs to accept and apply a `rowSpan` prop. Change the function signature and every `return <td ...>` inside it.

**Current function signature (line 21):**
```js
export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit, onLock, onRelease, isLocked, isDndEnabled }) {
```

**Replace with:**
```js
export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit, onLock, onRelease, isLocked, isDndEnabled, rowSpan = 1 }) {
```

There are multiple `return <td ...>` statements in SlotCell (for anchor type, unavailable type, and normal). Add `rowSpan={rowSpan}` to each `<td>`:

- Line ~42: `<td ref={setRef} style={cellTd} onClick={() => onEdit(slot)}>` → `<td ref={setRef} rowSpan={rowSpan} style={cellTd} onClick={() => onEdit(slot)}>`
- Line ~62: `<td ref={setRef} style={emptyTd}>` → `<td ref={setRef} rowSpan={rowSpan} style={emptyTd}>`
- Line ~129: `<td ref={setRef} style={{ ...cellTd, cursor: ... }}>` → `<td ref={setRef} rowSpan={rowSpan} style={{ ...cellTd, cursor: ... }}>`

- [ ] **Step 2: Add anchor-span helpers to ScheduleScreen**

In `src/screens/ScheduleScreen.jsx`, add these two helper functions after the `getSlot` function (around line 344):

```js
  // Returns true if this slot is a tail block of a multi-block anchor
  // (i.e., the previous block for this group+day has the same anchor_id)
  function isAnchorTail(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot?.is_anchor || !slot?.anchor_id) return false
    const blockIdx = timeBlocks.findIndex(b => b.id === blockId)
    if (blockIdx <= 0) return false
    const prevSlot = getSlot(groupId, dayId, timeBlocks[blockIdx - 1].id)
    return Boolean(prevSlot?.is_anchor && prevSlot?.anchor_id === slot.anchor_id)
  }

  // Returns how many consecutive blocks share the same anchor_id starting at blockId
  function getAnchorRowSpan(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot?.is_anchor || !slot?.anchor_id) return 1
    const startIdx = timeBlocks.findIndex(b => b.id === blockId)
    if (startIdx === -1) return 1
    let span = 1
    for (let i = startIdx + 1; i < timeBlocks.length; i++) {
      const nextSlot = getSlot(groupId, dayId, timeBlocks[i].id)
      if (nextSlot?.is_anchor && nextSlot?.anchor_id === slot.anchor_id) {
        span++
      } else {
        break
      }
    }
    return span
  }
```

- [ ] **Step 3: Update group view rendering to use rowSpan and skip tails**

In the group view `{days.map(day => { ... })}` (around line 477), find where SlotCell is rendered for the group view and update the rendering logic. The current code block starts with `if (!slot) return <td key={day.id} style={emptyTd} />` followed by `return <SlotCell .../>`.

**Replace the entire `return` block inside `{days.map(day => {` for the group view:**

```js
                        {days.map(day => {
                          const slot = getSlot(selectedGroup, day.id, block.id)
                          if (!slot) return <td key={day.id} style={emptyTd} />
                          // Skip anchor tail cells — covered by the head's rowSpan
                          if (slot.is_anchor && isAnchorTail(selectedGroup, day.id, block.id)) return null
                          const rowSpan = slot.is_anchor && !isAnchorTail(selectedGroup, day.id, block.id)
                            ? getAnchorRowSpan(selectedGroup, day.id, block.id)
                            : 1
                          const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                          const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                          return (
                            <SlotCell
                              key={day.id}
                              rowSpan={rowSpan}
                              slot={slot.is_anchor ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: slot.activity_id || !slot.is_anchor ? 'activity' : 'unavailable', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                              activity={act}
                              anchor={anchor}
                              actColorIdx={act?.colorIdx || 0}
                              weatherMode={weatherMode}
                              onEdit={s => setEditSlot(s)}
                            />
                          )
                        })}
```

- [ ] **Step 4: Update day view rendering the same way**

In the day view `{groups.map(group => { ... })}` (around line 550), apply the same pattern. **Replace the entire `return` block inside the group map in the day view:**

```js
                      {groups.map(group => {
                        const slot = getSlot(group.id, selectedDay, block.id)
                        if (!slot) return <td key={group.id} style={emptyTd} />
                        // Skip anchor tail cells — covered by the head's rowSpan
                        if (slot.is_anchor && isAnchorTail(group.id, selectedDay, block.id)) return null
                        const rowSpan = slot.is_anchor && !isAnchorTail(group.id, selectedDay, block.id)
                          ? getAnchorRowSpan(group.id, selectedDay, block.id)
                          : 1
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const actIsLocked = slot.activity_id && act?.is_locked
                        const isLocked = Boolean(actIsLocked && !slot.is_released)
                        return (
                          <SlotCell
                            key={group.id}
                            rowSpan={rowSpan}
                            slot={slot.is_anchor
                              ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                              : { ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={s => setEditSlot(s)}
                            onLock={s => lockActivity(s.activity_id)}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            isDndEnabled={!isLocked}
                          />
                        )
                      })}
```

- [ ] **Step 5: Verify in browser**

```bash
npm run dev
```

Create a test anchor with `span_blocks = 2` in your local Supabase (update an existing anchor's `span_blocks` to 2 via the SQL editor: `UPDATE anchor_activities SET span_blocks = 2 WHERE id = '<id>';`). Generate a schedule. In Group View and Day View, the anchor should render as one merged cell spanning two rows.

- [ ] **Step 6: Commit**

```bash
git add src/components/schedule/SlotCell.jsx src/screens/ScheduleScreen.jsx
git commit -m "feat: render multi-block anchors as merged cells with rowSpan"
```

---

## Task 4: DB Migration — template_overlays Table

**Files:**
- Create: `supabase/migrations/20260530_02_template_overlays.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- template_overlays: post-generation field trip / event stamps
-- Overlays sit on top of the generated schedule and negate the slots they cover.
-- They belong to a template (live schedule), not a snapshot.
-- Removing an overlay instantly restores the underlying schedule — no regen needed.
--
-- from_block_order / to_block_order use sort_order from time_blocks for range comparison.
-- unit_id references tiers(id): applies to ALL groups in that unit.
-- label: free text — "Field Trip", "Special Event", "Service Project", etc.

CREATE TABLE IF NOT EXISTS template_overlays (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      uuid NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  unit_id          uuid NOT NULL,
  day_id           uuid NOT NULL,
  from_block_order int  NOT NULL,
  to_block_order   int  NOT NULL,
  label            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT from_lte_to CHECK (from_block_order <= to_block_order)
);

CREATE INDEX IF NOT EXISTS template_overlays_template_idx
  ON template_overlays (template_id);

-- RLS: same pattern as template_slots — join through schedule_templates to get camp_id
ALTER TABLE template_overlays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "template_overlays_owner" ON template_overlays FOR ALL
  USING (
    (SELECT camp_id FROM schedule_templates WHERE id = template_overlays.template_id) = get_my_camp_id()
  )
  WITH CHECK (
    (SELECT camp_id FROM schedule_templates WHERE id = template_overlays.template_id) = get_my_camp_id()
  );

-- Add overlays column to schedule_snapshots so saved versions capture the overlay state
ALTER TABLE schedule_snapshots
  ADD COLUMN IF NOT EXISTS overlays jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Verify:
-- SELECT table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name IN ('template_overlays', 'schedule_snapshots')
--   AND column_name IN ('id', 'template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label', 'overlays')
-- ORDER BY table_name, ordinal_position;
```

- [ ] **Step 2: Apply the migration**

Copy the SQL into the Supabase SQL editor and run it. Verify with the query at the bottom — expect rows for both tables.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260530_02_template_overlays.sql
git commit -m "feat: add template_overlays table and overlays column to snapshots"
```

---

## Task 5: OverlayCell Component

**Files:**
- Create: `src/components/schedule/OverlayCell.jsx`

This component renders a single amber `<td>` that may span multiple rows. It shows the overlay label, a remove button (on click), and an optional fill handle (shown when it's the last visible cell of the overlay span).

- [ ] **Step 1: Create the component**

```jsx
import { useState } from 'react'

export const OVERLAY_COLOR = '#f59e0b'
export const OVERLAY_BG = '#f59e0b18'
export const OVERLAY_TEXT = '#d97706'
export const OVERLAY_BORDER = '#f59e0b'

export default function OverlayCell({ label, onRemove, rowSpan = 1, showFillHandle = false, fillHandleDirection = 'vertical', onFillStart }) {
  const [showRemoveBtn, setShowRemoveBtn] = useState(false)

  return (
    <td
      rowSpan={rowSpan}
      style={{ padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }}
      onClick={() => setShowRemoveBtn(v => !v)}
    >
      <div style={{
        background: OVERLAY_BG,
        border: `1.5px solid ${OVERLAY_BORDER}`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        height: '100%',
        position: 'relative',
        boxSizing: 'border-box',
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 700,
          color: OVERLAY_TEXT,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </div>

        {showRemoveBtn && (
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              background: '#DC2626',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              fontSize: 10,
              padding: '2px 6px',
              cursor: 'pointer',
              fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            ✕ Remove
          </button>
        )}

        {showFillHandle && (
          <div
            title="Drag to extend overlay"
            onPointerDown={e => {
              e.preventDefault()
              e.stopPropagation()
              onFillStart?.()
            }}
            style={{
              position: 'absolute',
              bottom: -5,
              right: fillHandleDirection === 'both' ? -5 : '50%',
              transform: fillHandleDirection === 'both' ? 'none' : 'translateX(50%)',
              width: 12,
              height: 12,
              background: OVERLAY_COLOR,
              border: '2px solid white',
              borderRadius: 2,
              cursor: fillHandleDirection === 'both' ? 'se-resize' : 's-resize',
              zIndex: 10,
              userSelect: 'none',
            }}
          />
        )}
      </div>
    </td>
  )
}
```

- [ ] **Step 2: Verify no import errors**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors (OverlayCell is not imported anywhere yet — that's fine, build checks syntax).

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/OverlayCell.jsx
git commit -m "feat: add OverlayCell component for field trip overlays"
```

---

## Task 6: ScheduleScreen — Overlays State, CRUD, Snapshot Integration

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

Add `overlays` state, load from `template_overlays` on mount, add CRUD functions, update snapshot save/restore to capture and restore overlay state.

- [ ] **Step 1: Add overlays state variable**

In `src/screens/ScheduleScreen.jsx`, add `overlays` state after the `snapshots` state declaration (around line 38):

```js
  const [overlays, setOverlays] = useState([])
```

- [ ] **Step 2: Load overlays in loadAll()**

In the `loadAll()` function, inside the second `try` block (after loading `template_slots`), add a query to load template overlays. Find the block that loads slots and add overlay loading right after `setSlots(saved)`:

```js
        // Load overlays for this template
        const { data: overlayData } = await supabase
          .from('template_overlays')
          .select('*')
          .eq('template_id', tmpl.id)
        setOverlays(overlayData || [])
```

Place this after the line `setSlots(saved)` and before the snapshots query.

- [ ] **Step 3: Add addOverlay function**

After the `releaseCell` function (around line 222), add:

```js
  async function addOverlay({ unitId, dayId, fromBlockOrder, toBlockOrder, label }) {
    if (!templateId) return
    const { data } = await supabase
      .from('template_overlays')
      .insert({ template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label })
      .select()
      .single()
    if (data) setOverlays(prev => [...prev, data])
  }

  async function removeOverlay(overlayId) {
    await supabase.from('template_overlays').delete().eq('id', overlayId)
    setOverlays(prev => prev.filter(o => o.id !== overlayId))
  }

  async function updateOverlayRange(overlayId, toBlockOrder) {
    await supabase.from('template_overlays').update({ to_block_order: toBlockOrder }).eq('id', overlayId)
    setOverlays(prev => prev.map(o => o.id === overlayId ? { ...o, to_block_order: toBlockOrder } : o))
  }
```

- [ ] **Step 4: Update saveSnapshot to include overlays**

Find the `saveSnapshot` function (around line 225). The current insert includes `{ template_id, name, is_auto, slots: snapSlots }`. Add `overlays`:

**Find this line:**
```js
      .insert({ template_id: templateId, name: name || null, is_auto: isAuto, slots: snapSlots })
```

**Replace with:**
```js
      .insert({ template_id: templateId, name: name || null, is_auto: isAuto, slots: snapSlots, overlays: overlays.map(o => ({ unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label })) })
```

- [ ] **Step 5: Update restoreSnapshot to restore overlays**

Find the `restoreSnapshot` function (around line 244). After restoring `template_slots`, add overlay restoration.

After the line `setSlots(freshSlots || [])` and before `recalcStats(freshSlots || [])`, add:

```js
    // Restore overlays from snapshot
    if (templateId) {
      await supabase.from('template_overlays').delete().eq('template_id', templateId)
      const snapOverlays = fullSnap.overlays || []
      if (snapOverlays.length > 0) {
        const overlayRows = snapOverlays.map(o => ({ template_id: templateId, unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label }))
        await supabase.from('template_overlays').insert(overlayRows)
      }
      const { data: freshOverlays } = await supabase.from('template_overlays').select('*').eq('template_id', templateId)
      setOverlays(freshOverlays || [])
    }
```

- [ ] **Step 6: Clear overlays when regenerating**

The `generate()` function deletes template_slots and re-inserts. Add overlay clearing right after the `supabase.from('template_slots').delete()` call:

```js
    // Clear overlays when regenerating (post-generation stamps are re-applied manually)
    await supabase.from('template_overlays').delete().eq('template_id', tid)
    setOverlays([])
```

- [ ] **Step 7: Verify — run dev server and check no errors**

```bash
npm run dev
```

Open the Schedule screen. No console errors expected. The overlays state exists but nothing renders yet.

- [ ] **Step 8: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: overlays state, CRUD functions, and snapshot integration in ScheduleScreen"
```

---

## Task 7: ScheduleScreen — Overlay Rendering

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

Before rendering any slot, check if an overlay covers that cell. If yes, render `OverlayCell` (head only, with rowSpan) and return `null` for tail cells. This applies to both group view and day view.

- [ ] **Step 1: Import OverlayCell**

At the top of `src/screens/ScheduleScreen.jsx`, add the import after the other schedule component imports:

```js
import OverlayCell from '../components/schedule/OverlayCell'
```

- [ ] **Step 2: Add overlay helper functions**

After the `getAnchorRowSpan` function added in Task 3 (around line 365), add:

```js
  // Returns the overlay object if an overlay covers this (group, day, block), else null
  function overlayForCell(groupId, dayId, blockId) {
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return null
    return overlays.find(o =>
      o.unit_id === group.tier_id &&
      o.day_id === dayId &&
      block.sort_order >= o.from_block_order &&
      block.sort_order <= o.to_block_order
    ) || null
  }

  // Returns true if this block is the FIRST block of an overlay (render the OverlayCell here)
  function isOverlayHead(groupId, dayId, blockId) {
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return false
    const overlay = overlayForCell(groupId, dayId, blockId)
    if (!overlay) return false
    return block.sort_order === overlay.from_block_order
  }

  // Returns the rowSpan for an overlay starting at this block
  function getOverlayRowSpan(overlay) {
    return overlay.to_block_order - overlay.from_block_order + 1
  }
```

- [ ] **Step 3: Add stamp mode state and handler**

Near the other state declarations (around line 35), add:

```js
  const [stampMode, setStampMode] = useState(null) // null | string (label of active stamp)
  const [fillState, setFillState] = useState(null)  // null | { overlayId }
```

Add a handler for when a slot is clicked in stamp mode. Add this function after `updateOverlayRange` (added in Task 6):

```js
  async function handleStampClick(groupId, dayId, blockId) {
    if (!stampMode) return
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return
    await addOverlay({
      unitId: group.tier_id,
      dayId,
      fromBlockOrder: block.sort_order,
      toBlockOrder: block.sort_order,
      label: stampMode,
    })
  }

  function startFill(overlay) {
    setFillState({ overlayId: overlay.id })
  }

  function handleFillEnter(blockSortOrder) {
    if (!fillState) return
    const overlay = overlays.find(o => o.id === fillState.overlayId)
    if (!overlay) return
    // Only allow extending (not shrinking below from_block_order)
    if (blockSortOrder >= overlay.from_block_order) {
      setFillState(prev => ({ ...prev, previewToOrder: blockSortOrder }))
    }
  }

  async function commitFill() {
    if (!fillState?.previewToOrder) { setFillState(null); return }
    await updateOverlayRange(fillState.overlayId, fillState.previewToOrder)
    setFillState(null)
  }
```

- [ ] **Step 4: Update group view to render overlay cells**

In the group view, inside `{days.map(day => {` (the block we updated in Task 3), add overlay check at the very top of the map function, before the anchor tail check:

```js
                        {days.map(day => {
                          // Overlay check — takes priority over schedule slot
                          const overlay = overlayForCell(selectedGroup, day.id, block.id)
                          if (overlay && !isOverlayHead(selectedGroup, day.id, block.id)) return null // tail — covered by head rowSpan
                          if (overlay && isOverlayHead(selectedGroup, day.id, block.id)) {
                            const rowSpan = getOverlayRowSpan(overlay)
                            const isLastRow = block.sort_order === overlay.to_block_order
                            return (
                              <OverlayCell
                                key={day.id}
                                label={overlay.label}
                                rowSpan={rowSpan}
                                onRemove={() => removeOverlay(overlay.id)}
                                showFillHandle={isLastRow}
                                fillHandleDirection="vertical"
                                onFillStart={() => startFill(overlay)}
                              />
                            )
                          }

                          const slot = getSlot(selectedGroup, day.id, block.id)
                          if (!slot) return <td key={day.id} style={emptyTd} />
                          if (slot.is_anchor && isAnchorTail(selectedGroup, day.id, block.id)) return null
                          const rowSpan = slot.is_anchor && !isAnchorTail(selectedGroup, day.id, block.id)
                            ? getAnchorRowSpan(selectedGroup, day.id, block.id)
                            : 1
                          const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                          const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null

                          // Stamp mode: clicking a non-overlay cell places a stamp
                          const cellClickHandler = stampMode
                            ? () => handleStampClick(selectedGroup, day.id, block.id)
                            : undefined

                          return (
                            <SlotCell
                              key={day.id}
                              rowSpan={rowSpan}
                              slot={slot.is_anchor ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: slot.activity_id || !slot.is_anchor ? 'activity' : 'unavailable', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                              activity={act}
                              anchor={anchor}
                              actColorIdx={act?.colorIdx || 0}
                              weatherMode={weatherMode}
                              onEdit={cellClickHandler || (s => setEditSlot(s))}
                            />
                          )
                        })}
```

- [ ] **Step 5: Update day view to render overlay cells the same way**

In the day view, inside `{groups.map(group => {`, add the same overlay check at the top:

```js
                      {groups.map(group => {
                        // Overlay check
                        const overlay = overlayForCell(group.id, selectedDay, block.id)
                        if (overlay && !isOverlayHead(group.id, selectedDay, block.id)) return null
                        if (overlay && isOverlayHead(group.id, selectedDay, block.id)) {
                          const rowSpan = getOverlayRowSpan(overlay)
                          return (
                            <OverlayCell
                              key={group.id}
                              label={overlay.label}
                              rowSpan={rowSpan}
                              onRemove={() => removeOverlay(overlay.id)}
                              showFillHandle={true}
                              fillHandleDirection="both"
                              onFillStart={() => startFill(overlay)}
                            />
                          )
                        }

                        const slot = getSlot(group.id, selectedDay, block.id)
                        if (!slot) return <td key={group.id} style={emptyTd} />
                        if (slot.is_anchor && isAnchorTail(group.id, selectedDay, block.id)) return null
                        const rowSpan = slot.is_anchor && !isAnchorTail(group.id, selectedDay, block.id)
                          ? getAnchorRowSpan(group.id, selectedDay, block.id)
                          : 1
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const actIsLocked = slot.activity_id && act?.is_locked
                        const isLocked = Boolean(actIsLocked && !slot.is_released)

                        const cellClickHandler = stampMode
                          ? () => handleStampClick(group.id, selectedDay, block.id)
                          : undefined

                        return (
                          <SlotCell
                            key={group.id}
                            rowSpan={rowSpan}
                            slot={slot.is_anchor
                              ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                              : { ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={cellClickHandler || (s => setEditSlot(s))}
                            onLock={s => lockActivity(s.activity_id)}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            isDndEnabled={!isLocked && !stampMode}
                          />
                        )
                      })}
```

- [ ] **Step 6: Add `onPointerEnter` to `<tr>` rows for fill handle tracking**

In both the group view and day view table bodies, each `<tr>` needs to fire `handleFillEnter` when the fill state is active. Find each `<tr key={block.id} style={{ borderBottom: ... }}>` in both views and update them:

Group view `<tr>`:
```jsx
<tr
  key={block.id}
  style={{ borderBottom: '1px solid var(--border)' }}
  onPointerEnter={() => {
    const b = timeBlocks.find(tb => tb.id === block.id)
    if (b && fillState) handleFillEnter(b.sort_order)
  }}
>
```

Day view `<tr>` (same change).

- [ ] **Step 7: Add global pointerup listener to commit fill**

In the `useEffect` section of ScheduleScreen (near the top), add a new effect to handle the global pointer-up when the fill handle is dragging:

```js
  useEffect(() => {
    if (!fillState) return
    function onPointerUp() { commitFill() }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  }, [fillState, overlays])
```

- [ ] **Step 8: Verify manually**

```bash
npm run dev
```

Insert a test overlay directly via Supabase SQL editor:
```sql
INSERT INTO template_overlays (template_id, unit_id, day_id, from_block_order, to_block_order, label)
VALUES ('<your-template-id>', '<a-tier-id>', '<a-day-id>', 0, 1, 'Field Trip');
```

Refresh the app. In Day View or Group View, the covered cells should show amber "Field Trip" overlay cells spanning 2 rows. Clicking an overlay cell shows the remove button. Clicking "✕ Remove" deletes it.

- [ ] **Step 9: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: render overlay cells in group and day views with fill handle"
```

---

## Task 8: FieldTripDrawer Component + Stamp Mode

**Files:**
- Create: `src/components/schedule/FieldTripDrawer.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

A pull drawer that slides in from the right side of the screen. Contains stamp buttons. Selecting a stamp enters stamp mode — clicking any schedule slot places a 1-block overlay with that label.

- [ ] **Step 1: Create FieldTripDrawer component**

```jsx
// src/components/schedule/FieldTripDrawer.jsx
import { useState } from 'react'

const PRESET_STAMPS = ['Field Trip', 'Special Event', 'Service Project']

const OVERLAY_COLOR = '#f59e0b'
const OVERLAY_BG = '#f59e0b18'

export default function FieldTripDrawer({ isOpen, onClose, activeStamp, onSelectStamp }) {
  const [customLabel, setCustomLabel] = useState('')

  function handleStampClick(label) {
    onSelectStamp(activeStamp === label ? null : label)
  }

  function handleCustomStamp() {
    const trimmed = customLabel.trim()
    if (!trimmed) return
    onSelectStamp(activeStamp === trimmed ? null : trimmed)
  }

  return (
    <>
      {/* Backdrop — only blocks interaction when open */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            zIndex: 40,
          }}
        />
      )}

      {/* Drawer panel */}
      <div style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: 240,
        height: '100vh',
        background: 'var(--surface-elevated)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
        zIndex: 50,
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.22s ease-out',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 16px',
        gap: 8,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 14, color: 'var(--text)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Field Trip Stamps
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-secondary)', lineHeight: 1, padding: 4 }}
            title="Close"
          >✕</button>
        </div>

        {activeStamp && (
          <div style={{ background: '#f59e0b20', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#92400e', marginBottom: 4 }}>
            <strong>Stamp mode:</strong> Click any slot to place "{activeStamp}".<br />
            <button
              onClick={() => onSelectStamp(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', color: '#92400e', fontSize: 11, padding: 0, marginTop: 4 }}
            >Cancel stamp</button>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
          Presets
        </div>

        {PRESET_STAMPS.map(label => (
          <button
            key={label}
            onClick={() => handleStampClick(label)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 7,
              border: `1.5px solid ${activeStamp === label ? OVERLAY_COLOR : 'var(--border)'}`,
              background: activeStamp === label ? OVERLAY_BG : 'var(--surface)',
              color: activeStamp === label ? '#92400e' : 'var(--text)',
              fontSize: 13,
              fontWeight: activeStamp === label ? 700 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            {label}
          </button>
        ))}

        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
          Custom
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={customLabel}
            onChange={e => setCustomLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCustomStamp()}
            placeholder="Label…"
            style={{
              flex: 1,
              padding: '7px 8px',
              border: '1.5px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              outline: 'none',
              background: 'var(--surface)',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleCustomStamp}
            disabled={!customLabel.trim()}
            style={{
              padding: '7px 10px',
              background: customLabel.trim() ? OVERLAY_COLOR : 'var(--border)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: customLabel.trim() ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            Use
          </button>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Import and wire FieldTripDrawer into ScheduleScreen**

At the top of `src/screens/ScheduleScreen.jsx`, add:

```js
import FieldTripDrawer from '../components/schedule/FieldTripDrawer'
```

Add `showFieldTripDrawer` state alongside `stampMode` (already added in Task 7):

```js
  const [showFieldTripDrawer, setShowFieldTripDrawer] = useState(false)
```

- [ ] **Step 3: Add the drawer button to the controls bar**

In the controls bar (inside `{hasSchedule && (<> ... </>)}`), add the Field Trips button after the Export to Excel button:

```jsx
            <button
              onClick={() => setShowFieldTripDrawer(v => !v)}
              style={{
                padding: '6px 14px',
                border: `1px solid ${showFieldTripDrawer || stampMode ? '#f59e0b' : 'var(--border)'}`,
                borderRadius: 6,
                background: showFieldTripDrawer || stampMode ? '#f59e0b18' : 'var(--surface)',
                color: showFieldTripDrawer || stampMode ? '#92400e' : 'var(--text)',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Field Trips {stampMode ? `· ${stampMode}` : ''}
            </button>
```

- [ ] **Step 4: Render FieldTripDrawer at the bottom of the ScheduleScreen return**

Just before the closing `</div>` of the main return (after the Flag legend block), add:

```jsx
      <FieldTripDrawer
        isOpen={showFieldTripDrawer}
        onClose={() => setShowFieldTripDrawer(false)}
        activeStamp={stampMode}
        onSelectStamp={label => {
          setStampMode(label)
          if (label) setShowFieldTripDrawer(false)
        }}
      />
```

- [ ] **Step 5: Verify stamp mode works end-to-end**

```bash
npm run dev
```

1. Generate a schedule (or have one loaded)
2. Click "Field Trips" button — drawer slides in from the right
3. Click "Field Trip" stamp — drawer closes, stamp mode banner shows in the controls area
4. Click any schedule slot in Group View or Day View — an amber "Field Trip" overlay appears
5. Click the amber cell — remove button appears
6. Click "✕ Remove" — overlay disappears, underlying schedule reappears

- [ ] **Step 6: Commit**

```bash
git add src/components/schedule/FieldTripDrawer.jsx src/screens/ScheduleScreen.jsx
git commit -m "feat: add FieldTripDrawer pull panel with stamp mode for placing overlays"
```

---

## Task 9: Fill Handle — Extend Overlay via Pointer Drag

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

The fill handle (already rendered by OverlayCell) lets users drag downward to extend an overlay to cover more time blocks. The `fillState` and `handleFillEnter` infrastructure was added in Task 7. This task wires up the preview rendering so users see the extension live during the drag.

- [ ] **Step 1: Update fillState shape to include previewToOrder**

The `fillState` is currently `{ overlayId }`. Update `startFill` to also store `previewToOrder`:

**Find `startFill` in ScheduleScreen and replace:**
```js
  function startFill(overlay) {
    setFillState({ overlayId: overlay.id, previewToOrder: overlay.to_block_order })
  }
```

- [ ] **Step 2: Update `handleFillEnter` to track previewToOrder**

The `handleFillEnter` already sets `previewToOrder`. Ensure the logic is correct:

```js
  function handleFillEnter(blockSortOrder) {
    if (!fillState) return
    const overlay = overlays.find(o => o.id === fillState.overlayId)
    if (!overlay) return
    if (blockSortOrder >= overlay.from_block_order) {
      setFillState(prev => ({ ...prev, previewToOrder: blockSortOrder }))
    }
  }
```

- [ ] **Step 3: Update `commitFill` to use previewToOrder**

```js
  async function commitFill() {
    if (!fillState) { setFillState(null); return }
    const previewTo = fillState.previewToOrder
    if (previewTo !== undefined) {
      const overlay = overlays.find(o => o.id === fillState.overlayId)
      if (overlay && previewTo !== overlay.to_block_order) {
        await updateOverlayRange(fillState.overlayId, previewTo)
      }
    }
    setFillState(null)
  }
```

- [ ] **Step 4: Update overlay rendering to use fillState preview**

In the `overlayForCell` function, the overlay lookup uses `overlays` state. During a fill drag, we want the preview range to show. Update the `overlayForCell` helper to use `fillState.previewToOrder` when the overlay is the one being dragged:

```js
  function overlayForCell(groupId, dayId, blockId) {
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return null
    return overlays.find(o => {
      const effectiveTo = (fillState?.overlayId === o.id && fillState.previewToOrder !== undefined)
        ? fillState.previewToOrder
        : o.to_block_order
      return (
        o.unit_id === group.tier_id &&
        o.day_id === dayId &&
        block.sort_order >= o.from_block_order &&
        block.sort_order <= effectiveTo
      )
    }) || null
  }
```

Also update `getOverlayRowSpan` to use the same effective `to_block_order`:

```js
  function getOverlayRowSpan(overlay) {
    const effectiveTo = (fillState?.overlayId === overlay.id && fillState.previewToOrder !== undefined)
      ? fillState.previewToOrder
      : overlay.to_block_order
    return effectiveTo - overlay.from_block_order + 1
  }
```

And update `isOverlayHead` to use the same helper (it calls `overlayForCell` so it's already correct).

- [ ] **Step 5: Show fill handle on the last visible row of the overlay during drag**

In Task 7, the group view passes `isLastRow` to `showFillHandle`. Update that calculation to use the effective `to_block_order`:

In the group view `overlayForCell` check block:
```jsx
                          if (overlay && isOverlayHead(selectedGroup, day.id, block.id)) {
                            const rowSpan = getOverlayRowSpan(overlay)
                            const effectiveTo = (fillState?.overlayId === overlay.id && fillState.previewToOrder !== undefined)
                              ? fillState.previewToOrder
                              : overlay.to_block_order
                            const isLastRow = block.sort_order === effectiveTo
                            return (
                              <OverlayCell
                                key={day.id}
                                label={overlay.label}
                                rowSpan={rowSpan}
                                onRemove={() => removeOverlay(overlay.id)}
                                showFillHandle={true}
                                fillHandleDirection="vertical"
                                onFillStart={() => startFill(overlay)}
                              />
                            )
                          }
```

(The `showFillHandle` is always `true` here because the rowSpan cell IS the last visible row.)

- [ ] **Step 6: Verify fill handle end-to-end**

```bash
npm run dev
```

1. Generate a schedule
2. Enter stamp mode and click a slot — 1-block amber overlay appears
3. The fill handle (small amber square) appears at the bottom center (group view) or bottom-right corner (day view)
4. Pointer-down on the fill handle, drag downward over subsequent rows — the overlay cell grows to cover the hovered rows in real time
5. Release pointer — the overlay commits to its new size, persisted to Supabase

- [ ] **Step 7: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: fill handle drag to extend overlay block range with live preview"
```

---

## Post-Implementation

After all 9 tasks pass their reviews, run the full test suite:

```bash
npm test
```

Then use `superpowers:webapp-testing` (Playwright) to verify the end-to-end flows:
1. Anchor with `span_blocks=2` generates merged cells
2. Field trip stamp places an overlay
3. Remove button deletes overlay and restores underlying slot
4. Fill handle extends overlay to multiple blocks
5. Snapshot save/restore preserves overlays

Then use `superpowers:finishing-a-development-branch` to complete the branch.
