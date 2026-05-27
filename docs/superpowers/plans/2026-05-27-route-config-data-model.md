# Route Config Data Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the cohort layer to the schema (camp → cohort → tier → group), day-type override tables, span_blocks/is_span_head columns, and update buildSchedule.js to accept the new cohorts-array signature with backward compat.

**Architecture:** Five additive migrations on the local Supabase project (in `shoresh/supabase/migrations/`) followed by engine changes in `Scheduling-Project-/src/engine/buildSchedule.js`. All migrations are additive — no existing data is removed. The engine gains a new cohorts-array signature but continues accepting the old flat signature for backward compatibility, routing both through identical scheduling logic.

**Tech Stack:** PostgreSQL 17 (Supabase local via OrbStack), Vitest, plain JS (no framework in engine)

---

## File Map

| File | Action | What changes |
|---|---|---|
| `shoresh/supabase/migrations/20260527010000_add_cohorts.sql` | Create | `cohorts` table; nullable `cohort_id` FK on `tiers`, `time_blocks`, `anchor_activities` |
| `shoresh/supabase/migrations/20260527020000_add_span_columns.sql` | Create | `activities.span_blocks`; `schedule_slots.is_span_head`; `template_slots.is_span_head` |
| `shoresh/supabase/migrations/20260527030000_add_day_override_tables.sql` | Create | `day_override_templates`, `day_override_template_slots`, `schedule_day_overrides` |
| `shoresh/supabase/migrations/20260527040000_rls_new_tables.sql` | Create | RLS enable + policies for all new/modified tables |
| `shoresh/supabase/migrations/20260527050000_migrate_to_cohorts.sql` | Create | Insert one default cohort per camp; backfill `cohort_id`; add NOT NULL constraints |
| `Scheduling-Project-/src/engine/buildSchedule.js` | Modify | New cohorts-array signature, span_blocks placement, is_span_head output, conflicts output |
| `Scheduling-Project-/src/engine/buildSchedule.test.js` | Modify | Tests for cohorts wrapper, span_blocks, is_span_head, conflicts output |

---

### Task 1: Migration — cohorts table + nullable FK columns

**Files:**
- Create: `shoresh/supabase/migrations/20260527010000_add_cohorts.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 20260527010000_add_cohorts.sql
-- Creates the cohorts table and adds nullable cohort_id to tiers,
-- time_blocks, and anchor_activities. NOT NULL enforced in migration 05.

CREATE TABLE IF NOT EXISTS cohorts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id            uuid NOT NULL REFERENCES camps(id),
  name               text NOT NULL,
  session_week_start integer NOT NULL DEFAULT 1,
  session_week_end   integer NOT NULL DEFAULT 1,
  capacity_source    text NOT NULL DEFAULT 'groups_per_slot'
    CHECK (capacity_source IN ('groups_per_slot', 'camper_headcount')),
  anchor_model       text NOT NULL DEFAULT 'none'
    CHECK (anchor_model IN ('none', 'fixed', 'floating')),
  sort_order         integer DEFAULT 0,
  created_at         timestamptz DEFAULT now()
);

-- Nullable for now — NOT NULL added after data backfill in migration 05
ALTER TABLE tiers ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES cohorts(id);
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES cohorts(id);
ALTER TABLE anchor_activities ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES cohorts(id);
```

- [ ] **Step 2: Apply the migration**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db reset
```

Expected: `supabase db reset` completes with no errors. (This replays all migrations from scratch.)

- [ ] **Step 3: Verify the table exists**

```bash
supabase db query "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'cohorts' ORDER BY ordinal_position;"
```

Expected output includes: `id`, `camp_id`, `name`, `session_week_start`, `session_week_end`, `capacity_source`, `anchor_model`, `sort_order`, `created_at`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
git add supabase/migrations/20260527010000_add_cohorts.sql
git commit -m "feat: add cohorts table and nullable cohort_id FK columns"
```

---

### Task 2: Migration — span_blocks and is_span_head columns

