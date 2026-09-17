---
title: "localClient.write gets a caller-side bounded timeout that answers as a normal write failure; days_of_operation gets the UNIQUE index its own comments already claimed"
document_type: adr
authority: normative
status: accepted
amended: 2026-09-17
date: 2026-09-17
supersedes: []
implementation_state: in_progress
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs:
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
  - docs/adr/2026-09-09-field-provenance-in-the-document.md
related_tickets:
  - docs/work/tickets/T203-an-unbounded-write-hang-is-unrecoverable-in-app.md
---

# localClient.write gets a caller-side bounded timeout; days_of_operation gets its missing UNIQUE index

## Decision

1. **Ship a bounded timeout on the renderer side of `localClient.write`/`deleteEntity`/`bulkReplace`** (`src/localClient.js`), not in `preload.js` or `electron/main.js`. Bound: **8000ms**. On expiry, reject with a **thrown `Error`** whose message the existing `describeWriteFailure`/`writeErrorMessage` classifier can read — not a new `{status}` shape. This is the general fix; it makes a hang resolve like any other write failure, so T201's existing bootstrap retry/notice handles it with zero new UI.
2. **Add `writeErrorMessage.js` a dedicated pattern for the timeout message**, distinct from the existing `TRANSPORT` regex — the existing "your devices could not reach each other" copy is now inaccurate for a purely local write (see Context) and must not be reused for this case.
3. **Add `UNIQUE(camp_id, day_of_week)` to `days_of_operation`**, as a schema migration following the exact precedent of `idx_groups_camp_name` (v12) and `idx_cohorts_camp_name`. This is not exclusive with (1) — it closes a real, independently-existing duplication hazard in `seedDays`, and it corrects two comments that already assert this constraint exists.
4. **T201's bootstrap `useRef` lock coupling is a Maker-implementation concern in `src/App.jsx`/`useDeviceMode.js`, out of this ADR's authority** — flagged as an open question below because the file is owned by a concurrent ticket (T202) in this worktree.

## Context

### The write path is fully synchronous today — this changes where a hang can actually come from

Read against the code at this branch's base (`2d49c55`, post-Stage-6-cutover, `SYNC_ENGINE=automerge` default per `electron/sync/automerge/syncEngineFlag.js`):

- `electron/main.js`'s `write()` handler (line 993) is a plain synchronous function: `requireAuthorized` → `syncClient.write(...)`. No `await` before the call.
- `syncClient` under the default engine is `createLocalWriteClient` (`electron/sync/localWriteClient.js`). Its `write()` is declared `async` but contains **no internal `await`** — `appendOp` runs synchronously to completion in the same tick.
- `appendOp` (`electron/ops/operations.js`) does one synchronous `better-sqlite3` transaction, then synchronously calls `recordLocalWrite` (`electron/sync/automerge/liveDoc.js`), which mutates the in-memory Automerge document and persists it — also synchronous, wrapped in a 3-attempt retry loop (`withRetry`), never an unresolved promise.

**This is not the architecture the ticket's prose describes.** The ticket names "a write blocked indefinitely on a locked SQLite file" as a hang cause. Verified against the pinned dependency (`better-sqlite3@12.11.1`, resolved via `package-lock.json`; confirmed in `node_modules/better-sqlite3/lib/database.js:34`, `const timeout = 'timeout' in options ? options.timeout : 5000`): `electron/db/localDb.js` opens the device db with `new Database(filePath)` — no `timeout` option — so it inherits the **5000ms default `busy_timeout`**. A locked SQLite file does not hang this path forever; it throws `SQLITE_BUSY` after 5s, which `localClient.write` already surfaces as a thrown error today. This narrows what a genuine unbounded hang actually is, under the current architecture: **the main process itself not answering** — crashed, deadlocked, or pegged in a synchronous CPU-bound operation elsewhere that never yields back to the event loop. Since the rest of `write()`'s own body is synchronous, once it starts it cannot itself "hang" in the sense of an unresolved internal await; what can hang is the **IPC round-trip observed from the renderer** when the main process never gets back to processing the queued response (or never gets back to *anything*, because something has wedged its single thread).

