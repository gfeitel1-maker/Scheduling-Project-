---
title: "Roots as the dashboard / spine — implementation plan"
document_type: plan
status: active
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
related_docs: [docs/work/specs/2026-08-19-roots-dashboard-spine-design.md]
archive_when: the feature ships (all five tasks merged) and PLATFORM_STATE reflects Roots-as-home
---

# Roots as the Dashboard / Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Roots inspector the home/dashboard and the spine of the post-import journey — nodes navigate into setup, the readiness verdict lives on it (computed once), import/facility entry points sit on it, and a finished import returns here.

**Architecture:** Reuse the existing shared spine (`ReconciliationScreen` with `mode: 'inspect' | 'import'`, `buildRootMapModel`, `getReadiness`). No schema/engine/model change — this is navigation, a banner, and one routing change. The `node → panel → Manage` seam is deliberately the place setup editing gets absorbed later (north star), so nothing here is built to be undone.

**Tech Stack:** React 19 + Vite, inline style objects + `src/styles/shared.js` tokens, no router (screen string in `AppShell` state), Vitest + React Testing Library. Design tokens per `docs/governance/standards/DESIGN_STANDARD.md`.

## Global Constraints

- **No new design tokens.** Colors/motion/spacing come only from `src/index.css` / `src/styles/shared.js`. Attention = `--accent`, danger = destructive/fatal only (DESIGN_STANDARD §4).
- **`getSetupGaps` stays the single build-a-week gate.** Roots *displays* the verdict from `getReadiness`; it never re-derives or replaces the blocking core (`src/engine/readiness.js:5-16`).
- **Header/heading copy is PARKED.** Do not invent final wording for the dashboard header — keep existing strings; a follow-up applies the owner's language skill. New *structural* copy (button labels like "Manage X →", "Go to Schedule") is fine.
- **`buildReconciliationReport`/`buildRootMapModel`/golden ops unchanged.** Import (`mode:'import'`) behavior must stay byte-identical except the post-commit routing in Task 4.
- **Every mutation path surfaces failures** via the existing error affordances; inspect mode stays read-only (no write/commit/dry-run — the Slice-4 guarantee must hold).
- **Full gate before done:** `npm run verify` green, and for any screen change run the reconciliation-consumer test set (`ReconciliationScreen`, `ImportScreen`, `ImportScreen.locations`, `RootMapPanel`, `RootMap`) — the coordinator runs the full suite.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/components/reconciliation/RootMapPanel.jsx` | Promote node navigation to a primary "Manage {Area} →" | 1 |
| `src/components/reconciliation/rootMapNav.js` | Screen labels (source of the Area name in the button) | 1 |
| `src/screens/ReconciliationScreen.jsx` | The mode-aware Roots banner (verdict + bring-data-in actions; post-import "Go to Schedule") | 2, 4 |
| `src/components/reconciliation/rootsBanner.jsx` (new) | Presentational banner: verdict line, worksheet download, Import + facility-map entry points | 2 |
| `src/App.jsx` | Default landing → `roots`; `readiness` route redirect; screenProps | 3 |
| `src/components/layout/navSections.js` | `roots` becomes the home item; remove `readiness` | 3 |
| `src/screens/ReadinessHub.jsx` | Retired (its worksheet + CTA move to `rootsBanner`) | 3 |
| `src/screens/ImportScreen.jsx` | Commit success routes to `roots` (not the local receipt); grace-window undo rides along | 4 |
| `src/components/layout/TopBar.jsx` + `Shell.jsx` | A "← Roots" return affordance on setup screens (closes the inspect→edit→re-inspect loop, audit G4) | 5 |

Each task is independently testable and reversible. Tasks 3 and 4 (landing/redirect, commit-flow) warrant closer review.

---

### Task 1: Promote node navigation — "Manage {Area} →"

Directly fixes "nodes go nowhere": today the panel's navigation is a quiet `Open in {label} →` link (`RootMapPanel.jsx:172-196`); make it the primary action.

**Files:**
- Modify: `src/components/reconciliation/RootMapPanel.jsx` (the `targetScreen` button block, ~172-196)
- Test: `src/components/reconciliation/RootMapPanel.test.jsx`

**Interfaces:**
- Consumes: `screenForNode(domainKey, childKey)` and `SCREEN_LABEL` (`rootMapNav.js`), `onNavigate(screenKey)` prop (unchanged).
- Produces: no new exports; a more prominent nav affordance. Row navigation (`onRowClick`) already exists and stays.

- [ ] **Step 1: Write the failing test** — in `RootMapPanel.test.jsx`, render the panel with a node selection whose `screenForNode` resolves (e.g. Structure/Groups → `groups`). Assert a button with an accessible name matching `/^Manage .* →$/` exists and, when clicked, calls `onNavigate` with the resolved screen key. Assert it carries the primary button style (reuse the existing `S.btnPrimary`/`btnCompactPrimary` used elsewhere in this file — grep it), not the old link style.

- [ ] **Step 2: Run it, verify it fails** — `npm run test -- src/components/reconciliation/RootMapPanel.test.jsx --no-file-parallelism` → FAIL (no "Manage" button yet).

- [ ] **Step 3: Implement** — in the `targetScreen ? (...)` block, change the label from `` `Open in ${SCREEN_LABEL[targetScreen] ?? targetScreen} →` `` to `` `Manage ${childOrDomainLabel} →` `` where `childOrDomainLabel` is the selected node's own display name (`selection.childKey ?? DOMAIN_LABELS[selection.domainKey] ?? SCREEN_LABEL[targetScreen]` — use the node label the user clicked, not the raw screen key). Apply the primary button style. Keep the `onClick={() => onNavigate?.(targetScreen)}` handler. Do NOT change the roster `onRowClick`.

- [ ] **Step 4: Run tests, verify pass** — same command → PASS. Also run the existing RootMapPanel tests to confirm no regression.

- [ ] **Step 5: Commit** — `git add src/components/reconciliation/RootMapPanel.jsx src/components/reconciliation/RootMapPanel.test.jsx && git commit -m "feat(roots): promote node navigation to a primary 'Manage {Area} →' action"`

---

### Task 2: The Roots dashboard banner (verdict + bring-data-in)

Add the mode-aware banner to Roots inspect mode: the readiness verdict (computed once from `getReadiness`), worksheet download, Import last year, and the facility-map entry (banner-to-start).

**Files:**
- Create: `src/components/reconciliation/rootsBanner.jsx` (presentational)
- Create: `src/components/reconciliation/rootsBanner.test.jsx`
- Modify: `src/screens/ReconciliationScreen.jsx` (render `<RootsBanner>` at the top of inspect-mode render; fetch readiness for it)

**Interfaces:**
- Consumes: `getReadiness(collections)` + `describeReadiness` + `describeOptionalGaps` (`src/engine/readiness.js`), `downloadWorkbook` (`src/utils/exportWorkbook.js`) — reuse exactly what `ReadinessHub.jsx:19-20,59-60,71-89` uses. `onNavigate` prop.
- Produces: `RootsBanner({ readiness, brandNew, onNavigate, onDownloadWorksheet })` default export. `readiness` is the object returned by `getReadiness`.

- [ ] **Step 1: Write the failing test** — `rootsBanner.test.jsx`: (a) given a `getReadiness` result with blocking gaps, the banner renders the blocking verdict sentence from `describeReadiness` and a disabled-or-absent "ready" state; (b) given a green readiness, it renders the "ready to build a week" line; (c) it renders an "Import last year" control that calls `onNavigate('import')`; (d) a "Download worksheet" control calls `onDownloadWorksheet`; (e) a facility-map control calls `onNavigate('locations')`; (f) when `brandNew`, the Import control is visually primary. Use the real `getReadiness`/`describeReadiness` (don't mock the verdict — pin it to the one source).

- [ ] **Step 2: Run it, verify it fails** — `npm run test -- src/components/reconciliation/rootsBanner.test.jsx --no-file-parallelism` → FAIL (module missing).

- [ ] **Step 3: Implement `rootsBanner.jsx`** — a presentational banner using inline styles from `S`/tokens: left = camp verdict line (`describeReadiness(readiness).blocking` or the optional note via `describeOptionalGaps`); right = actions (Import last year → `onNavigate('import')`; Download worksheet → `onDownloadWorksheet`; Facility map → `onNavigate('locations')`). Import primary when `brandNew`. No new tokens. Keep copy structural/honest; do NOT finalize the poetic header wording (parked).

- [ ] **Step 4: Wire into `ReconciliationScreen.jsx`** — in inspect mode only, fetch the readiness collections (reuse the `fetchReadiness`/census snapshot already loaded — `getReadiness` needs the same collections; do not add a second query if the snapshot already has them) and render `<RootsBanner readiness={...} brandNew={...} onNavigate={onNavigate} onDownloadWorksheet={...} />` above the `RootMap`. Guard: import mode renders no banner here (Task 4 adds the post-import banner state). Degrade gracefully when `censusReadFailed` — do not show a false "ready".

- [ ] **Step 5: Run tests, verify pass** — `npm run test -- src/components/reconciliation/rootsBanner.test.jsx src/screens/ReconciliationScreen.test.jsx --no-file-parallelism` → PASS. Add/extend a ReconciliationScreen inspect-mode test asserting the banner renders and the verdict equals `describeReadiness(getReadiness(...))`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(roots): dashboard banner — readiness verdict (single source) + import/worksheet/facility entry points"`

