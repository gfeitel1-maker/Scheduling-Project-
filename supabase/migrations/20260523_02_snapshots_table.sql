-- Task 9: Create schedule_snapshots table for named schedule versions
CREATE TABLE IF NOT EXISTS schedule_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  name        text,
  is_auto     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  slots       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_snapshots_template_time_idx
  ON schedule_snapshots (template_id, created_at DESC);
