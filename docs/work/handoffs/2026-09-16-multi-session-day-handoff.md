---
title: "Handoff — 2026-09-16: the anchor-scheduling wave, at-rest encryption, and multi-session coordination"
document_type: handoff
authority: descriptive
status: active
date: 2026-09-16
created: 2026-09-16
task: docs/work/tickets/T175-at-rest-encryption-activation.md
archive_when: T183-PR2 has merged (Replace-exposure closed) and the at-rest encryption flip has been decided (on or explicitly deferred) by the owner
---

# Handoff — 2026-09-16

A long day with two parallel threads and 5–6 concurrent Claude sessions. This session ran
**coordination** for the fleet for most of it, and its own assignment (at-rest encryption) was picked
back up at the end. Read this before touching anchor-scope code, migrations, or the encryption flip.

## TL;DR for a fresh session
- **Nine PRs landed on `main` today** (see the ledger). The anchor-scheduling area was substantially
  reworked; treat `git log` as the source of truth over any stale doc.
- **Two things are still open**: (1) **T183-PR2** — the importer write-side fix that closes a *live*
  data-loss exposure (owned by the eager-clarke session, gating for merge as of end of day); (2) the
  **at-rest encryption flip** — code-complete and gate-verified, but turning it *on* is an owner
  decision + a real-app run on the owner's machine. **Encryption is OFF by default; nothing on disk is
  encrypted yet.**
- If you are the new session picking up encryption: the code is done and merged. What remains is
  **not code** — it's the owner's flip decision and a real-app verification. Do not flip it on from a
  headless/dev context.

## Ledger — what landed on `main` today (in order)
| PR | Ticket | What |
|----|--------|------|
| #443 | T62 | Fixed events link to activities **by name**, not a column that never existed — stopped Lunch/Rest-Hour being double-booked. |
| #444 | T171 item 4 | Memory-store location written down. |
| #445 | T182 | `ANCHOR_DUPLICATE` finding — flags a stale anchor/regular duplicate in a generated schedule. |
| #446 | T180 | A Recurring Event stores its age **divisions** (`unit_ids`), not a frozen group snapshot. Schema **v65** (recreates `anchor_activities`). New `src/engine/anchorScope.js` (`resolveAnchorGroupIds`). |
| #447 | T184 | Migration-classification guard was blind to helper-routed writes; added a row-diff layer (`migrationWriteTrace.js`). Reclassified **v13** as domain-state. |
| #448 | T185 | Payload-addressed finding dismissal (`findingKey.js`) so a materially-worse finding at the same cell isn't masked. |
| #449 | Q5 | A pinned activity stays rotatable on *other days* — anchored-activity exclusion is now keyed **group×day**, not group. `resolveAnchorDayIds` extracted into `anchorScope.js`. |
| #450 | T183-PR1 | Routes anchor scope through the shared resolver (`resolveAnchorUnitIds` added); kills a spurious re-import "scope changed" warning. AnchorsScreen label + `ingest.js` `liveAnchorScope` read-side. |
| #451 | T175 | `ensure-abi.js` rebuilds the encrypting fork for the Electron ABI (finding 2); T175 status de-staled. **Inert — does not flip encryption on.** |
| #452 | T183-PR2 | Write-side preserve — **closes the live Replace-re-import division-scope-flattening exposure.** T183 done end-to-end. |
| #453 | — | Docs-only: PLATFORM_STATE records T183 completing the anchor-scope resolver on both sides. |

`origin/main` tip after all this: **d920ce8**. `src/engine/anchorScope.js` now exports three resolvers
(`resolveAnchorGroupIds`, `resolveAnchorDayIds`, `resolveAnchorUnitIds`); its test file has 15 tests / 2
describe blocks — a guard-worth-knowing if you touch it.

