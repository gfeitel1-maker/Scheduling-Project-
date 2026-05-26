-- Task 5: Add lock columns for activity-level slot locking
-- Run this in the Supabase SQL editor or via Supabase CLI

ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;
ALTER TABLE template_slots ADD COLUMN IF NOT EXISTS is_released boolean DEFAULT false;

-- Verify:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name IN ('activities', 'template_slots')
--   AND column_name IN ('is_locked', 'is_released');