**Files:**
- Create: `shoresh/supabase/migrations/20260527020000_add_span_columns.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 20260527020000_add_span_columns.sql
-- Adds span_blocks to activities (how many consecutive blocks an activity
-- occupies) and is_span_head to slot tables (distinguishes the first block
-- of a multi-block placement from subsequent tail blocks).

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS span_blocks integer NOT NULL DEFAULT 1
    CHECK (span_blocks >= 1);

ALTER TABLE schedule_slots
  ADD COLUMN IF NOT EXISTS is_span_head boolean NOT NULL DEFAULT true;

ALTER TABLE template_slots
  ADD COLUMN IF NOT EXISTS is_span_head boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: Apply via reset**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db reset
```

Expected: completes with no errors.

- [ ] **Step 3: Verify columns**

```bash
supabase db query "SELECT column_name, data_type FROM information_schema.columns WHERE table_name IN ('activities','schedule_slots','template_slots') AND column_name IN ('span_blocks','is_span_head') ORDER BY table_name, column_name;"
```

Expected: 3 rows — `activities.span_blocks`, `schedule_slots.is_span_head`, `template_slots.is_span_head`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
git add supabase/migrations/20260527020000_add_span_columns.sql
git commit -m "feat: add span_blocks to activities and is_span_head to slot tables"
```

---

### Task 3: Migration — day override tables

**Files:**
- Create: `shoresh/supabase/migrations/20260527030000_add_day_override_tables.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 20260527030000_add_day_override_tables.sql
-- Adds three tables for week-to-week day exceptions (field trips, color war, etc.).
-- day_override_templates: named reusable config per cohort
-- day_override_template_slots: which blocks get which activities (null = clear block)
-- schedule_day_overrides: apply a template to a specific date in a specific schedule run

CREATE TABLE IF NOT EXISTS day_override_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id        uuid NOT NULL REFERENCES camps(id),
  cohort_id      uuid NOT NULL REFERENCES cohorts(id),
  name           text NOT NULL,
  frequency_mode text NOT NULL DEFAULT 'reduced'
    CHECK (frequency_mode IN ('reduced', 'best_effort')),
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS day_override_template_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES day_override_templates(id),
  time_block_id uuid NOT NULL REFERENCES time_blocks(id),
  activity_id   uuid REFERENCES activities(id)  -- NULL means clear / free this block
);

CREATE TABLE IF NOT EXISTS schedule_day_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id       uuid NOT NULL REFERENCES camps(id),
  schedule_id   uuid NOT NULL REFERENCES schedules(id),
  override_date date NOT NULL,
  template_id   uuid NOT NULL REFERENCES day_override_templates(id)
);
```

- [ ] **Step 2: Apply via reset**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db reset
```

Expected: completes with no errors.

- [ ] **Step 3: Verify tables**

```bash
supabase db query "SELECT table_name FROM information_schema.tables WHERE table_name IN ('day_override_templates','day_override_template_slots','schedule_day_overrides') ORDER BY table_name;"
```

Expected: 3 rows.

- [ ] **Step 4: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
git add supabase/migrations/20260527030000_add_day_override_tables.sql
git commit -m "feat: add day override tables for week-to-week schedule exceptions"
```

---

### Task 4: Migration — RLS for new tables

**Files:**
- Create: `shoresh/supabase/migrations/20260527040000_rls_new_tables.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 20260527040000_rls_new_tables.sql
-- Enables RLS and adds isolation policies for all new tables.
-- All policies use the existing get_my_camp_id() helper.

-- cohorts: direct camp_id check
ALTER TABLE cohorts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cohorts_camp_isolation" ON cohorts
  FOR ALL USING (camp_id = get_my_camp_id());

-- day_override_templates: direct camp_id check
ALTER TABLE day_override_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "day_override_templates_camp_isolation" ON day_override_templates
  FOR ALL USING (camp_id = get_my_camp_id());

-- day_override_template_slots: no camp_id column — join through template
ALTER TABLE day_override_template_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "day_override_template_slots_camp_isolation" ON day_override_template_slots
  FOR ALL USING (
    template_id IN (
      SELECT id FROM day_override_templates
      WHERE camp_id = get_my_camp_id()
    )
  );

-- schedule_day_overrides: direct camp_id check
ALTER TABLE schedule_day_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schedule_day_overrides_camp_isolation" ON schedule_day_overrides
  FOR ALL USING (camp_id = get_my_camp_id());
