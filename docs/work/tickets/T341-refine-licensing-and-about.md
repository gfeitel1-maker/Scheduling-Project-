---
ticket: T341
document_type: ticket
title: "Refine licensing + About (owner's personal content + user-agreement polish)"
status: open
created: 2026-10-03
archive_when: "the owner's personal About content is in the About & Legal surface, and the user-agreement polish decisions (voice, accept-gate vs view-only, camper-data line, any legal review) are made and reflected"
task_class: ui-ux-design
parent: ""
governing_docs: [docs/current/PLATFORM_STATE.md]
related_prs: []
---

# T341 — Refine licensing + About (follow-up to the shipped About & Legal surface)

## Context

The in-app **About & Legal** surface shipped minimal and view-only per the owner's ruling
2026-10-02 ("leave whatever was written in… call this part done. add a ticket to follow up after
everything else. i just want this to be in there."). It lives at `src/screens/AboutScreen.jsx`,
reached from the sidebar footer, and holds: a neutral About placeholder, the app version, the
drafted user agreement (shipped as-is), the Apache-2.0 license notice, and a pointer to the bundled
third-party attributions. No accept-gate, no stored acceptance state.

This ticket is the deferred refinement. **Sequenced AFTER the end-to-end packaged-app test and the
how-to/user guide** — i.e. the end of the owner's current plan. Do not pick it up before then.

## Scope

1. **The owner's personal About content.** He wants "something of me in." The content is his own
   words and he supplies them; an agent shapes/places them, does not invent a persona. Replaces the
   neutral placeholder line in `AboutScreen.jsx`'s About section.

2. **User-agreement polish.** All deferred from the ship-now pass:
   - **Voice** — "we/us" as drafted vs first-person "I" (may read better for a single-author
     open-source project). Owner's call.
   - **Accept-gate vs view-only** — currently view-only. If an accept-gate is wanted, it is a
     one-time acknowledgment at camp bootstrap, remembered **device-local** (a local setting, never
     a synced/doc field — keeps it inside the UI-only boundary).
   - **The camper-data responsibility line** — keep, cut, or expand.
   - **Any real legal review** of the terms (warranty/liability, data handling) the owner wants.

## Non-goals

- The open-source licensing itself (Apache-2.0 LICENSE + NOTICE + third-party attributions) is
  already complete and shipped; this ticket does not revisit the license choice unless the owner
  reopens it.
- No schema, sync, or auth change (an accept-gate's remembered state stays device-local).
