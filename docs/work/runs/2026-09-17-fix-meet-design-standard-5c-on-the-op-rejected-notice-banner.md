---
task: fix: meet DESIGN_STANDARD §5c on the op-rejected notice banner (closes T204)
document_type: run
date: 2026-09-17
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T204-notice-banner-misses-two-design-standard-requirements.md]
related_specs: []
related_adrs: []
selected_agents: [governor]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: Renderer-only, confined to src/App.jsx and src/App.test.jsx. No schema, IPC, contract or stored-shape change; the notice value's shape is component-local React state, not a persisted or cross-module contract.
  - agent: designer
    reason: not-applicable
    note: DESIGN_STANDARD §5c is itself the spec here — icon size, colour, motion tokens and dismiss behaviour are all named in it. There was no open visual question for a Designer to settle.
  - agent: maker
    reason: not-applicable
    note: The owner dispatched this Governor session directly with an executable brief; the implementation was carried out in-session rather than delegated to a Maker dispatch.
  - agent: code-reviewer
    reason: not-applicable
    note: Not dispatched this session. The owner's brief scopes the deliverable to an open, unmerged PR and makes CI the gate of record; review happens on that PR.
  - agent: verifier
    reason: human-waived
    note: 'Owner brief, verbatim: "CI is the gate of record for merging (#462) — do not burn ~13 local minutes to open a PR." Focused gates (App.test.jsx, App.landing.test.jsx, lint, build, check-governance) were run in-session instead; the full suite runs in CI on the PR.'
  - agent: tester
    reason: not-applicable
    note: No new screen or flow. The change is one banner's icon and dismiss motion, covered by the jsdom tests listed below; the visual result is a 16px glyph and a 140ms fade.
  - agent: security
    reason: not-applicable
    note: No auth, PIN, IPC, transport, packaging or secrets surface touched. Renderer-local presentation state only.
  - agent: red-hat
    reason: not-applicable
    note: Not dispatched. The one adversarial case the brief named — a new notice arriving mid-fade — was handled deliberately and is pinned by a test that uses the SAME message twice, the variant a naive implementation gets wrong.
  - agent: grader
    reason: not-applicable
    note: Not dispatched; no Maker/reviewer reports exist to reduce, and the verdict here rests on deterministic gates plus CI, not on a score.
deterministic_checks: [npx vitest run src/App.test.jsx --no-file-parallelism, npx vitest run src/App.landing.test.jsx --no-file-parallelism, npm run lint, npm run build, node scripts/check-governance.js]
human_gates:
  - gate: GOVERNANCE_INDEX §11.3 — amending code to match a standard
    decision: opened by the owner
    note: 'Owner, verbatim: "The owner has explicitly opened the human gate for this work... That gate is now open. Proceed." T204 (filed as T202) was reported-and-stopped precisely because §11.3 forbids closing a code-vs-standard gap without this.'
verdict: pass
completion_evidence:
  - commit 4127a12
  - gate: 'npx vitest run src/App.test.jsx --no-file-parallelism — Test Files 1 passed (1), Tests 27 passed (27)'
  - gate: 'npx vitest run src/App.landing.test.jsx --no-file-parallelism — Tests 3 passed (3)'
  - gate: 'npm run lint — 0 errors, 26 pre-existing warnings, exit 0'
  - gate: 'npm run build — built in 5.59s, exit 0'
  - gate: 'node scripts/check-governance.js — clean once this record and the refreshed INDEX.md exist'
  - 'full npm run verify: NOT run locally, by owner instruction; CI on the PR is the gate of record (#462)'
archive_when: "The op-rejected notice banner renders §5c's outline alert icon, dismisses with a --motion-fast fade (immediate under prefers-reduced-motion), the dismiss test asserts the faded-out end state rather than immediate removal, and CI is green on the PR that carries this commit."
---

# fix: meet DESIGN_STANDARD §5c on the op-rejected notice banner (closes T204)

## What shipped

Two §5c requirements the banner did not meet, plus one defect found while
implementing them.

