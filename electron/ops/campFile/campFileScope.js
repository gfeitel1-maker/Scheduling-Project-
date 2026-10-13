// The single source of truth for the whole-camp file (docs/adr/2026-10-13-whole-camp-file-save-and-open.md
// section 4). The exporter, the validator and the loader all read THIS module; campFileScope.guard.test.js
// compares it against the real SQLite schema and PROJECTIONS, so a new table or field that nobody decided
// about fails a test instead of being silently left out or silently leaked.
//
// WHERE EACH HAND-KEPT SPEC COMES FROM (none of it is a guess; the guard test re-derives it):
//   - exported entities ....... PROJECTIONS (electron/ops/projections.js) in the projector's FK-safe apply order
//                                (MODELED_ORDER), minus the exclusions below.
//   - field lists ............. PROJECTIONS[entity].fields, minus the loader-supplied and stamped fields below.
//   - INTEGER_FIELDS /
//     REQUIRED_FIELDS ......... PRAGMA table_info of the migrated schema (INTEGER columns; NOT NULL without a default).
//   - REFERENCE_FIELDS ........ the real foreign keys (PRAGMA foreign_key_list) plus the soft references the schema
//                                comments and DOMAIN_SNAPSHOT_ORDER name as "soft". The guard asserts every real FK
//                                between exported tables is listed here with the same target, and that every *_id /
//                                *_ids field of an exported entity is either listed or explicitly not a reference.
//   - REFERENCE_LIST_FIELDS ... JSON arrays of ids stored in one TEXT column (resolveFixedEventGroupIds,
//                                buildSchedule: "arrays of ids").

import { PROJECTIONS } from '../projections.js'
import { MODELED_ORDER } from '../../automerge/projector.js'

export const CAMP_FILE_FORMAT = 'shoresh-camp'
export const CAMP_FILE_VERSION = 1
export const CAMP_FILE_EXTENSION = '.shoresh-camp'

// Set from measurement (ADR section 1 / Acceptance 3). A 40-group camp with 10 saved versions is 8.4 MB / 4,184 rows;
// the largest camp the app can schedule (99 groups, the 5,000-slot bulk-replace limit) is 20.8 MB / 10,233 rows. They
// are tuning constants, not promises.
export const CAMP_FILE_CAPS = Object.freeze({
  MAX_FILE_BYTES: 64 * 1024 * 1024,
  MAX_ROWS_PER_ENTITY: 30_000,
  MAX_ROWS_TOTAL: 50_000,
  MAX_ID_LENGTH: 1024,
  MAX_TEXT_LENGTH: 100_000,
  MAX_SNAPSHOT_SLOTS_LENGTH: 8_000_000,
  MAX_CAMP_NAME_LENGTH: 300,
  MAX_SNAPSHOT_SLOTS: 20_000,
})

// Entities in PROJECTIONS that never go in the file, with the reason (ADR section 4).
export const EXCLUDED_ENTITIES = Object.freeze({
  users: 'identity and credentials (pin_hash, pin_salt, auth_sig): a new camp makes its own first admin',
  tombstones: 'signed erasure markers belong to the document of the camp that issued them',
  conflicts: 'unresolved cross-device disagreements are device history, not camp data',
  campers: "children's names and personal data in an unencrypted file (ADR Acceptance 1)",
  camper_identity_keys: 'derived from camper names and external ids (ADR Acceptance 1)',
  elective_assignment_runs: "camper choices and assignments: personal data, excluded with campers (ADR Acceptance 1)",
  elective_occurrences: 'child of an elective assignment run',
  elective_choices: 'child of an elective assignment run',
  elective_choice_offerings: 'child of an elective assignment run',
  elective_preferences: 'camper preferences: personal data',
  elective_assignments: 'camper assignments: personal data',
  elective_run_outer_snapshots: 'per-camper export snapshot of a run',
  elective_run_findings: 'findings of an elective assignment run',
})

export const EXPORTED_ENTITIES = Object.freeze(
  MODELED_ORDER.filter((e) => e in PROJECTIONS && e !== 'camps' && !(e in EXCLUDED_ENTITIES))
)

export const CAMPS_EXPORTED_FIELDS = Object.freeze(['name'])