This is the load-bearing consequence for **where the timeout must live** (the `adhd` hardware-engineer frame's framing, confirmed by reading the code rather than assumed): a timer set inside `electron/main.js` cannot be trusted to fire if the very thing suspected of being wedged is that process's own event loop — the timer callback would be queued behind the same stall. A timer in the **renderer** (`src/localClient.js`) runs on a separate OS process with its own independent event loop; it fires regardless of what has happened to main, which is exactly the failure this ticket needs covered. `electron/preload.js` is a thin `contextBridge` pass-through with no logic of its own today and is the wrong place to add a decision.

### The trap the `adhd` competitor-frame run surfaced, and why it changes the shape of the fix

Divergent ideation (5 parallel frames — hardware, regulator, competitor/attacker, 3am-on-call, remove-load-bearing-assumption) converged on one recurring, load-bearing risk: **a timeout that resolves the caller's promise does not stop the underlying write.** If main was merely *slow* rather than truly dead, `appendOp` can still complete and land after the renderer has already told the caller "this failed" and moved on. Two ways this bites, both of which change the implementation, not just the number:

- **A synthetic-success trap**: if the timeout is implemented as "assume it landed" (or is set so tight it fires before a merely-slow-but-fine write finishes), the caller is lied to. **Decision: the timeout must resolve to an explicit failure (a thrown Error), never a success**, matching the existing tri-state contract (`applied` / `rejected` / throws) rather than inventing a fourth resolved shape.
- **A duplicate-row trap on automatic retry**: for a caller that (a) mints a fresh id and (b) writes that id's first field as the row-creation trigger, a timeout-then-retry sequence where the original write actually lands is indistinguishable from "the row still doesn't exist" unless something makes the second attempt collide instead of duplicate. This is exactly the mechanism `seedDays.js`'s own header TODO already names for `days_of_operation`, and it is why decision (3) is not cosmetic — it is what makes decision (1) safe for that one caller.

### Caller-by-caller idempotency enumeration (every `localClient.write`/`deleteEntity`/`bulkReplace` call site)

Found via `grep -rl` for `localClient\.(write|deleteEntity|bulkReplace)\(` under `src/` (14 non-test files) plus `graphify affected` cross-check for `localClient.write` against `~/dev/shoresh/graphify-out/graph.json` (no additional call sites beyond the grep set; graphify's blind spots — object-literal methods, string-read imports — don't apply here since `localClient` methods are named exports called by direct reference, not read as a string or invoked off a returned literal).

| Caller | Pattern | Timeout-then-late-land safe? |
|---|---|---|
| `src/data/scheduleRepository.js` `writeFields` | field write to an **existing, caller-supplied** id | Yes — an UPDATE re-applying the same value is idempotent by construction |
| `src/data/setupCrudRepository.js` `writeFields` | same pattern | Yes |
| `src/utils/ensureCohort.js` | mints `crypto.randomUUID()`, writes `name` first (row-creation trigger) | **Yes, already protected** — `cohorts` has `UNIQUE(camp_id, name)` (`idx_cohorts_camp_name`); a retry's second row collides rather than duplicates |
| `src/utils/seedDays.js` | mints `crypto.randomUUID()`, writes fields on a new row (row-creation trigger is the first field write, per `projections.js`'s `ensureExists`) | **No — this is the caller decision (3) exists for.** `days_of_operation` has no uniqueness constraint today, so a timed-out-but-landed write followed by the bootstrap's own retry (T201) can produce two rows for the same weekday |
| `src/screens/CampScreen.jsx` | field write to the single `camps` row (fixed, known id) | Yes |
| `src/screens/CohortsScreen.jsx`, `AnchorsScreen.jsx`, `TiersScreen.jsx`, `TimeBlocksScreen.jsx` | `deleteEntity` on a known id | Yes — delete is idempotent; re-deleting an already-deleted or now-absent row is a no-op |
| `src/screens/SpecialEventsScreen.jsx`, `event/EventGridEditor.jsx`, `specialDay/SpecialDayGridEditor.jsx` | mint `crypto.randomUUID()` per user gesture (add-row flows), field writes and `deleteEntity` | **Human-mediated, not automatic** — a director sees a failure notice and decides whether to click "add" again. This is the same pre-existing exposure every add-flow already has under any *other* write failure (a constraint violation, a genuinely dropped IPC message) that resolves today without hanging. Adding a bounded timeout gives this exposure one more trigger; it does not create a new failure class. Out of scope for this ADR — a general "safe retry for every add-flow" fix is a larger, unrelated piece of work than T203 asks for |
| `src/screens/ImportScreen.jsx` | commit-time field writes over an already-validated `newId()` allocator | Same human-mediated category as above; import commit already has its own retry/undo machinery (`ingestCommit`/`ingestUndo`) independent of this ADR |
| `src/data/scheduleRepository.js` `bulkReplace` (`template_slots`) | delete-all-then-reinsert for a `scope_id` | Yes — idempotent by construction; replaying the same replacement twice produces the same end state |

**Conclusion: exactly one caller — `seedDays.js`, reached only through T201's automatic (unattended) bootstrap retry — needs decision (3) to make decision (1) safe.** Every other caller is either idempotent by construction or human-mediated with an existing, unrelated exposure this ADR does not need to close.

### The bound is measured, not guessed

A throwaway benchmark (`electron/ops/t203.bench.test.js`, deleted after use — not part of this change) ran 200 sequential single-field writes through the **real production write client** (`createLocalWriteClient`, `SYNC_ENGINE=automerge` default, real `better-sqlite3` transaction + real Automerge document mutation and disk persistence), via the same fixture (`openTemplatedDb`) `electron/ops/operations.test.js` already uses:

```
{ "N": 200, "mean": 31.1ms, "p50": 6.75ms, "p95": 168.3ms, "p99": 293.6ms, "max": 307.3ms }
```

The p95/p99 tail (well above the sub-millisecond cost of a single SQLite UPDATE) is consistent with the Automerge document's periodic disk-persistence cost inside `recordLocalWrite`/`withRetry`, not with lock contention. **Recommended bound: 8000ms.** Rationale: ~26x the observed worst case (307ms) on a dev machine under test-harness conditions — enough headroom for a real machine under load, antivirus scanning, or a spinning disk to still resolve well inside the bound — and comfortably above `better-sqlite3`'s own 5000ms `busy_timeout` ceiling, so the app-level timeout never preempts a `SQLITE_BUSY` retry that SQLite itself is already about to resolve on its own. Short enough that a truly-wedged main process does not leave the director staring at a spinner for an unreasonable time before seeing the existing T201 failure notice.

### Fitting the existing outcome vocabulary — decided, not invented

Read `electron/ops/operations.js` (`DOCUMENT_OUTCOME`: `'applied' | 'deferred' | 'engine-off' | 'not-modeled' | 'failed'` — describes whether the **document**, not the IPC call, has the write), `electron/sync/localWriteClient.js` (`{status: 'applied'}` / `{status: 'rejected', reason, existing}`, or throws), `src/utils/seedDays.js` and `src/data/scheduleRepository.js`/`setupCrudRepository.js`'s shared `writeFields` success predicate (`result.status === 'applied' || result.status === 'queued'`), and `src/utils/writeErrorMessage.js` (`describeWriteFailure(err, whatFailed)`, pattern-matching `err.message` — no `describeWriteFailure*` variant exists beyond this one file; the ticket's guess at the name was close but the file is `writeErrorMessage.js`).

- **`DOCUMENT_OUTCOME` does not apply** — it answers "does the authoritative document have this write", a question that presupposes the op-log write already committed. A timeout means the IPC caller doesn't know that yet; it is a different axis entirely.
- **The existing `{status}` resolved shape does not fit either** — every current status (`applied`, `rejected`) is a completed, known outcome. A timeout is explicitly an *unknown* outcome (`org-interface-contracts`: "does the caller have a way to know 'this may or may not have applied'"). Inventing a fourth status value would silently pass every `result.status === 'applied' || result.status === 'queued'` check unless every one of the ~14 call sites is also updated to check for it — a much larger, riskier diff than making it fail the way callers already expect a failure to fail.
- **Decision: expiry throws.** `localClient.write`/`deleteEntity`/`bulkReplace` already document that they "throw on error" (ticket's own framing, confirmed by `writeFields`'s explicit `throw new Error(...)` on a non-applied status and every screen's existing `try { await localClient.write(...) } catch (err) { ...writeErrorMessage(err, ...) }` pattern). A thrown `Error('write timed out after 8000ms — the app could not confirm this saved')` needs **zero changes** at any of the ~14 call sites; every one of them already has a catch path that runs the message through `writeErrorMessage`/`describeWriteFailure`.
- **`writeErrorMessage.js` needs one addition, not a rewrite.** Its existing `TRANSPORT` regex (`/disconnected|timeout|not connected|ECONNREFUSED|network|socket/i`) would match the word "timeout" in the message above and return **"Your devices could not reach each other — try again when they are both on the network."** That copy is now wrong for this case: under the Stage-6 CRDT architecture a local write never talks to another device, so blaming "devices" and "network" for a wedged single-process write is exactly the misdirection `writeErrorMessage.js`'s own header comment warns against ("a director sent to check their wifi ... concludes the app is broken"). **Add a `WRITE_TIMED_OUT` regex checked before `TRANSPORT`**, matching a dedicated substring the timeout error's message carries (e.g. `/^write timed out/i`), returning a message that names the real situation and points at the ADR's accepted recovery: *"The app could not confirm this saved in time. If this keeps happening, restart the app."* This is additive — `TRANSPORT`'s existing behavior for its original cases (a genuinely dropped connection, `ECONNREFUSED`) is untouched.

### `org-interface-contracts` checklist

- **Idempotency** — addressed above per-caller; the one gap (`seedDays`) is closed by decision (3), not by decision (1) alone.
- **Concurrent retries** — T201's bootstrap retry is the only *automatic* retry in scope; covered above. Human-initiated retries from screens are pre-existing, unrelated exposure (see enumeration table).
- **Unknown outcomes** — this is the center of the design: the timeout is explicitly modeled as "may or may not have applied," resolved as a distinguishable thrown error rather than coerced to either `applied` or `rejected`.
- **Error shape** — the thrown `Error`'s message is a distinguishable, documented string (`write timed out after Nms...`), consumed by one classifier addition in `writeErrorMessage.js`. Not a silent no-op; not a raw unrecognized throw (the existing fallback message in `describeWriteFailure` already handles genuinely unrecognized errors honestly, so even an un-classified path degrades gracefully).
- **Scope/authority boundary** — untouched. `authorize()`/`requireAuthorized` runs synchronously inside `electron/main.js`'s `write()` before `syncClient.write` is ever reached; the renderer-side timeout wraps the IPC call *after* that boundary and has no visibility into or effect on it.

### Why `days_of_operation`'s UNIQUE index is safe to add now

Confirmed against the actual schema (not the stale comments): `electron/db/schema.sql`'s `days_of_operation` `CREATE TABLE` (current, ~line 622) has **no** `UNIQUE` clause — only `id TEXT PRIMARY KEY`. Two places assert otherwise and are both wrong today: `electron/db/schema.sql`'s comment near the `time_blocks` definition ("mirrors groups/cohorts/days_of_operation's camp-level UNIQUE") and `electron/db/localDb.js`'s Round-2-Red-Hat-fix comment for `time_blocks` ("unlike groups/cohorts/days_of_operation (all UNIQUE(camp_id, name))"). Neither migration history nor `schema.sql` ever added the constraint or an equivalent index — confirmed by `grep` for `idx_days` (nothing) against the precedent pattern that *does* exist for `cohorts` (`idx_cohorts_camp_name`, migration ~v11) and `groups` (`idx_groups_camp_name`, migration v12).

**Migration plan, following the exact `idx_groups_camp_name` precedent** (`electron/db/localDb.js` version-12 migration): at the next schema version, in the guarded `>= N-1 && < N` block (per this repo's migration-guard form — never a bare `< N`):

1. Dedupe survivors: `SELECT camp_id, day_of_week, MIN(rowid) as keep_rowid FROM days_of_operation GROUP BY camp_id, day_of_week HAVING COUNT(*) > 1` (mirrors the `groups` dedup at `localDb.js` ~line 425, adapted to `days_of_operation`'s natural key — `day_of_week`, not `label`, since `label` is what `seedDays.js`'s repair pass fills in and is not guaranteed unique the way the weekday number is).
2. Repoint every FK reference (`time_blocks.day_id`, `anchor_activities.day_id`, `template_overlays.day_id`, and any other `REFERENCES days_of_operation(id)` column — confirmed via `grep -n "day_id.*REFERENCES days_of_operation"`, four call sites in `schema.sql`/`localDb.js`) from each duplicate's id to its group's `keep_rowid`'s id, exactly as the `groups` migration repoints `template_slots.group_id`.
3. Delete the now-unreferenced duplicate rows.
4. `CREATE UNIQUE INDEX IF NOT EXISTS idx_days_camp_dayofweek ON days_of_operation(camp_id, day_of_week);`
5. `db.prepare('INSERT OR IGNORE INTO schema_migrations ...').run(N, ...)`.

**This does not require destroying data the camp needs** — it merges exact accidental duplicates of the same weekday the same way the `groups`/`time_blocks` migrations already did for their tables, which is established, reviewed precedent in this codebase, not a novel destructive step. No STOP-AND-ESCALATE condition applies. Whether any existing dev database actually has such duplicates today is unverified (no seeded dev data was inspected as part of this design) — Maker's integration test must include a fixture that plants a pre-existing duplicate (per this project's own "plant the defect the guard cannot see" lesson) and asserts the migration merges it, not just that it runs clean on an empty table.

Both stale comments (`schema.sql` near `time_blocks`, `localDb.js`'s Round-2 fix comment) become **true** once this migration lands — no rewrite needed, they were describing the intended end state, just prematurely.

## Files/modules affected

- `src/localClient.js` — add the bounded-timeout wrapper around the three mutating IPC calls (`write`, `deleteEntity`, `bulkReplace`; `deleteEntity`/`bulkReplace` route through the same `announcing()` composition already, so the timeout wraps at that same seam).
- `src/utils/writeErrorMessage.js` — add the `WRITE_TIMED_OUT` regex/message, ordered before `TRANSPORT`.
- `electron/db/schema.sql`, `electron/db/localDb.js` — new migration (schema version 66), following the `idx_groups_camp_name`/`idx_cohorts_camp_name` precedent exactly.
- `electron/db/localDb.js`'s and `schema.sql`'s two stale comments — become accurate once the migration lands; no separate doc-only commit needed.
- `test/integration/run.automerge.js` and/or a new integration case — required by `GOVERNANCE_INDEX.md` §3–8 for the `database-sync`-classed piece (the migration): fresh-install-vs-migrated-db equivalence, plus a planted-duplicate fixture per the migration plan above.
- Out of this ADR's authority: `src/App.jsx`/`src/hooks/useDeviceMode.js` (T201's `bootstrapInFlight` lock) — see Open questions.

## Reused vs. new

**Reused:** the existing tri-state write contract (`applied`/`rejected`/throws) — no new resolved shape; `writeErrorMessage.js`'s existing classifier architecture — one new regex branch, not a new mechanism; the exact migration pattern already proven twice in this codebase (`idx_cohorts_camp_name`, `idx_groups_camp_name`) — no new migration technique; `seedDays`'s/`ensureCohort`'s existing check-then-repair idempotency shape — unchanged, now actually safe for `seedDays` under a timeout-then-late-land race.

**New:** the timeout wrapper itself (a `Promise.race` against a fixed-duration timer in `src/localClient.js`); the `WRITE_TIMED_OUT` message branch; the `days_of_operation` unique index and its dedup migration.

## ADR required: yes

Filed at `docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md` (this document). Meets the constitution's bar on two independent grounds: (1) changes an existing IPC contract every `localClient.write`/`deleteEntity`/`bulkReplace` caller already depends on (a new failure mode every caller must tolerate, even though no caller needs code changes to tolerate it correctly); (2) introduces a new persistent schema constraint (`days_of_operation` UNIQUE index) other code (the dedup migration, `seedDays`'s repair pass) now depends on.

## Open questions for Governor

1. **`bootstrapInFlight` release timing in `src/App.jsx`/`useDeviceMode.js` is out of this ADR's file authority** (explicitly reserved to T202 in this worktree). Decision (1) only closes the hang if the bootstrap `await`'s the now-bounded `seedDays`/`ensureCohort` calls and releases its lock once they reject — which they will, once decision (1) ships, without any change to the lock's own logic. Confirm with whoever owns T202 whether `bootstrapInFlight` already releases on a caught rejection (if T201's existing "both compose into one notice, retry re-runs them" already awaits with a `.catch`/`Promise.allSettled`-style pattern, decision (1) alone finishes the fix with zero App.jsx changes; if the lock is only released in a `.then`, a small change there is still needed and must be coordinated with T202 rather than made here).
2. **8000ms is a recommendation, not a product decision already made** — it trades "spurious failure on a slow-but-fine write" against "director waits N seconds before seeing a recovery notice." The measured data supports 8000ms with large headroom; if the owner has a different tolerance for how long a "saving…" state may sit before surfacing failure, that's a product call, not a technical one.
3. **Whether to migrate `days_of_operation` in the same release as the timeout, or sequence it as a fast independent follow-up** — the ticket frames them as not exclusive and recommends (1) first; this ADR licenses both, but the actual release sequencing (one PR or two) is Governor's call, not an architectural one.