---

### Task 3: Landing swap + ReadinessHub retirement

Make Roots the home; redirect `readiness`; move the worksheet + CTA off ReadinessHub (now on the banner) and remove it. Depends on Task 2 (so nothing is lost).

**Files:**
- Modify: `src/App.jsx` (default `screen`, `SCREENS`, screenProps)
- Modify: `src/components/layout/navSections.js` (remove `readiness`, make `roots` the home item)
- Remove: `src/screens/ReadinessHub.jsx` (+ its test) — after confirming the banner covers its assets
- Test: `src/App.test.jsx` (or the existing app/nav tests)

**Interfaces:**
- Consumes: `SCREENS['roots']` → `ReconciliationScreen` with `mode:'inspect'` (already wired, `App.jsx:160`).
- Produces: default landing = `roots`; `readiness` key resolves to the roots screen (redirect).

- [ ] **Step 1: Write the failing test** — assert `AppShell` renders the `roots` screen by default (was `readiness`). Assert navigating to `readiness` (e.g. a stale deep link) resolves to the roots screen, not a missing screen. Assert `navSections` no longer lists a `readiness` item and lists `roots` as the home/top setup item.

- [ ] **Step 2: Run it, verify it fails** — run the app/nav test → FAIL (default is still `readiness`).

- [ ] **Step 3: Implement** — `App.jsx:80` `useState('readiness')` → `useState('roots')`. In `SCREENS`, point `readiness` at `ReconciliationScreen` too (redirect) OR map `readiness → roots` before lookup; ensure the `mode:'inspect'` prop is applied for both keys (extend the `screen === 'roots'` check to include `'readiness'`, or normalize `screen==='readiness'` to `'roots'` at the top of render). In `navSections.js`, remove the `{ key:'readiness', ... }` item and keep `{ key:'roots', label:'Roots' }` as the first setup item (label wording parked — keep "Roots" for now).