// SQLite tables that are neither exported entities nor learned tables nor camps, with the reason.
// Entities listed in EXCLUDED_ENTITIES are covered through their table name.
export const EXCLUDED_TABLES = Object.freeze({
  users: EXCLUDED_ENTITIES.users,
  tombstones: EXCLUDED_ENTITIES.tombstones,
  conflicts: EXCLUDED_ENTITIES.conflicts,
  campers: EXCLUDED_ENTITIES.campers,
  camper_identity_keys: EXCLUDED_ENTITIES.camper_identity_keys,
  elective_assignment_runs: EXCLUDED_ENTITIES.elective_assignment_runs,
  elective_occurrences: EXCLUDED_ENTITIES.elective_occurrences,
  elective_choices: EXCLUDED_ENTITIES.elective_choices,
  elective_choice_offerings: EXCLUDED_ENTITIES.elective_choice_offerings,
  elective_preferences: EXCLUDED_ENTITIES.elective_preferences,
  elective_assignments: EXCLUDED_ENTITIES.elective_assignments,
  elective_run_outer_snapshots: EXCLUDED_ENTITIES.elective_run_outer_snapshots,
  elective_run_findings: EXCLUDED_ENTITIES.elective_run_findings,
  applied_authority_log: 'device-local: authority log replay state',
  audit_events: 'device-local append-only audit trail',
  authority_cache: 'device-local: derived admin and revocation set',
  device_health_events: 'device-local health log',
  device_identity: 'device-local identity',
  device_identity_key: 'device-local private key material',
  devices: 'device-local: paired devices and trust',
  domain_state_migration_pending: 'device-local migration bookkeeping',
  fixed_event_identity_gaps: 'device-local migration worklist',
  host_handoff: 'device-local host succession state',
  host_signing_key: 'device-local private signing key',
  host_signing_key_pending: 'device-local staged signing key',
  last_import_undo: 'device-local undo state',
  location_migration_reviews: 'device-local migration worklist',
  locks: 'legacy device-local field locks; phase 1 stores the load-incomplete marker here',
  login_attempts: 'device-local lockout counters',
  migration_v24_repoint_log: 'device-local migration log',
  migration_v26_retired_orphan_log: 'device-local migration log',
  operations: 'device-local history ledger (Trash, Restore); not a replication mechanism',
  peer_last_addresses: 'device-local peer addresses',
  peer_punch_memory: 'device-local peer connection memory',
  peer_tombstone_reports: 'device-local erasure reports',
  projection_failures: 'device-local projection failure log',
  punch_identity: 'device-local connection identity',
  rendezvous_sequence: 'device-local relay sequence',
  roster_cache: 'device-local: derived device roster',
  schema_migrations: 'device-local migration history',
})

// Fields the loader writes itself and the file never carries.
export const LOADER_SUPPLIED_FIELDS = Object.freeze(
  Object.fromEntries(EXPORTED_ENTITIES.filter((e) => PROJECTIONS[e].fields.includes('camp_id')).map((e) => [e, ['camp_id']]))
)

// User ids: identity, not data. The file never carries them; the loader stamps the director who opens the file,
// because an answer authored by nobody the camp knows is discarded as "former author" (answerMemory.liveRecords).
export const STAMPED_FIELDS = Object.freeze({ camp_seedlings: ['confirmed_by'] })

export function fileFieldsOf(entity) {
  const skip = new Set([...(LOADER_SUPPLIED_FIELDS[entity] ?? []), ...(STAMPED_FIELDS[entity] ?? [])])
  return PROJECTIONS[entity].fields.filter((f) => !skip.has(f))
}

export function exportedTableNames() {
  return EXPORTED_ENTITIES.map((e) => PROJECTIONS[e].table)
}

// Field names that match /secret|pin|token|key|salt|hash/ but are not secrets: lookup keys and dedupe keys.
export const SECRET_LOOKING_FIELD_ALLOWLIST = Object.freeze({
  'camp_seedlings.match_key': 'dedupe key of a remembered answer (a SHA-256 of the question parts plus a uuid), not a credential',
  'location_word_decisions.word_key': 'normalized form of a location word the director decided about, a lookup key',
  'import_decisions.seedling_key': 'lookup key of the remembered answer an import decision used',
  'open_reconciliation_decisions.identity_key': 'identity of the open question, a lookup key',
  'open_reconciliation_decisions.domain_key': 'domain of the open question, a lookup key',
  'open_reconciliation_decisions.child_key': 'child of the open question, a lookup key',
})