1. **Outline alert icon.** `WarningTriangleIcon` (already in
   `src/components/icons/index.jsx` — outline, `fill: none`, stroke 1.5) at
   `size={16}`, `color="var(--danger)"`, in a flex row before the message.
   No new icon was drawn; the repo's standing icon-slot rule and its
   no-colour-emoji rule are both satisfied by the existing glyph.
2. **Dismiss fades out.** Dismiss now sets a fading style
   (`opacity: 0; transition: opacity var(--motion-fast) var(--ease-out)`)
   and unmounts 140ms later, mirroring
   `src/components/schedule/ErrorBanner.jsx` rather than inventing a second
   mechanism. Under `prefers-reduced-motion: reduce` it unmounts immediately
   (§8's "crossfade or instant"), read through the same
   `prefersReducedMotion()` helper `useEnterTransition` uses.
3. **Centering (not in the ticket).** `opRejectedNoticeStyles.wrap` centred
   itself with `left: 50%` + `transform: translateX(-50%)`, but
   `useEnterTransition` returns a `transform` and is spread *after* the wrap
   — so the slide clobbered the centring shift and the banner rendered with
   its left edge at the viewport midpoint. Replaced with auto margins
   between two insets, leaving `transform` to motion alone.

## The mid-fade window, and why the notice value changed shape

A delayed unmount opens a ~140ms window in which a *new* notice can arrive
while the old one is still fading. Decided deliberately: **the new notice
wins and the pending unmount is abandoned.** `dismissing` is derived
(`dismissingNotice === notice`) rather than a boolean reset by an effect, so
a new notice makes the banner opaque again on the next render with no
state-in-effect cascade; the pending timer then checks the notice currently
on screen against the one that was dismissed and returns without calling
`onDismiss` if they differ.

That check needs to distinguish "the same message arrived again" from
"nothing new arrived", which a string cannot do — so `opRejectedNotice` is
now `{ message }`, a fresh object per arrival. This is why the guard test
fires the identical rejection twice.

The three sources of the notice are unchanged in kind: the two bootstrap
writers still carry a retry, and the offline-queue `onOpRejected` source
still sets `noticeRetry` to null, as T201 intended.

## Non-vacuity — each guard planted and measured

Every row below is a real edit to `src/App.jsx`, a real run of
`npx vitest run src/App.test.jsx --no-file-parallelism`, and a restore.

| Planted defect | Result |
|---|---|
| Remove `<WarningTriangleIcon>` | RED — "renders the 16px danger alert icon alongside the message" |
| Restore the synchronous dismiss (`onDismiss()` directly) | RED — "dismiss fades the banner out and then removes it" **and** "a new notice arriving mid-fade cancels the pending unmount" |
| Remove the reduced-motion branch (keep the fade) | RED — "dismiss is immediate under prefers-reduced-motion" |
| Remove the stale-timer guard (`if (currentNoticeRef.current !== dismissed) return`) | RED — "a new notice arriving mid-fade cancels the pending unmount" |
| **Not the designed-for defect:** key the mid-fade cancel on the message string instead of the notice's identity — the shape a naive implementation takes | RED — "a new notice arriving mid-fade cancels the pending unmount" |

**Passes either way, stated as such rather than counted as coverage:** the
reduced-motion test passes against the *pre-T204* synchronous dismiss, since
an unconditional immediate unmount trivially satisfies "immediate under
reduced motion". It only discriminates once a fade exists. The centering fix
(item 3) has **no test at all** — jsdom does not lay out, so the clobbered
`transform` is not observable there; it is reported as an eyeball-verified
change.

A second measurement worth recording: the first draft of the mid-fade test
failed for a reason that was not the fix. The mount-time bootstrap resolves
asynchronously and, on success, recomposes the notice to `null` — so *any*
"the banner is gone" assertion taken after an await would have passed
whether or not the dismiss timer ever ran. The `flushBootstrap()` helper
settles the bootstrap before the rejection is fired, so the removal
assertions measure dismiss and nothing else.

## Agents

Governor (this session), dispatched directly by the owner with an
executable brief; no sub-agents were dispatched. Every other role is
omitted for the reason recorded in the frontmatter above — none ran, and
none is claimed to have run. Independent review is the PR's job, and CI is
the gate of record for merging per the owner's instruction.
