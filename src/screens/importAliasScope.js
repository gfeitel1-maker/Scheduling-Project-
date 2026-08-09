// The cohort-scoped entity_type set the "Remember this" alias path uses to
// decide whether to send a cohort_id to confirmAlias. It MUST stay equal to the
// engine's COHORT_SCOPED (electron/ops/ingest.js); confirmAlias rejects a
// cohort_id on a non-cohort-scoped entity_type, so this gates what's sent rather
// than letting the call throw. Kept in src/ (renderer code never imports
// electron/ at runtime) and duplicated on purpose — the duplication is held
// honest by aliasCohortScoped.drift.test.jsx, which asserts set-equality.
export const ALIAS_COHORT_SCOPED = new Set(['tiers', 'time_blocks'])
