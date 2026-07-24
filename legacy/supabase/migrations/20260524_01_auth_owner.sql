-- Link each camp to its owner in auth.users
ALTER TABLE camps ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id);

-- Helper: returns the camp_id owned by the currently authenticated user.
-- Used by all RLS policies so they don't repeat the subquery.
CREATE OR REPLACE FUNCTION get_my_camp_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM camps WHERE owner_user_id = auth.uid() LIMIT 1
$$;
