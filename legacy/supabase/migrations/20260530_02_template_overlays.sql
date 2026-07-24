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
