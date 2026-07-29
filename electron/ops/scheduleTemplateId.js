// Pure, dependency-free id derivation shared between electron code (the
// version-21 migration in electron/db/localDb.js, which re-keys every
// existing schedule_templates row to this exact value) and the renderer
// (ScheduleScreen.jsx, slice 2 of the T7 fix).
//
// It lives under electron/ rather than src/ on purpose. electron-builder's
// `files` list (package.json) ships only `electron/**`, `dist/**` and
// `package.json` — `src/` is NOT packaged. An electron-side import of a
// src/ module therefore works in `npm run electron:dev` and fails in the
// installed app, at migration time, on the user's real database. The
// renderer can import in this direction safely: Vite bundles this pure
// module into dist/, and dist/ ships.
//
// See docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md
// and the companion design doc for why a deterministic id (rather than
// crypto.randomUUID()) is required: two devices that independently mint a
// "Master Template" row for the same camp must always agree on its id, or
// their schedules silently fork.
// The second argument is ADDITIVE and must stay so: this module is imported by
// the version-21 migration (electron/db/localDb.js), which calls it with one
// argument against real, existing databases. `generated` — the only kind that
// existed before v23 — must therefore keep returning the byte-identical
// one-argument value, or v21 would re-key every director's schedule to a
// different id on the next launch.
//
// The ':manual' suffix is an id, not a parsing contract. Nothing may recover a
// route by inspecting the string; `schedule_templates.kind` is the only
// authority on which route a row belongs to (see
// docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, Decision §1).
export function deriveScheduleTemplateId(campId, kind = 'generated') {
  return kind === 'generated' ? `schedule-template:${campId}` : `schedule-template:${campId}:${kind}`
}