```

- [ ] **Step 2: Apply via reset**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db reset
```

Expected: completes with no errors.

- [ ] **Step 3: Verify RLS is enabled**

```bash
supabase db query "SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('cohorts','day_override_templates','day_override_template_slots','schedule_day_overrides') ORDER BY tablename;"
```

Expected: all 4 rows show `rowsecurity = true`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
git add supabase/migrations/20260527040000_rls_new_tables.sql
git commit -m "feat: add RLS policies for cohorts and day override tables"
```

---

### Task 5: Migration — backfill existing data to default cohort

**Files:**
- Create: `shoresh/supabase/migrations/20260527050000_migrate_to_cohorts.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 20260527050000_migrate_to_cohorts.sql
-- Creates one default "Main" cohort per existing camp, then backfills
-- cohort_id on tiers, time_blocks, and anchor_activities.
-- Finally adds NOT NULL constraints now that all rows are populated.

-- Step 1: one default cohort per camp
INSERT INTO cohorts (camp_id, name, session_week_start, session_week_end, capacity_source, anchor_model)
SELECT id, 'Main', 1, 1, 'groups_per_slot', 'fixed'
FROM camps;

-- Step 2: backfill tiers
UPDATE tiers t
SET cohort_id = c.id
FROM cohorts c
WHERE c.camp_id = t.camp_id;

ALTER TABLE tiers ALTER COLUMN cohort_id SET NOT NULL;

-- Step 3: backfill time_blocks
UPDATE time_blocks tb
SET cohort_id = c.id
FROM cohorts c
WHERE c.camp_id = tb.camp_id;

ALTER TABLE time_blocks ALTER COLUMN cohort_id SET NOT NULL;

-- Step 4: backfill anchor_activities
UPDATE anchor_activities aa
SET cohort_id = c.id
FROM cohorts c
WHERE c.camp_id = aa.camp_id;

ALTER TABLE anchor_activities ALTER COLUMN cohort_id SET NOT NULL;
```

- [ ] **Step 2: Apply via reset**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db reset
```

Expected: completes with no errors.

- [ ] **Step 3: Verify backfill and NOT NULL**

```bash
supabase db query "SELECT COUNT(*) AS cohort_count FROM cohorts;"
```

Expected: one row per camp in the database (at least 1).

```bash
supabase db query "SELECT COUNT(*) FROM tiers WHERE cohort_id IS NULL;"
```

Expected: `0`.

```bash
supabase db query "SELECT COUNT(*) FROM time_blocks WHERE cohort_id IS NULL;"
```

Expected: `0`.

```bash
supabase db query "SELECT COUNT(*) FROM anchor_activities WHERE cohort_id IS NULL;"
```

Expected: `0`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
git add supabase/migrations/20260527050000_migrate_to_cohorts.sql
git commit -m "feat: backfill existing camps to single default cohort, add NOT NULL constraints"
```

---

### Task 6: Engine — tests first (cohorts wrapper, span_blocks, is_span_head)

**Files:**
- Modify: `Scheduling-Project-/src/engine/buildSchedule.test.js`

Write these failing tests before touching the engine implementation.

- [ ] **Step 1: Add the new tests to buildSchedule.test.js**

Add these describe blocks at the end of the existing test file. Do not remove any existing tests.

```js
// ── Helpers shared by new tests ──────────────────────────────────────────────

const baseAct = {
  id: 'a1', name: 'Drama', priority: 'low',
  max_per_week: 5, min_per_week: 0,
  span_blocks: 1,
  is_outdoor: false, location: null, max_groups_per_slot: 1,
  same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [],
  prefer_before_day: null, prefer_before_day_min: null,
}

const blockA = { id: 'bA', name: 'Block A', start_time: '09:00', end_time: '09:45', sort_order: 0, part_of_day: 'morning' }
const blockB = { id: 'bB', name: 'Block B', start_time: '09:50', end_time: '10:35', sort_order: 1, part_of_day: 'morning' }
const blockC = { id: 'bC', name: 'Block C', start_time: '10:40', end_time: '11:25', sort_order: 2, part_of_day: 'morning' }