export const INTEGER_FIELDS = Object.freeze({
  cohorts: ['sort_order'],
  days_of_operation: ['day_of_week', 'sort_order'],
  tiers: ['sort_order'],
  time_blocks: ['sort_order', 'events_only'],
  activities: ['is_outdoor', 'is_locked', 'max_groups_per_slot', 'min_per_week', 'max_per_week', 'same_tier_only', 'priority', 'prefer_before_day', 'prefer_before_day_min', 'span_blocks'],
  locations: ['capacity', 'sort_order', 'grid_x', 'grid_y'],
  camp_maps: ['image_width', 'image_height'],
  fixed_events: ['is_all_groups', 'span_blocks'],
  schedule_weeks: ['sort_order', 'is_archived'],
  template_slots: ['is_fixed_event', 'is_span_head', 'is_released'],
  special_days: ['sort_order'],
  special_day_time_blocks: ['sort_order'],
  elective_sets: ['sort_order', 'is_reusable', 'is_all_groups'],
  elective_set_activities: ['capacity_limit', 'min_to_run'],
  elective_bundles: ['sort_order'],
  events: ['sort_order'],
  event_time_blocks: ['sort_order'],
  event_groups: ['sort_order'],
  schedule_snapshots: ['is_auto'],
})

// INTEGER columns that hold TEXT in practice: SQLite keeps non-numeric text in an INTEGER-affinity column
// (activities.priority is 'high' / 'low', see buildSchedule). Such a field may be a string or an integer.
export const MIXED_INTEGER_FIELDS = Object.freeze({
  activities: ['priority'],
})

// NOT NULL with no default, among the file fields. A NOT NULL column with a default may be absent from a row
// (the stub row's default applies); these may not.
export const REQUIRED_FIELDS = Object.freeze({
  cohorts: ['name'],
  days_of_operation: ['label'],
  groups: ['name'],
  tiers: ['name'],
  time_blocks: ['name'],
  activities: ['name'],
  locations: ['name'],
  schedule_weeks: ['name'],
  schedule_templates: ['name'],
  schedule_snapshots: ['template_id', 'created_at'],
  template_slots: ['template_id'],
  week_activity_exclusions: ['week_id', 'activity_id'],
  week_group_exclusions: ['week_id', 'group_id'],
  week_location_exclusions: ['week_id', 'location_id'],
  special_days: ['name'],
  special_day_time_blocks: ['special_day_id', 'name', 'sort_order'],
  special_day_slots: ['special_day_id', 'group_id', 'time_block_id'],
  special_day_placements: ['week_id', 'day_id', 'special_day_id'],
  camp_seedlings: ['kind', 'match_key', 'payload', 'confirmed_at'],
  elective_sets: ['name'],
  elective_set_activities: ['elective_set_id', 'activity_id'],
  elective_bundles: ['elective_set_id', 'activity_id', 'name'],
  elective_bundle_periods: ['bundle_id', 'day_id', 'time_block_id'],
  elective_bundle_tiers: ['bundle_id', 'tier_id'],
  events: ['name'],
  event_time_blocks: ['event_id', 'name', 'sort_order'],
  event_groups: ['event_id', 'name', 'sort_order'],
  event_slots: ['event_id', 'event_group_id', 'time_block_id'],
})

// entity -> field -> the entity whose id it holds.
export const REFERENCE_FIELDS = Object.freeze({
  groups: { tier_id: 'tiers' },
  time_blocks: { cohort_id: 'cohorts' },
  tiers: { cohort_id: 'cohorts' },
  activities: { weather_alternative_id: 'activities', location_id: 'locations' },
  locations: { map_id: 'camp_maps' },
  week_location_exclusions: { week_id: 'schedule_weeks', location_id: 'locations' },
  fixed_events: {
    cohort_id: 'cohorts', day_id: 'days_of_operation', time_block_id: 'time_blocks', schedule_week_id: 'schedule_weeks',
    location_id: 'locations', activity_id: 'activities',
  },
  special_day_time_blocks: { special_day_id: 'special_days' },
  special_day_slots: { special_day_id: 'special_days', group_id: 'groups', time_block_id: 'special_day_time_blocks', activity_id: 'activities', location_id: 'locations' },
  special_day_placements: { week_id: 'schedule_weeks', day_id: 'days_of_operation', special_day_id: 'special_days' },
  elective_sets: { day_id: 'days_of_operation', time_block_id: 'time_blocks', schedule_week_id: 'schedule_weeks' },
  elective_set_activities: { elective_set_id: 'elective_sets', activity_id: 'activities' },
  elective_bundles: { elective_set_id: 'elective_sets', activity_id: 'activities' },
  elective_bundle_periods: { bundle_id: 'elective_bundles', day_id: 'days_of_operation', time_block_id: 'time_blocks' },
  elective_bundle_tiers: { bundle_id: 'elective_bundles', tier_id: 'tiers' },
  events: { location_id: 'locations' },
  event_time_blocks: { event_id: 'events' },
  event_groups: { event_id: 'events' },
  event_slots: { event_id: 'events', event_group_id: 'event_groups', time_block_id: 'event_time_blocks', activity_id: 'activities', location_id: 'locations' },
  week_activity_exclusions: { week_id: 'schedule_weeks', activity_id: 'activities' },
  week_group_exclusions: { week_id: 'schedule_weeks', group_id: 'groups' },
  schedule_templates: { week_id: 'schedule_weeks' },
  schedule_snapshots: { template_id: 'schedule_templates' },
  template_slots: {
    template_id: 'schedule_templates', group_id: 'groups', activity_id: 'activities', day_id: 'days_of_operation',
    time_block_id: 'time_blocks', fixed_event_id: 'fixed_events', elective_set_id: 'elective_sets', event_id: 'events',
  },
})

