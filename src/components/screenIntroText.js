// The one-line explanation of what a screen is for, in camp language.
//
// These sentences used to live only on the Camp Setup screen, as the `desc`
// field of its step list. That screen was a second pathway through setup —
// product owner, 2026-08-01: "there are currently two pathways to setting up a
// camp and only one is needed — which should be the sidebar." Retiring it would
// have thrown the explanations away with it, and a first-run director needs
// them: a 216px sidebar row can say "Units", but not what a unit is.
//
// So they moved here, to the screens themselves, where they are read at the
// moment they are needed rather than one screen earlier.

export const SCREEN_INTRO = {
  cohorts: 'A session or division of camp with its own schedule — Session A, Machaneh Kayitz.',
  tiers: 'Age divisions with their own schedule — Yeladim, Bonim, Edah Aleph.',
  groups: 'Individual bunks or tzrifim within each unit — Tzrif Aleph, Bunk 4.',
  days: 'Which days of the week camp runs — Sunday through Friday, or whatever your week is.',
  timeblocks: 'Named periods in the daily timetable — Morning Activity, Free Swim, Menucha.',
  activities: 'What groups do during free blocks — archery, swimming, ceramics, peulot.',
  anchors: 'Events that happen at the same time every day — Aruchat Boker, Tefillah, Flagpole.',
  dayoverrides: 'Days that do not run normally — a trip day, Color War, a Shabbaton.',
}