- [ ] **Step 4: Remove ReadinessHub** — confirm the worksheet download + brand-new Import CTA now live on `rootsBanner` (Task 2). Delete `src/screens/ReadinessHub.jsx` and its test; remove the `import ReadinessHub` from `App.jsx`. Grep for any other importer of ReadinessHub and update.

- [ ] **Step 5: Run tests, verify pass** — the app/nav test → PASS; run the reconciliation-consumer set to confirm no regression; grep-confirm zero remaining `ReadinessHub` references.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(roots): make Roots the home screen; redirect readiness; retire ReadinessHub"`

---

### Task 4: Post-import routes back to Roots

On a successful import commit, route the director to Roots with an "Imported N — here's your camp → Go to Schedule" banner state, instead of the ephemeral ImportScreen receipt. The grace-window undo rides along (it currently dies on navigation).

**Files:**
- Modify: `src/screens/ImportScreen.jsx` (`handleReconciliationCommitted` ~549-565 — route to `roots` instead of rendering the local receipt)
- Modify: `src/screens/ReconciliationScreen.jsx` (inspect-mode banner accepts a post-import "just imported" state: outcome summary + "Go to Schedule")
- Test: `src/screens/ImportScreen.test.jsx`, `src/screens/ReconciliationScreen.test.jsx`

**Interfaces:**
- Consumes: the commit `outcome` (`{ created, total, fixedEvents, invertibleOps, createdEntityIds, ... }` from `ingestCommit`), `onNavigate`.
- Produces: a post-import banner state on Roots. Decide the carrier: pass the outcome forward via a lightweight shared state (e.g. an `onNavigate('roots', { justImported: outcome })` convention, or a small module-level "last import" signal ImportScreen sets and Roots reads on mount). Prefer the least-surprising mechanism consistent with the no-router architecture — document it in the task.

- [ ] **Step 1: Write the failing test** — in `ImportScreen.test.jsx`: after a successful commit, assert `onNavigate('roots'...)` is called (the director is taken to Roots), and the ImportScreen local receipt is NOT the resting surface. In `ReconciliationScreen.test.jsx` (inspect mode, given a just-imported outcome): assert the banner shows the "Imported N" summary and a "Go to Schedule" control that calls `onNavigate('schedule')`, and that the grace-window undo affordance is reachable.

- [ ] **Step 2: Run them, verify they fail** — run both files → FAIL.

- [ ] **Step 3: Implement the carrier + routing** — in `handleReconciliationCommitted`, after `setResult`/grace-window start, call `onNavigate('roots', …)` carrying the outcome (implement the carrier chosen above). In inspect-mode `ReconciliationScreen`, when a just-imported outcome is present, render the post-import banner variant (summary + Go to Schedule) and keep the grace-window undo mounted here so it survives.

- [ ] **Step 4: Run tests, verify pass** — both files → PASS. Confirm the normal (non-import) Roots inspect banner still shows the readiness verdict (Task 2 unbroken), and import-mode reconcile is otherwise unchanged.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(roots): route a finished import back to Roots with a 'go to schedule' banner + surviving undo"`