function cohortInput(overrides = {}) {
  return {
    cohorts: [{
      cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
      timeBlocks: [blockA, blockB],
      tiers: [{ id: 't1', name: 'Junior' }],
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      preplacedSlots: [],
      activityTargets: null,
    }],
    days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
    activities: [baseAct],
    campId: 'test',
    ...overrides,
  }
}

// ── Cohorts wrapper ───────────────────────────────────────────────────────────

describe('cohorts array signature', () => {
  it('produces the same output as the legacy flat signature for a single cohort', () => {
    const legacyResult = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'Junior' }],
      days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      timeBlocks: [blockA],
      activities: [{ ...baseAct }],
      anchors: [],
      campId: 'test',
      preplacedSlots: [],
    })

    const cohortResult = buildSchedule({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      activities: [{ ...baseAct }],
      campId: 'test',
    })

    // Same slots shape (modulo cohort_id field which is new)
    expect(cohortResult.slots.length).toBe(legacyResult.slots.length)
    expect(cohortResult.slots[0].activityId).toBe(legacyResult.slots[0].activityId)
  })

  it('returns a conflicts array (empty for single-cohort)', () => {
    const result = buildSchedule(cohortInput())
    expect(Array.isArray(result.conflicts)).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('slots include cohort_id from the cohort entry', () => {
    const result = buildSchedule(cohortInput())
    const actSlot = result.slots.find(s => s.type === 'activity')
    expect(actSlot?.cohort_id).toBe('cohort1')
  })
})

// ── span_blocks ───────────────────────────────────────────────────────────────

