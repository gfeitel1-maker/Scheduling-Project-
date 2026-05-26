-- camps
ALTER TABLE camps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "camps_owner_select" ON camps FOR SELECT USING (owner_user_id = auth.uid());
CREATE POLICY "camps_owner_insert" ON camps FOR INSERT WITH CHECK (owner_user_id = auth.uid());
CREATE POLICY "camps_owner_update" ON camps FOR UPDATE USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

-- groups
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "groups_owner" ON groups FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- tiers
ALTER TABLE tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tiers_owner" ON tiers FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- days_of_operation
ALTER TABLE days_of_operation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "days_of_operation_owner" ON days_of_operation FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- time_blocks
ALTER TABLE time_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "time_blocks_owner" ON time_blocks FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- activities
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activities_owner" ON activities FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- anchor_activities
ALTER TABLE anchor_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anchor_activities_owner" ON anchor_activities FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- schedule_templates
ALTER TABLE schedule_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schedule_templates_owner" ON schedule_templates FOR ALL USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- template_slots (no direct camp_id)
ALTER TABLE template_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "template_slots_owner" ON template_slots FOR ALL
  USING ((SELECT camp_id FROM schedule_templates WHERE id = template_slots.template_id) = get_my_camp_id())
  WITH CHECK ((SELECT camp_id FROM schedule_templates WHERE id = template_slots.template_id) = get_my_camp_id());

-- schedule_snapshots (no direct camp_id)
ALTER TABLE schedule_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schedule_snapshots_owner" ON schedule_snapshots FOR ALL
  USING ((SELECT camp_id FROM schedule_templates WHERE id = schedule_snapshots.template_id) = get_my_camp_id())
  WITH CHECK ((SELECT camp_id FROM schedule_templates WHERE id = schedule_snapshots.template_id) = get_my_camp_id());