// entity -> field -> the entity whose ids the JSON array holds.
export const REFERENCE_LIST_FIELDS = Object.freeze({
  activities: { eligible_tier_ids: 'tiers', eligible_group_ids: 'groups' },
  fixed_events: { group_ids: 'groups', unit_ids: 'tiers' },
  elective_sets: { group_ids: 'groups' },
})

// *_id fields of exported entities that are not references. None today; a future one is added here on purpose.
export const NON_REFERENCE_ID_FIELDS = Object.freeze({})

// The seven host-local "learned answer" tables (hostHandoff.HANDOFF_TABLES). `camp_seedlings`, the replicated
// eighth, rides in `entities`. `stamped` columns hold user ids and are never exported; the loader stamps the
// opening director. `refs` hold ids of exported entities: rewritten through the old-to-new map when they
// resolve, kept verbatim when they do not (a remembered answer may outlive the row it was about).
export const LEARNED_TABLES = Object.freeze({
  source_aliases: {
    columns: ['id', 'entity_type', 'cohort_id', 'source_label', 'entity_id', 'status', 'confirmed_at', 'superseded_by'],
    stamped: ['confirmed_by'],
    refs: { cohort_id: 'cohorts', entity_id: '*' },
    integers: [],
  },
  compound_cell_decisions: {
    columns: ['id', 'pattern', 'interpretation', 'base_name', 'wrapper_name', 'confirmed_at'],
    stamped: ['confirmed_by'],
    refs: {},
    integers: [],
  },
  location_word_decisions: {
    columns: ['id', 'word_key', 'raw_word', 'decision', 'confirmed_at'],
    stamped: ['confirmed_by'],
    refs: {},
    integers: [],
  },
  declined_two_row_splits: {
    columns: ['id', 'activity_name_normalized', 'declined_at'],
    stamped: [],
    refs: {},
    integers: [],
  },
  import_decisions: {
    columns: ['id', 'import_id', 'kind', 'seedling_key', 'lane', 'proposed', 'outcome', 'chosen', 'learned_from_id', 'decided_at'],
    stamped: ['actor_user_id'],
    refs: {},
    integers: [],
  },
  import_evidence: {
    columns: ['id', 'entity_type', 'entity_id', 'field', 'tag', 'confidence', 'support', 'import_run_id', 'committed_at'],
    stamped: [],
    refs: { entity_id: '*' },
    integers: [],
  },
  open_reconciliation_decisions: {
    columns: ['id', 'entity_type', 'cohort_id', 'entity_id', 'identity_key', 'kind', 'domain_key', 'child_key', 'entity_name', 'reason', 'import_run_id', 'created_at', 'payload'],
    stamped: [],
    refs: { cohort_id: 'cohorts', entity_id: '*' },
    integers: [],
  },
})

export const LEARNED_REQUIRED = Object.freeze({
  source_aliases: ['entity_type', 'source_label', 'entity_id', 'confirmed_at'],
  compound_cell_decisions: ['pattern', 'interpretation', 'confirmed_at'],
  location_word_decisions: ['word_key', 'raw_word', 'decision', 'confirmed_at'],
  declined_two_row_splits: ['activity_name_normalized', 'declined_at'],
  import_decisions: ['import_id', 'kind', 'outcome', 'decided_at'],
  import_evidence: ['entity_type', 'entity_id', 'field', 'tag', 'confidence', 'support', 'import_run_id', 'committed_at'],
  open_reconciliation_decisions: ['entity_type', 'identity_key', 'kind', 'domain_key', 'child_key', 'import_run_id', 'created_at'],
})