describe('span_blocks', () => {
  it('places a span_blocks=2 activity into two consecutive blocks', () => {
    const swimAct = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }
    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swimAct],
    }))

    const swimSlots = result.slots.filter(s => s.activityId === 'swim')
    expect(swimSlots).toHaveLength(2)
    expect(swimSlots.map(s => s.blockId).sort()).toEqual(['bA', 'bB'].sort())
  })

  it('marks only the first block as is_span_head=true', () => {
    const swimAct = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }
    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swimAct],
    }))

    const swimSlots = result.slots
      .filter(s => s.activityId === 'swim')
      .sort((a, b) => {
        const order = { bA: 0, bB: 1, bC: 2 }
        return order[a.blockId] - order[b.blockId]
      })

    expect(swimSlots[0].is_span_head).toBe(true)
    expect(swimSlots[1].is_span_head).toBe(false)
  })

  it('does not place a span_blocks=2 activity when the second block is occupied', () => {
    // Two activities: Drama (span=2) and Archery (span=1).
    // Archery is preplaced in blockB, so Drama cannot start at blockA.
    const drama = { ...baseAct, id: 'drama', name: 'Drama', span_blocks: 2, priority: 'low' }
    const archery = { ...baseAct, id: 'arch', name: 'Archery', span_blocks: 1, priority: 'high' }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'bB', activityId: 'arch' }]

    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: preplaced,
        activityTargets: null,
      }],
      activities: [drama, archery],
    }))

    // drama must not appear since blockB is taken and there's no room to start a 2-block span
    const dramaSlots = result.slots.filter(s => s.activityId === 'drama')
    expect(dramaSlots).toHaveLength(0)
  })

  it('does not place a span_blocks=2 activity when only one block remains', () => {
    // Only blockC available (blockA and blockB occupied). span=2 requires 2 consecutive.
    const swim = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }

    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockC],   // only one block available
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swim],
    }))

    const swimSlots = result.slots.filter(s => s.activityId === 'swim')
    expect(swimSlots).toHaveLength(0)
  })

  it('single-block activities still have is_span_head=true', () => {
    const result = buildSchedule(cohortInput())
    const actSlot = result.slots.find(s => s.type === 'activity' && s.activityId)
    expect(actSlot?.is_span_head).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm test -- src/engine/buildSchedule.test.js
```

Expected: multiple failures — `cohorts array signature`, `span_blocks` tests all fail because the engine doesn't yet accept these inputs.

---

### Task 7: Engine — implement cohorts signature + span_blocks

**Files:**
- Modify: `Scheduling-Project-/src/engine/buildSchedule.js`

Replace the entire file with the updated version below. The core scheduling logic is unchanged — only the input normalization, span_blocks reservation, and output shape change.

- [ ] **Step 1: Replace buildSchedule.js**

```js
// Pure function — zero React dependencies, zero Supabase calls.
//
// Supports two call signatures:
//
//   NEW (multi-cohort):
//   buildSchedule({ cohorts, days, activities, campId })
//   where cohorts = [{ cohort, timeBlocks, tiers, groups, preplacedSlots, activityTargets }]
//
//   LEGACY (single-cohort, backward compat):
//   buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })
//
// Output: { slots, stats, conflicts }
//   slots     — array of scheduled slot objects (cohort_id and is_span_head added)
//   stats     — coverage stats
//   conflicts — cross-cohort resource conflicts (always [] until multi-cohort engine in Sub-project 3)

function djb2(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// Normalize both call signatures into the cohorts-array format.
function normalizeInput(input) {
  if (input.cohorts) {
    // New multi-cohort signature — pass through as-is
    return {
      cohorts: input.cohorts,
      days: input.days,
      activities: input.activities,
      campId: input.campId || '',
    }
  }
  // Legacy flat signature — wrap in a single-cohort array
  return {
    cohorts: [{
      cohort: { id: null, anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
      timeBlocks: input.timeBlocks || [],
      tiers: input.tiers || [],
      groups: input.groups || [],
      preplacedSlots: input.preplacedSlots || [],
      activityTargets: null,
      // Legacy anchors are resolved to preplaced-style objects inside scheduleCohort
      _legacyAnchors: input.anchors || [],
    }],
    days: input.days || [],
    activities: input.activities || [],
    campId: input.campId || '',
  }
}

function scheduleCohort({ cohortEntry, days, activities, rand }) {
  const { cohort, timeBlocks, tiers, groups, preplacedSlots, activityTargets, _legacyAnchors } = cohortEntry
  const cohortId = cohort?.id ?? null

  // Sort time blocks by sort_order so span_blocks consecutive logic is stable
  const timeBlocksSorted = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
  const blockOrder = new Map(timeBlocksSorted.map((b, i) => [b.id, i]))

  // ── Pass 0: resolve eligibility ──────────────────────────────────────────
  const eligibility = new Map() // activityId → Set<groupId>
  for (const act of activities) {
    const tierIds = act.eligible_tier_ids || []
    const groupIds = act.eligible_group_ids || []
    let eligible = new Set()
    if (tierIds.length === 0 && groupIds.length === 0) {
      for (const g of groups) eligible.add(g.id)
    } else {
      if (tierIds.length > 0) {
        const tierSet = new Set(tierIds)
        for (const g of groups) {
          if (tierSet.has(g.tier_id)) eligible.add(g.id)
        }
      }
      for (const gid of groupIds) eligible.add(gid)
    }
    eligibility.set(act.id, eligible)
  }

  // ── Pass 1: map the grid ──────────────────────────────────────────────────
  // Build anchor lookup from legacy anchors (flat signature) or preplacedSlots
  const anchorLookup = new Map() // "groupId|dayId|blockId" → anchor
  const anchors = _legacyAnchors || []
  for (const anchor of anchors) {
    const groupList = anchor.is_all_groups ? groups.map(g => g.id) : (anchor.group_ids || [])
    for (const gid of groupList) {
      anchorLookup.set(`${gid}|${anchor.day_id}|${anchor.time_block_id}`, anchor)
    }
  }

  const groupMap = new Map(groups.map(g => [g.id, g]))
  const slots = []
  const openSlots = []

  for (const group of groups) {
    for (const day of days) {
      for (const block of timeBlocksSorted) {
        const key = `${group.id}|${day.id}|${block.id}`
        const anchor = anchorLookup.get(key)

        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'anchor', activityId: null, anchorId: anchor.id, is_span_head: true, flags: {} })
          continue
        }

        const avail = group.availability
        const pod = block.part_of_day
        if (avail !== 'all' && avail !== pod) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'unavailable', activityId: null, anchorId: null, is_span_head: true, flags: {} })
          continue
        }

        const eligibleActs = activities.filter(a => (eligibility.get(a.id) || new Set()).has(group.id))
        openSlots.push({ groupId: group.id, dayId: day.id, blockId: block.id, eligibleActs })
      }
    }
  }

  // ── Pass 2: place activities ──────────────────────────────────────────────
  const assigned = new Map() // "groupId|dayId|blockId" → activityId
  const spanTails = new Set() // keys for tail blocks of multi-block placements
  const usageCount = new Map() // "groupId|activityId" → count
  const locationUsage = new Map() // "location|dayId|blockId" → [{ groupId, tierId }]

  function getCount(groupId, actId) {
    return usageCount.get(`${groupId}|${actId}`) || 0
  }

  function incCount(groupId, actId) {
    const k = `${groupId}|${actId}`
    usageCount.set(k, (usageCount.get(k) || 0) + 1)
  }

  function locationKey(location, dayId, blockId) { return `${location}|${dayId}|${blockId}` }

  function canPlace(act, groupId, dayId, blockId) {
    if (getCount(groupId, act.id) >= act.max_per_week) return false

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      if (blockIdx === undefined) return false
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (!nextBlock) return false  // not enough blocks remaining
        const nextKey = `${groupId}|${dayId}|${nextBlock.id}`
        if (assigned.has(nextKey) || anchorLookup.has(nextKey)) return false
      }
    }

    if (act.location && act.max_groups_per_slot > 1) {
      const lk = locationKey(act.location, dayId, blockId)
      const occupants = locationUsage.get(lk) || []
      if (occupants.length >= act.max_groups_per_slot) return false
      const group = groupMap.get(groupId)
      if (act.same_tier_only && occupants.length > 0) {
        const allSameTier = occupants.every(o => o.tierId === group.tier_id)
        if (!allSameTier) return false
      }
    } else if (act.location && act.max_groups_per_slot === 1) {
      const lk = locationKey(act.location, dayId, blockId)
      if ((locationUsage.get(lk) || []).length >= 1) return false
    }

    return true
  }

  function place(act, groupId, dayId, blockId) {
    const headKey = `${groupId}|${dayId}|${blockId}`
    assigned.set(headKey, act.id)
    incCount(groupId, act.id)  // count once per placement (head only)

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (nextBlock) {
          const tailKey = `${groupId}|${dayId}|${nextBlock.id}`
          assigned.set(tailKey, act.id)
          spanTails.add(tailKey)
          // Track location usage for tail blocks too
          if (act.location) {
            const lk = locationKey(act.location, dayId, nextBlock.id)
            const group = groupMap.get(groupId)
            const list = locationUsage.get(lk) || []
            list.push({ groupId, tierId: group.tier_id })
            locationUsage.set(lk, list)
          }
        }
      }
    }

    if (act.location) {
      const lk = locationKey(act.location, dayId, blockId)
      const group = groupMap.get(groupId)
      const list = locationUsage.get(lk) || []
      list.push({ groupId, tierId: group.tier_id })
      locationUsage.set(lk, list)
    }
  }

  // Pre-place locked slots (anchors from new signature + any explicit preplacedSlots)
  for (const pre of (preplacedSlots || [])) {
    const key = `${pre.groupId}|${pre.dayId}|${pre.blockId}`
    if (!assigned.has(key)) {
      const act = activities.find(a => a.id === pre.activityId)
      if (act) place(act, pre.groupId, pre.dayId, pre.blockId)
    }
  }

  const dayOrder = new Map(days.map((d, i) => [d.id, i]))

  function scoreForPrefer(act, groupId, dayId) {
    if (act.prefer_before_day == null || act.prefer_before_day_min == null) return 0
    const dayIdx = dayOrder.get(dayId)
    const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
    if (targetIdx < 0) return 0
    const countSoFar = getCount(groupId, act.id)
    if (countSoFar < act.prefer_before_day_min && dayIdx >= targetIdx) return 1
    return 0
  }

  function runRound(slotsToFill, priority) {
    const roundSlots = slotsToFill.filter(s => {
      const acts = s.eligibleActs.filter(a => a.priority === priority)
      return acts.some(a => canPlace(a, s.groupId, s.dayId, s.blockId))
    })
    roundSlots.sort((a, b) => {
      const aCount = a.eligibleActs.filter(x => x.priority === priority && canPlace(x, a.groupId, a.dayId, a.blockId)).length
      const bCount = b.eligibleActs.filter(x => x.priority === priority && canPlace(x, b.groupId, b.dayId, b.blockId)).length
      return aCount - bCount
    })
    for (const slot of roundSlots) {
      if (assigned.has(`${slot.groupId}|${slot.dayId}|${slot.blockId}`)) continue
      let candidates = slot.eligibleActs
        .filter(a => a.priority === priority && canPlace(a, slot.groupId, slot.dayId, slot.blockId))
      if (!candidates.length) continue
      const normal = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) === 0)
      const deferred = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) !== 0)
      const ordered = [...normal, ...deferred]
      ordered.sort((a, b) => {
        const diff = getCount(slot.groupId, a.id) - getCount(slot.groupId, b.id)
        return diff !== 0 ? diff : rand() - 0.5
      })
      place(ordered[0], slot.groupId, slot.dayId, slot.blockId)
    }
  }

  const unfilledSlots = openSlots.filter(s => !assigned.has(`${s.groupId}|${s.dayId}|${s.blockId}`))
  runRound(unfilledSlots, 'high')
  const stillUnfilled = openSlots.filter(s => !assigned.has(`${s.groupId}|${s.dayId}|${s.blockId}`))
  runRound(stillUnfilled, 'low')

  // ── Pass 3: audit ─────────────────────────────────────────────────────────
  const resultSlots = []

  for (const slot of slots) {
    resultSlots.push({ ...slot })
  }

  for (const os of openSlots) {
    const key = `${os.groupId}|${os.dayId}|${os.blockId}`
    const actId = assigned.get(key) || null
    const isSpanHead = !spanTails.has(key)
    const flags = {}

    if (!actId) {
      flags.UNFILLABLE = true
      flags.UNFILLABLE_reason = 'No eligible activity could be placed in this slot'
    } else {
      const act = activities.find(a => a.id === actId)
      if (act?.is_outdoor) {
        flags.WEATHER_RISK = true
        flags.WEATHER_RISK_reason = 'Outdoor activity scheduled in this slot'
      }
    }

    resultSlots.push({ groupId: os.groupId, dayId: os.dayId, blockId: os.blockId, cohort_id: cohortId, type: 'activity', activityId: actId, anchorId: null, is_span_head: isSpanHead, flags })
  }

  // Resolve activityTargets: caller may supply scaled min/max for override weeks
  function getMin(actId) {
    if (activityTargets?.[actId]?.min_per_week != null) return activityTargets[actId].min_per_week
    return activities.find(a => a.id === actId)?.min_per_week ?? 0
  }

  // UNDERSERVED
  const underserved = []
  for (const group of groups) {
    for (const act of activities) {
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      if (getMin(act.id) <= 0) continue
      if (getCount(group.id, act.id) < getMin(act.id)) {
        underserved.push({ groupId: group.id, activityId: act.id, got: getCount(group.id, act.id), needed: getMin(act.id) })
      }
    }
  }

  for (const u of underserved) {
    const groupName = groupMap.get(u.groupId)?.name || u.groupId
    const act = activities.find(a => a.id === u.activityId)
    const actName = act?.name || u.activityId
    const reason = `Goal: ${u.needed}×/wk — scheduled ${u.got}× (group: ${groupName}, activity: ${actName})`
    for (const slot of resultSlots) {
      if (slot.type === 'activity' && slot.groupId === u.groupId && slot.activityId === u.activityId) {
        slot.flags = { ...slot.flags, UNDERSERVED: true, UNDERSERVED_reason: reason }
      }
    }
  }

  // DISTRIBUTION
  for (const group of groups) {
    for (const act of activities) {
      if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
      if (targetIdx < 0) continue
      const beforeCount = resultSlots.filter(s =>
        s.type === 'activity' && s.groupId === group.id && s.activityId === act.id &&
        (dayOrder.get(s.dayId) ?? 99) < targetIdx
      ).length
      if (beforeCount < act.prefer_before_day_min) {
        const reason = `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} — only ${beforeCount}× placed (group: ${group.name}, activity: ${act.name})`
        for (const slot of resultSlots) {
          if (slot.type === 'activity' && slot.groupId === group.id && slot.activityId === act.id) {
            slot.flags = { ...slot.flags, DISTRIBUTION: true, DISTRIBUTION_reason: reason }
          }
        }
      }
    }
  }

  const openCount = resultSlots.filter(s => s.type === 'activity').length
  const filledCount = resultSlots.filter(s => s.type === 'activity' && s.activityId).length
  const unfillableCount = resultSlots.filter(s => s.flags?.UNFILLABLE).length
  const underservedCount = new Set(underserved.map(u => `${u.groupId}|${u.activityId}`)).size
  const totalFlags = resultSlots.reduce((sum, s) =>
    sum + Object.keys(s.flags || {}).filter(k => !k.includes('_')).length, 0)

  return {
    slots: resultSlots,
    stats: { openCount, filledCount, unfillableCount, underservedCount, totalFlags },
  }
}

