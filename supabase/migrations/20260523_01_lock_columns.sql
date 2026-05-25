-- Task 5: Add lock columns for activity-level slot locking
ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;
ALTER TABLE template_slots ADD COLUMN IF NOT EXISTS is_released boolean DEFAULT false;