## Amendment (2026-09-17) — decision 3's mechanism corrected; decisions 1 and 2 unchanged

Red Hat found two HIGH findings against the shipped v66 migration. Both are confirmed real by independent code reading (not taken on report). Decisions 1 and 2 (the renderer-side timeout and the `writeErrorMessage.js` branch) are unaffected — this amendment corrects **only** how decision 3 is implemented, not whether to do it.

### Finding 1 (confirmed) — the unique key is not the field stamped at row creation

`electron/ops/projections.js`'s `days_of_operation.ensureExists` inserts `(id, camp_id, label='')` only; `day_of_week` is NULL until a **separate**, later `write()` call sets it. Each `write()` call is its own transaction (`seedDays.js`'s own comment: "Fires one write() per field"). So the row's existence (camp_id + label) commits in one transaction, and `day_of_week` is set in a second, independent transaction — unlike `cohorts`, where the unique field (`name`) **is** the first field written, so `ensureExists`'s placeholder insert and the unique-triggering `UPDATE` are the same transaction, and a losing writer's whole op (row creation included) rolls back together, leaving no row at all.

For `days_of_operation`, `UNIQUE(camp_id, day_of_week)` does not stop the duplicate — SQLite treats NULL as distinct in a unique index, so the placeholder row always inserts. The collision instead lands on the later `day_of_week` UPDATE, which fails *alone*, leaving a **torn row**: id, camp_id, label set, `day_of_week` NULL forever. `seedDays.js`'s repair matcher (`days.find(d => d.day_of_week === day.day_of_week)`) can never match a NULL-day row, so the orphan is permanent, and the original v66 dedup (which grouped `WHERE day_of_week IS NOT NULL`) is blind to it too. **Ruling: this is a real gap in decision 3 as shipped — the fix stays inside decision 3 rather than reversing it.**