function buildSchedule(input) {
  const { cohorts, days, activities, campId } = normalizeInput(input)
  const rand = mulberry32(djb2(campId))

  // Pass 1: schedule each cohort independently
  // (multi-cohort cross-resource conflict detection is Sub-project 3)
  const allSlots = []
  const allStats = []

  for (const cohortEntry of cohorts) {
    const { slots, stats } = scheduleCohort({ cohortEntry, days, activities, rand })
    allSlots.push(...slots)
    allStats.push(stats)
  }

  // Combine stats across cohorts
  const combined = allStats.reduce((acc, s) => ({
    openCount: acc.openCount + s.openCount,
    filledCount: acc.filledCount + s.filledCount,
    unfillableCount: acc.unfillableCount + s.unfillableCount,
    underservedCount: acc.underservedCount + s.underservedCount,
    totalFlags: acc.totalFlags + s.totalFlags,
  }), { openCount: 0, filledCount: 0, unfillableCount: 0, underservedCount: 0, totalFlags: 0 })

  return {
    slots: allSlots,
    stats: cohorts.length === 1 ? allStats[0] : { ...combined, per_cohort: allStats },
    conflicts: [], // Sub-project 3: cross-cohort conflict detection
  }
}

export default buildSchedule
```

- [ ] **Step 2: Run the full test suite**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm test -- src/engine/buildSchedule.test.js
```

