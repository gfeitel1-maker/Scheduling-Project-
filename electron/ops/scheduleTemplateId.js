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
export function deriveScheduleTemplateId(campId) {
  return `schedule-template:${campId}`
}
