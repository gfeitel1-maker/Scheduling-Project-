# Schedule Iteration Features Design Spec

**Date:** 2026-05-23

---

## Overview

Three features that make the schedule regeneration loop faster and more controllable for camp directors: flag explanations with dismissal, activity-level slot locking, and named schedule snapshots.

---

## Feature 1 — Flag Explainability + Dismissal

Directors can see *why* a flag was raised and dismiss it when the situation is intentional.

Flag key pattern:
```js
{ UNDERSERVED: true, UNDERSERVED_reason: "Goal: 3×/wk — 2 eligible blocks remain after anchors" }
{ UNFILLABLE: true, UNFILLABLE_reason: "No eligible groups available for this block" }
{ WEATHER_RISK: true, WEATHER_RISK_reason: "Outdoor activity scheduled during Weather mode" }
{ DISTRIBUTION: true, DISTRIBUTION_reason: "Activity appears in 4 consecutive blocks" }
```

---

## Feature 2 — Activity-Level Slot Locking

Directors can lock an activity so regeneration leaves its assignments in place.

```sql
ALTER TABLE activities ADD COLUMN is_locked boolean DEFAULT false;
ALTER TABLE template_slots ADD COLUMN is_released boolean DEFAULT false;
```

Locked slot visual: border 2px solid #E8A020, background #FFFBF0, amber corner triangle.

---

## Feature 3 — Named Schedule Snapshots

Auto-saves before every regeneration. Directors can name and restore any version.

```sql
CREATE TABLE schedule_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  name text,
  is_auto boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  slots jsonb NOT NULL
);
```