---

### Task 5: Setup-screen "← Roots" return loop (audit G4)

Closes the inspect→edit→re-inspect loop: today the setup CRUD screens have no in-context way back to Roots (the audit's Axis-5 dead-end). Add a "← Roots" affordance in the shared top chrome, shown on editable setup screens.

**Files:**
- Modify: `src/components/layout/TopBar.jsx` (renders `TITLES[screen]`; add the back affordance; accept `onNavigate`)
- Modify: `src/components/layout/Shell.jsx` (thread `onNavigate` into `TopBar` — Shell already receives it)
- Test: a TopBar/Shell test (create `src/components/layout/TopBar.test.jsx` if none exists)

**Interfaces:**
- Consumes: `onNavigate(screenKey)` (Shell already has it; TopBar currently does not — add the prop), `screen` (already passed).
- Produces: no new exports; a contextual back-to-Roots control on setup screens.

- [ ] **Step 1: Write the failing test** — render `TopBar` with `screen='groups'` (a setup screen) and an `onNavigate` spy; assert a "← Roots" control exists and calls `onNavigate('roots')` on click. Render with `screen='roots'` (the home itself) and assert the control is ABSENT (no "back to Roots" while already on Roots). Render with a non-setup screen where a back-to-Roots makes no sense (e.g. `schedule` — decide the set) and assert per the chosen rule.

- [ ] **Step 2: Run it, verify it fails** — `npm run test -- src/components/layout/TopBar.test.jsx --no-file-parallelism` → FAIL (no affordance / no `onNavigate` prop).

- [ ] **Step 3: Implement** — add `onNavigate` to `TopBar`'s props; in `Shell.jsx` pass `onNavigate` into `<TopBar screen={currentScreen} onNavigate={onNavigate} onLogout={onLogout} />`. In `TopBar`, when `screen` is a setup/editable screen (define the set — the setup entity screens the nodes deep-link into: groups, activities, tiers, days, timeblocks, locations, anchors, cohorts, dayoverrides — reuse an existing list if one exists rather than duplicating), render a subtle "← Roots" button before/near the title calling `onNavigate('roots')`. Not shown on `roots` itself. Use existing token/link styling (match the app chrome; no new tokens).

- [ ] **Step 4: Run tests, verify pass** — same command → PASS. Confirm no regression in existing layout/chrome tests.

- [ ] **Step 5: Commit** — `git add src/components/layout/TopBar.jsx src/components/layout/Shell.jsx src/components/layout/TopBar.test.jsx && git commit -m "feat(roots): '← Roots' return affordance on setup screens (closes the inspect→edit→re-inspect loop)"`

---

## Self-Review

**Spec coverage:** landing swap (T3) · node navigation (T1) · readiness verdict single-source + banner (T2) · Import + worksheet + facility-map entry points (T2; facility node-panel link is a small add — see note) · post-import routing (T4) · **inspect→edit→re-inspect return loop / audit G4 (T5)** · ReadinessHub retirement (T3) · north-star seam preserved (no undo-needed state added). **Gap noted:** the facility-map *node-panel* link (option 3, the persistent home) is a one-line add to Task 1's panel (a Facility/Resources node "Open facility map →") — fold it into Task 1 or add as Task 2b; it reuses the same `onNavigate('locations')`.

**Audit reconciliation (added after owner review):** every ingest-audit finding is now either done, in this plan, or a filed ticket — D1/D2→T2/T3, G1→T3/T4, G2/G3→T4, **G4→T5**, G5→T93. Design-audit #1–#6 shipped (#109/#110); #7 (first-timer caption)→**T94** (filed); #8 (heading font)→parked with header copy. Roots-audit §12 (M2 multi-select, M3 field-level diff, M4 UNKNOWN, M5 blast-radius) intentionally deferred, recorded in that audit. D4 (dead `needs-attention` branch in `readiness.js`) is an owner-deferred one-line cleanup candidate to sweep while T2 touches `readiness.js`.

**Placeholder scan:** the only deferred content is the header/heading *copy*, which is an explicit PARKED global constraint (owner's language skill), not a plan gap. Button/structural copy is concrete.

**Type consistency:** `onNavigate(screenKey)` used consistently; `getReadiness`/`describeReadiness` reused from `readiness.js` (not re-derived); `RootsBanner` prop shape defined once in Task 2 and consumed the same in Task 4.

## Open decision for implementation (flag, don't guess)

The **post-import carrier** (Task 4) — how the outcome reaches Roots across a no-router screen swap — has two reasonable shapes (an `onNavigate` payload convention vs. a small "last import" signal read on mount). The implementer should pick the one most consistent with the current `setScreen` mechanism and note it; if neither is clean, STOP and raise it rather than bolting on global state.