**Fix, in two parts, both required for the retry path to actually converge (not just stop leaking):**

1. **`src/utils/seedDays.js`'s repair matcher is widened.** In addition to the existing `day_of_week === day.day_of_week` match, also match a torn orphan: same camp, `day_of_week IS NULL`, `label === day.label`. When found, adopt that row's id (write the missing `day_of_week`/`sort_order` onto it) instead of minting a fresh `crypto.randomUUID()`. This is what makes a timeout-then-retry sequence converge to one complete row instead of leaking a permanent orphan on every retry that lands late.
2. **The unique constraint becomes a partial index**: `CREATE UNIQUE INDEX IF NOT EXISTS idx_days_camp_dayofweek ON days_of_operation(camp_id, day_of_week) WHERE day_of_week IS NOT NULL;` — SQLite has supported partial indexes since 3.8.0, long predating this project's pinned version. This makes the constraint apply exactly to the case that actually threatens correctness (two *complete* rows for the same weekday), consistent with SQL NULL semantics rather than fighting them, and is friendlier to the sequencing fix below.

Pre-existing on-disk orphans and true duplicates still need one cleanup pass — folded into the Finding 2 fix below, since that fix changes *how* the migration runs, not just what it computes.

### Finding 2 (confirmed) — the domain-state guard does not survive a restart, and the branch it guards is not dead in practice