## Open threads and owners
1. **T183-PR2 — write-side preserve — DONE (#452, merged).** The live Replace-re-import
   division-scope-flattening exposure is **CLOSED**. (For history: a Replace re-import deletes and
   recreates every anchor *and the divisions themselves*; the fix preserves `unit_ids` across the
   teardown via an old-tier-id→name→new-tier-id remap, reports residue, and requires all slots restore
   before claiming "preserved".) T183 is complete end-to-end (read #450 + write #452). No open work.
2. **At-rest encryption flip (T175) — owner-DEFERRED (2026-09-16).** NOT an open task to pick up. The
   owner explicitly chose to defer turning encryption on (see the dedicated section + the decision note
   at the top of T175). Everything is built, merged, verified, and staged OFF. A new session should not
   treat this as unfinished — the flip is a future owner action requiring their real-app run.
3. **cranky's Q5 follow-on** — Q5 was the last open question blocking Slice 0 of
   `docs/adr/2026-09-12-activities-as-one-entity-with-placement.md`; §7.2's `activity_id` FK is still the
   eventual model, unbuilt. Low priority.

## At-rest encryption (T175) — precise state
**Code-complete and gate-verified. NOT turned on.** Ticket: `docs/work/tickets/T175-at-rest-encryption-activation.md`.

Done and on `main`:
- Document + SQLite encryption, migration safety (backup-first, fatal-on-failure, verify-before-replace,
  shred-on-success), fail-closed on key failure — the merged foundation (#417/#421/#422/#423/#429/#431/#435).
- Real-app Electron run with `SHORESH_AT_REST_ENCRYPTION=on` **works end-to-end** (dev db) — caught and
  fixed the safeStorage-before-`app.whenReady()` bug (#441).
- **Finding 2** (encrypting driver placement): `ensure-abi.js` rebuilds the fork into
  `build/Release/better_sqlite3.node`; **verified it survives packaging** — a real `electron:build`
  lands the Electron-ABI binary at the `bindings()`-resolvable path in `release/mac/Shoresh.app`.
- **Finding 5** gate (`plaintext: true` is test-only) — on main, green.
- **Supply chain**: fork pinned exact `12.11.1`, integrity-hashed in lock, `npm audit` clean, matches the
  `better-sqlite3` 12.x line.
- **MCP/CLI key path** (was "flip blocker #2"): **code-complete** via T179 — `headlessDbKey.js`,
  `unlockDbKey.js`, the `unlock-key` script, and the key threaded through every MCP tool + the ingest
  CLI. Not a code gap; the owner sets `SHORESH_DB_KEY` (from `npm run unlock-key`) when using those tools
  against an encrypted db.
- **SECURITY.md boundary wording** — DRAFTED and staged inside the T175 ticket (the honest, narrower
  guarantee: protects a powered-off/stolen device, **not** a same-OS-login attacker on a shared machine;
  trusted-device model). It must land **in the flip commit**, not before (it claims encryption is on).

Genuinely remaining — **owner only**:
- The **flip decision** (default-on). Encryption is a deliberate hard-fail: no key ⇒ no data. Flipping
  it on ships that.
- A **real-app run on the owner's machine**: install the packaged build, launch with encryption on,
  confirm the real Test Camp migrates once and reads back. The ticket is explicit this "must not be
  skipped" — it cannot be proven by unit tests or on a dev db.
- An **independent `security-assessment` re-review** of the migration diff before the flip merges.
- Optional: a free self-signed cert to remove the one-time keychain prompt after app updates (no Apple
  account needed — Apple Developer ID is a distribution/Gatekeeper concern, **not** required for
  encryption); a hardware test of whether `safeStorage` survives a keychain reset / Migration Assistant.

## Coordination lessons learned today (the reusable ones)
The day's recurring defect family: **a check structurally incapable of returning the answer it was
trusted for**, and **absence read as success**. Concrete instances, all worth carrying:
- **Read the log verdict, never the exit code.** `gh pr merge` printed a fatal "'main' is already
  checked out" on *every* successful merge today (it's the local branch-delete step; the remote merge
  succeeded). And a background wrapper's `echo`/`tee` exit masked npm's real non-zero. Verify merges by
  **content on `origin/main` + `gh pr view --json state`**; verify gates by the printed `VERIFY
  PASSED/FAILED` line.
- **A watch keyed on `pgrep -f 'scripts/verify.js'` (or `vitest`) matches the watcher's own shell command
  line** → it can never reach zero and inflates every count. Match `node scripts/verify.js`.
- **Process ownership is answered by cwd (`lsof -a -p <pid> -d cwd`), not parentage** — an orphan
  reparents to PPID 1 and is invisible to a "are these my children" check; and a worktree resolves
  binaries from the *root* `node_modules`, so a binary path lies about which checkout is running.
- **A gate that fails at step N says nothing about steps N+1.** A red at `test` never ran
  `check:governance`; run the fast `check:governance` directly to surface *all* governance gaps at once
  rather than one-per-15-minute-gate.
- **`check-governance.js` reads commit dates — it is blind to the working tree.** It only means something
  **after you commit**. Governance findings also cascade (fix the enum → an index-stale appears → a
  platform-state-stale appears); iterate to 0 findings on the committed branch.
- **Green under load is trustworthy; a red that names its own cause is trustworthy under load too.** Only
  a *flaky/unattributable* red (a bare timeout) needs a quiet re-run.
- **Ticket numbers must be checked across ALL worktrees** (`ls .../.claude/worktrees/*/docs/work/tickets/`),
  not just `main` — `main` lagged at T177 while T178–T185 lived in unmerged worktrees; a duplicate ID
  hard-fails CI.
- **Aggregate/generated docs (`INDEX.md`, `PLATFORM_STATE.md`) cannot be batch-merged cleanly** — each
  branch has a partial version. In a serial merge each PR regenerates them against then-current main; in
  a batched integration branch, regenerate once and keep all notes.

## Standing multi-session gate protocol (used today, drained a loadavg-310 pileup)
- **One full `npm run verify` at a time**, routed through a coordinator; focused single-file runs are
  unrestricted.
- **The gate token = "your turn on the box." It is NOT merge authorization.** Trunk stays human — every
  merge needs that session's *own* owner's direct go. A coordinator relaying "the owner approved" is
  permission-laundering and was correctly refused all day.
- **Finish = a positive self-report** ("done, here's the verdict line"), never an inferred absence.
- For an overlapping wave, a **batched integration gate** (merge all ready branches into one throwaway
  integration branch, run one gate, land serially in tested order) beats N serial gates: it proves
  integration and surfaces every metadata gap cheaply. That's how T185+Q5+T183-PR1 landed.

## Immediate next actions for the new session
1. If continuing encryption: **do nothing in code** — it's done. Surface the flip as an owner decision;
   offer to walk the owner through the real-app run and to prepare the flip commit (default-on + the
   staged SECURITY.md wording + the absence-test copy change) for their go. Get an independent
   `security-assessment` review before that merges.
2. If T183-PR2 hasn't merged: check with the eager-clarke session (or adopt from the T183 ticket + ADR);
   it closes a live exposure.
3. Coordinate with any other live sessions per the protocol above before running a full gate.
