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