Verified independently by reading `electron/db/localDb.js`'s `migrationSpanFor`/`openLocalDb` and `electron/main.js`'s sync-start guard (~line 2610). `migrationSpanFor` is a `WeakMap` keyed by the in-process `db` handle, populated once per `openLocalDb()` call as `{from: existingVersion, to: getSchemaVersion(db)}`. On the launch where migration 66 actually runs, `from < to` and the guard correctly blocks sync. On the **next** launch, `openLocalDb` reads `existingVersion === CURRENT_SCHEMA_VERSION` (already 66) before any migration runs, so `migrationSpans.set(db, {from: 66, to: 66})` — `from === to`, `domainStateMigrationsIn` returns nothing, and the guard is silently inert. A plain app restart — not an adversarial action, the single most ordinary event in this app's lifecycle — defeats the refusal, and sync then proceeds against a document that still holds the rows v66 deleted from SQLite; `projectAll`'s delete-reconcile resurrects them on the next merge. `electron/db/migrationDomainState.js`'s own header comment concedes the mechanism is single-launch by design ("this exists for the next one") — v66 *is* that next one, and it is the first migration to actually exercise the gap the mechanism's own documentation anticipated but never stress-tested against a restart.

**Governor asked whether the delete branch is realistically reachable, given duplication "could until now only arise from a race that required an unbounded hang."** That premise does not hold. Duplicate `days_of_operation` rows do not require the T203 hang at all: under the Stage-6 CRDT architecture, **every device seeds its own camp locally and independently** (`seedDays` runs per-device, per-mount). Two devices that each bootstrap the same camp before their first sync — an entirely ordinary onboarding sequence (director's laptop and an assistant's laptop both set up before pairing, or any camp whose database predates this app's sync layer) — each mint their own `Monday` row with a different id, and Automerge CRDT merge reconciles two independently-authored rows claiming the same weekday. The delete/repoint branch is not a dead corner; it is the expected path for any multi-device camp's first sync. "Probably never happens" does not hold and must not be used to justify shipping the guard as-is.

**Ruling: (b) — change v66 so it is not a domain-state migration at all, by routing the dedup through the document instead of SQLite alone.** This is not a novel invention: it is exactly what `migrationDomainState.js`'s own header prescribes as "the correct repair" ("apply the same change THROUGH the document, which a generic mechanism cannot author") and it eliminates Finding 2 structurally — there is nothing left for the domain-state guard to protect against once SQLite and the document never diverge in the first place, the same way every other ordinary mutation in this app already keeps them in lockstep. (a) ship-anyway-plus-spinoff is rejected: this is not a rare edge case to track as a follow-up, it is the expected first-sync path for any multi-device camp, and shipping a migration whose entire purpose is correctness with a known, ordinary-restart-triggered data-resurrection bug is not responsible. (c) escalate-to-owner is not needed: there is no data-destruction tradeoff requiring a product decision here — `migrationDomainState.js` already establishes the technical doctrine this fix follows, so this stays inside already-accepted architecture rather than opening a new one. Governor and the owner should still be told this amendment changed decision 3's shipped mechanism, since the original ADR was already `accepted`.

**Corrected shape for decision 3, replacing the v66 schema migration:**

1. **A new per-mount, document-routed repair utility**, `src/utils/dedupeDays.js`, following the exact `seedDays.js`/`ensureCohort.js` precedent (idempotent check-then-repair, called from bootstrap alongside them — same App.jsx/`useDeviceMode.js` coordination note as the original ADR's open question 1, now load-bearing for this piece too, not just decision 1). It lists `days_of_operation` for the camp and, for each camp:
   - **Torn orphans** (`day_of_week IS NULL`, `label` matches one of the five canonical weekday labels): adopt via an ordinary `localClient.write` completing the row — same mechanism as the widened `seedDays.js` repair above; the two are the same fix applied at two call sites (the mount that created the orphan, and a defensive general sweep for orphans left by any other cause).
   - **True duplicates** (two or more *complete* rows sharing `camp_id` + `day_of_week`): repoint the FK-bearing rows (`time_blocks.day_id`, `anchor_activities.day_id`, `template_overlays.day_id`, `elective_sets.day_id`) from the losers to the keeper via ordinary `localClient.write` calls, then `localClient.deleteEntity` the losers. Every one of these calls goes through the standard op-log/document write path (`appendOp` → `recordLocalWrite`), so SQLite and the document change together, exactly like every other mutation in this app — there is no SQLite-only step left to diverge.
2. **The `idx_days_camp_dayofweek` partial unique index is created by the same repair utility, not by a numbered pre-open schema migration.** After confirming (by re-listing `days_of_operation`) that no duplicates remain for this camp, `dedupeDays.js` calls a small new main-process IPC handler that issues `CREATE UNIQUE INDEX IF NOT EXISTS ...` directly (idempotent, safe to attempt on every mount). This ordering is required, not just simpler: `CREATE UNIQUE INDEX` at blind db-open time on a device that still has duplicates would throw and break the app outright — the index can only be added once the document-routed dedup above has already run to completion on that specific device. Adding an index is a pure SHAPE change (no row data touched), so once it runs after confirmed-clean state it is correctly a `SCHEMA_ONLY_MIGRATIONS`-class operation ("Safe at any lifecycle point," per `migrationDomainState.js`'s own classification) — it is simply triggered by the application layer instead of the version-gated chain, because *when* it is safe to run depends on document-routed state this repair utility, not `openLocalDb`, can see.
3. **`electron/db/migrationDomainState.js`'s `DOMAIN_STATE_MIGRATIONS` map loses its v66 entry entirely** — there is no longer a numbered migration that edits modeled row data outside the document. If Maker already registered v66 there per the original ADR, that registration is removed as part of this correction, and `migrationDomainState.test.js`'s enumeration-completeness check is expected to require this (a schema version with no corresponding migration content is itself a discrepancy the test should catch — Maker verifies against the actual test, not this prose).
4. **The two stale comments** (`schema.sql` near `time_blocks`, `localDb.js`'s Round-2 fix comment) still become true once `idx_days_camp_dayofweek` exists on a given device — unchanged from the original ADR, just created by a different mechanism now.

### Cost

Bounded, not a redesign: one new ~60-90 line utility mirroring an existing pattern this codebase already has twice; a small widening of `seedDays.js`'s existing matcher; one new narrow IPC handler for the index creation; removal of the v66 entry from `DOMAIN_STATE_MIGRATIONS`. Decisions 1 and 2 (`src/localClient.js`'s timeout, `writeErrorMessage.js`'s new branch) are untouched by this amendment.

### Test plan addition (non-vacuous, per this project's own "plant the defect the guard cannot see" standard)

Maker's test plan must include, at minimum: (a) a fixture that plants a torn orphan (`day_of_week NULL`, a canonical label, no matching complete row) and asserts `seedDays`'s widened matcher adopts it rather than creating a new id; (b) a fixture with two independently-authored complete rows for the same camp+weekday (simulating the two-devices-seed-before-first-sync scenario) and asserts `dedupeDays.js` repoints references and deletes the loser through the document-routed path — assert the **document**, not just SQLite, reflects the deletion, since that is exactly the axis Finding 2 was about; (c) a restart-simulation case: run the repair, close and reopen the db handle (a fresh `openLocalDb()` call, mirroring what actually defeated the original guard), and assert sync is still permitted to start — proving there is no longer a guard to defeat, not merely that the old guard fires once.

## Amendment 2 (2026-09-17) — decision 3 is split out; decisions 1 and 2 ship alone

**Owner-approved.** Decision 3 (the `days_of_operation` UNIQUE index, schema v66, and the dedupe/FK-repoint migration) is **removed from this ADR's shipping scope** and re-ticketed as **T205**. Decisions 1 and 2 ship on their own. This section exists because decision 3 was argued above as *what makes decision 1 safe for `seedDays`*, and reducing the change without revisiting that claim would leave this document asserting something it no longer delivers.

### What the timeout does NOT make safe on its own

The original argument stands as far as it went: `seedDays` is the one caller reached by a retry that no human individually authorises per attempt, it mints a fresh `crypto.randomUUID()` when it does not find an existing row for a weekday, and a timed-out write may still land. Without a uniqueness constraint, a sufficiently unlucky sequence can therefore produce **two rows for the same weekday**:

1. The mount-time `seedDays` write for, say, Monday exceeds 8000ms and rejects.
2. The director clicks "Try again". The retry's `localClient.list('days_of_operation')` runs *before* the original write commits, so it does not see Monday and mints a new id.
3. The original write then lands. Both rows now exist.

Shipping decision 1 alone genuinely does introduce this possibility, which today's unbounded hang does not have — while a write hangs, `bootstrapInFlight` is held and the retry refuses outright, so no second write is ever issued. This is a real trade, not a technicality, and it is stated here rather than buried.

### Why shipping decisions 1 and 2 alone is still the right call

The trade is strongly favourable, on three verified points:

- **The race window is narrow and human-gated.** The retry is director-initiated (`setNoticeRetry` → a button in `src/App.jsx`), never automatic; the mount-time run fires once per `campId`. For a duplicate to occur the original write must still be uncommitted more than 8000ms in *and* survive past the director's click, then land afterwards. `seedDays` re-reads the table at the top of every call, so a retry that runs after the write commits simply finds the row and skips.
- **The outcome is visible and recoverable by the director, with no engineer involved.** A duplicate weekday appears as a second row in `DaysScreen` (`src/screens/DaysScreen.jsx`, scoped by `camp_id`), which supports per-row delete via `DeleteRecordDialog`. The director sees two Mondays and removes one.
- **The status quo it replaces is strictly worse.** Today a hung write is unrecoverable inside the app: the retry correctly refuses, and the only path forward is restarting the application, which nothing in the UI tells the director to do beyond one sentence. Trading "unrecoverable without a restart" for "rare, visible, self-serviceable duplicate row" is a net improvement even before T205 lands.

Every other caller is unaffected: the per-caller enumeration above — independently re-derived by Red Hat — found `seedDays` to be the only automatically-retried caller not already idempotent-by-construction or human-mediated.

**Confidence: high.** The three points above are each verified against the code rather than reasoned from the design. The residual risk is bounded, visible, and reversible by the person who encounters it.

### Why decision 3 was removed rather than fixed in place

Round 1's review panel established that decision 3 as designed does **not** close the hazard it was added for, and that its migration carries a live data-loss defect. The details, and the unverified premise that now governs whether the migration's delete branch is routine or exceptional, belong to T205. The short version: `days_of_operation.ensureExists` leaves `day_of_week` NULL at row creation, and SQLite treats NULLs as distinct, so the constraint never fires where it was supposed to. The index as specified above would not have delivered the safety this ADR claimed for it — which is the substantive reason to re-derive it rather than port it forward.