Expected: ALL tests pass, including existing tests (backward compat) and all new cohorts + span_blocks tests.

- [ ] **Step 3: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/engine/buildSchedule.js src/engine/buildSchedule.test.js
git commit -m "feat: add cohorts-array signature, span_blocks support, is_span_head to buildSchedule"
```

---

### Task 8: Smoke test — app still loads

Verify the migration + engine changes haven't broken the running app.

- [ ] **Step 1: Confirm local Supabase is running**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase status
```

Expected: `API URL: http://127.0.0.1:54321` with all services running.

- [ ] **Step 2: Start the dev server**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run dev
```

Expected: `VITE ready on http://localhost:5200`

- [ ] **Step 3: Verify app loads and login works**

Open http://localhost:5200. Log in with an existing account.

Expected: app loads to the main screen with no console errors. Schedule generation (if any camps have templates) still works.

- [ ] **Step 4: Verify cohort row was created for the camp**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/shoresh"
supabase db query "SELECT name, session_week_start, session_week_end, anchor_model FROM cohorts;"
```

Expected: one row with `name = 'Main'`, `session_week_start = 1`, `session_week_end = 1`.

---

## Self-Review Notes

- All spec sections covered: cohorts table ✓, tiers/time_blocks/anchor_activities FK ✓, span_blocks ✓, is_span_head ✓, day override tables ✓, RLS ✓, migration path ✓, engine contract ✓
- Legacy flat signature still works (Task 7 test validates this explicitly)
- `conflicts: []` stub satisfies spec output shape; full multi-cohort conflict detection is deferred to Sub-project 3 as specified
- `activityTargets` accepted but only used for `min_per_week` — `max_per_week` scaling deferred to Sub-project 3 (day override resolution not yet wired)
- `supabase db reset` is safe here because this is the local dev database only — no production data at risk
