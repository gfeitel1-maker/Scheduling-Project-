-- Add missing foreign key constraint for template_overlays.unit_id
-- This matches the pattern in anchor_activities.unit_id (ON DELETE SET NULL)
-- When a tier is deleted, its overlays lose their unit reference.

ALTER TABLE template_overlays
  ALTER COLUMN unit_id DROP NOT NULL,
  ADD CONSTRAINT template_overlays_unit_fk
    FOREIGN KEY (unit_id) REFERENCES tiers(id) ON DELETE SET NULL;
