---
title: "Response to the external architecture review (authority and recovery invariants)"
document_type: architecture-report
status: current
created: 2026-09-13
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md]
---

# Response to the external architecture review (2026-09-13)

**Method.** Every concern was traced against the code before any judgement, per the reviewer's own
opening instruction. One decisive experiment was run (item 3). No production code was changed.

**Headline.** The foundation holds. Item 3's promise is real and I proved it. Items 1 and 2 are
correct as rules but the reviewer's *specific* mechanism is already closed — what is still open are
two holes adjacent to it that the review did not name, one of which is the mirror of the concern
raised. Item 9 contains a genuine weakness the reviewer assumed was fine. Item 7 credits the system
with a capability that is not actually shipped.

---

## 1. RED — successful SQLite write that never reaches the document

**Reachable: yes. Already recorded, not prevented — as documented. But there are three distinct
holes here, and only one of them is the one being tracked.**

The write path is `write` IPC → `syncClient.write` → `appendOp` (`electron/ops/operations.js:154`).
SQLite + the op-log commit inside one transaction; `recordLocalWrite` mirrors into the document
*after* it returns.

**(a) The known hole — in-memory `applyWrite` throws.** Retried three times
(`liveDoc.js` `withRetry`), then durably recorded in `projection_failures` with `store='document'`
(`electron/ops/documentWriteFailures.js`), whose header states plainly that it records the loss
rather than preventing it. The nested-transaction variant — SQLite rolls back while the document
keeps the write — is genuinely closed by `runAtomic` (`operations.js:129`), which defers document
writes until the outermost transaction commits and drops them on a throw.

**(b) Unrecorded hole — the debounced save.** `flushPendingWrites()` (`liveDoc.js`) calls
`saveDoc` with **no try/catch**. A disk error (ENOSPC, permissions, a locked path) throws inside a
`setTimeout` callback: an uncaught main-process exception, no `projection_failures` row, and the
`op_id` is long gone by then. Every write in that 250 ms window is lost from the document with no
trace. This is not covered by (a)'s mechanism — (a) guards the in-memory mutation, not the fsync.

**(c) The mirror hole — the document→SQLite direction.** `syncNode.projectAndNotify` catches a
failed `projectAll` on a merged document, logs, and calls `onProjectionError`. **That callback is
never wired in production** — it appears only in `syncNode.test.js:234`. So when a remote merge
fails to project, SQLite is silently *behind* the authoritative document, with no durable record, no
repair path and no UI signal. `PLATFORM_STATE.md:464` already suspects this ("nothing currently
populates it under the default engine … flagged as a likely-stale safety net"); this confirms it.

**Failure semantics the renderer receives:** `write` returns the op row. Nothing in it says whether
the document accepted the write. No IPC surfaces document failures at all — the only reader is the
MCP tool `check_projection_health`. So the UI cannot know, even in principle.

**Crash behaviour on both sides.** A crash inside the 250 ms debounce window is *not* immediately
destructive, and deliberately so: startup performs **no** `projectAll` (`main.js:2404` explains why
it was removed). SQLite keeps the write, the document file is stale. But the divergence is permanent
and invisible until the next remote merge projects the older value back over it.

**Smallest robust correction — and it is not "document-first".** Document-first trades a recorded,
bounded loss for an unbounded one: the document cannot be rolled back, so a document-first write
whose SQLite half fails leaves the authoritative store ahead of everything, which is strictly worse.
Keep SQLite-first; make the *acknowledgement* honest:

1. Wrap each camp's `saveDoc` in `flushPendingWrites` in try/catch and record the failure
   (closes (b) — a few lines).
2. Wire `onProjectionError` to record a `store='projection'` failure (closes (c) — the table and
   repair already exist).
3. Give the write IPC a `durable` bit derived from whether the document write succeeded, and surface
   unresolved failures through the per-slot flag vocabulary, never a banner.

Only (3) is a behaviour change. (1) and (2) are pure omissions.

---

## 2. RED — domain-state migrations against a disposable projection

**Correct as a rule. Not reachable today. Entirely unguarded for the future.**

Domain-state migrations do exist — the name-dedup repoints (`localDb.js:378, 435, 532, 615`), the
`schedule_templates.kind` backfill (`:943`), the `week_id` backfill (`:1342`), and the locations
backfill (`:2418`, which mints `locations` rows and sets `activities.location_id`). All write SQLite
directly, none touch the op-log or the document.

They cannot fire against a doc-bearing database: all are well below v57, and any database that has
ever produced a `.automerge` file is at v57 or higher. Startup order is also correct for the
no-document case — `openLocalDb` (migrations) runs before `ensureSeeded`, so the seed captures the
migrated state.

What is missing is any guard for the *next* one. `localDb.js` has zero awareness that a document
exists. And `assertDocIsSupersetOrEmpty` will not save you: by its own comment
(`projector.js:299`), it refuses only a *completely* empty document — a partially-divergent one
passes and delete-reconciles the migration's rows away silently.

**Correction:** tag each migration `domainState: true|false` and assert in the harness that a
domain-state migration either refuses to run when a `.automerge` file exists for the camp, or is
paired with an explicit document write. Cheap now, impossible to retrofit after the first violation.

---

## 3. RED/YELLOW — prove complete rebuildability

**Proven. The property holds, with one precise precondition the promise does not currently state.**

I built a rich camp through the real write paths — a full `commitIngest` (cohorts, tiers, groups,
days, time blocks, activities with rules, a fixed-event fan-out), plus a schedule week, a manual
template, a location with capacity, a special day, an elective set, an event, three parent-scoped
children (`special_day_time_blocks`, `elective_set_activities`, `week_activity_exclusions`),
`template_slots` written through the **bulk-replace** primitive, and a tombstoned activity. Then
`seedAllFromSqlite` → **a fresh, empty, current-schema database** → `projectAll` → row-by-row
comparison across every modeled table including `camps` and `users`.

**Result: identical.** Every modeled entity, including the parent-scoped ones and the bulk-replace
scope collection, rebuilt byte-for-byte from the document alone.

**The precondition.** The fresh database must already hold the `camps` row with the matching id.
Against a genuinely empty database, *every* `camp_id` write is rejected by the projection guard
("does not match this device's camp (none)") and foreign keys then fail. This is deliberate —
`projector.js:71` says the singleton camps row is created only by bootstrap/pairing, never by
document replay — but it means the architectural promise is precisely *"delete SQLite → bootstrap
the camps row with the right id → rebuild"*, and **no production code path performs that sequence.**

**The `day_overrides` dependency is gone.** `DEFERRED_ENTITIES` is now empty and pinned by a test
(`generalize.test.js:116`); v59 dropped the table outright.

**What does not survive a rebuild, and should be said out loud:** the `operations` ledger is
SQLite-only by design (`historyLedger.js`) — Trash, Restore's prior values, and ingest-undo are lost.
Per-field provenance and authorship *do* survive; they live in the document.

**Coverage gap worth closing:** the nearest existing test (`generalize.test.js:295`) rebuilds
in-place into the same database, covers only `DIRECT_CAMP_ENTITIES`, and uses a minimal fixture. The
probe above should be promoted into the suite as the system-level property test.

---

## 4. YELLOW — convergence vs. schedule validity

**Mostly already separate. One real residue.**

A merge runs `projectAll`, then `synthesizeOpEvents` emits `op-applied` events; `ScheduleScreen`
reloads on any event not from its own device. The manual route's flags — `OVERLAP`, `WEEK_CLOSED` —
are **derived at render time from the converged state and never persisted**
(`ScheduleScreen.jsx:158`), so they appear and clear correctly on merged state. CRDT conflicts live
in their own `conflicts` table with their own vocabulary; nothing conflates the two.

**Residue:** the generated route's `UNFILLABLE` and the engine `findings` are generation-time
artifacts, and `OVERLAP` is manual-only by explicit product stance. Two devices dragging offline into
the same location converge cleanly into an over-capacity *generated* schedule that the generated
route does not flag. That stance predates CRDT, but CRDT is what makes the state reachable without
anyone ever seeing a conflict. Worth a deliberate decision, not a silent inheritance.

---

## 5. YELLOW — historical migration survivability

**Valid as stated.** There are no frozen fixtures of any kind — no `.sqlite`, no `.automerge`.
`localDb.migrations.test.js` synthesizes each pre-migration shape ad hoc, which is pairwise by
construction. Recommend freezing three era databases (pre-v30, ~v47, ~v53) plus the first doc-era
`.automerge`, and asserting semantic equivalence after the full chain, not schema shape.

---

## 6. YELLOW — libp2p authorization boundary

**Stronger than assumed.** Already covered by tests: an unauthenticated peer's bytes never reach
`A.merge`; failed auth denies admission; a `local`-type token is rejected over libp2p though valid
for IPC; expired tokens; a token whose `device_id` doesn't match the claimed device; a revoked
device with a structurally valid token; re-admission after disconnect; unsupported auth message
types; **outbound** broadcast gating (not just inbound); pairing/login rate limits including
device-id rotation on one connection, and `MAX_PENDING_PAIRING`. Wrong-genesis documents and
malformed Automerge binaries are both refused in `handleReceived` (`syncNode.js:129-152`) — the
genesis check is explicitly noted as something the admission gate *cannot* catch.

**Not covered:** token replay by a *different* peer (the camp token binds to `device_id`, which the
peer asserts; nothing binds it to the libp2p peer id), simultaneous dials from both directions, and
reconnect after a long offline period. The relay path is not applicable — see item 7.

---

## 7. YELLOW — relay vs. direct hole punching

**Already characterized precisely, and the review credits more than is shipped.** The production
transport is **TCP + mDNS only** (`transport.js:65-80`) — no `circuitRelay`, no `dcutr`, no DHT, no
AutoNAT anywhere under `electron/`. The cross-network CGNAT result lives in `experiments/`, and the
ADR already states plainly that the direct punch is untested and that the CGNAT run went via relay
because the hardware happened to be CGNAT. The shipped availability envelope today is **same-subnet
LAN**. WAN traversal is Stage 7 and not built.

---

## 8. YELLOW — approved-device trust model

**Agreed; no change.** Making the assumption explicit is the whole ask: any admitted device may
write any field of the shared document, and there is no per-mutation authority. That belongs as one
sentence in `SECURITY.md`.

---

## 9. YELLOW — replicated authentication material

**This one contains an actual weakness.** The hygiene is fine: `scryptSync`, a unique 16-byte salt
per user, `timingSafeEqual`, plaintext PINs never persisted, 5-attempt/30 s lockout.

But: `scryptSync(pin, salt, 64)` uses **Node's default cost** (N=16384, r=8, p=1), the PIN is
effectively **four numeric digits** (`LoginScreen.jsx` — `inputMode="numeric"`, `••••`), and
`users.pin_hash`/`pin_salt` are modeled entities (`projections.js:112`) that replicate into a
**plaintext document file on every paired device**. Ten thousand candidates at default scrypt cost is
seconds of offline work per user. The lockout defends the online path only; it does nothing here.

Cheapest fix with the largest effect: raise the scrypt cost parameters (N=2^17 or higher) and
re-hash on next login. Lengthening the PIN is the other lever, and a product decision.

---

## 10–13 — watch items

**10 (history model), 11 (camp-acquired knowledge), 13 (game seam):** agreed, no action. On 11, the
repetition the reviewer predicts is already visible — aliases, compound-cell decisions,
location-word decisions and reconciliation decisions each repeat table → lookup → provenance →
reconciliation → IPC. Still the right call not to generalize yet; worth naming the pattern so the
fifth instance is a deliberate decision rather than an accident.

**12 (stale documentation as a correctness risk):** agreed, and here are the concrete defects found:

- `liveDoc.js:218` — *"the op-log remains the authoritative record regardless of what the Automerge
  doc file holds"* and *"this stage's doc is a test/transition scaffold — not yet load-bearing for
  any real camp."* Both false; the document is the sync mechanism and the authority.
- `liveDoc.js:273` — *"The op-log remains the source of truth regardless."* Same.
- `main.js:2404` — *"built by the op-log (the authoritative record regardless of this flag)."*
- `src/screens/ModeSelectScreen.jsx:33` — user-facing copy: *"This computer becomes the source of
  truth."* No longer true under a CRDT; this one is visible to directors.

By contrast `WHERE_DATA_LIVES.md` and `PLATFORM_STATE.md` are accurate and current — including
`PLATFORM_STATE.md:464`, which correctly flagged its own dormant safety net.

---

## What shipped, 2026-09-13

Everything below landed on `main` behind the full gate (`lint + test +
test:integration + check:governance`) on the day of the review.

| Review item | Outcome | Where |
|---|---|---|
| 1 — authoritative-write semantics | **Closed in two parts.** Three unrecorded sibling paths found and closed (T148); the renderer is now told, and a director can see unshared writes (T153) | PR #388, #391 |
| 2 — domain-state migrations | **Guarded.** Every version classified; a new migration fails the suite until classified; sync refuses to start on a divergent launch | PR #390 |
| 3 — rebuild from the document | **Proven**, with its unstated precondition pinned by its own test | PR #389 |
| 4 — convergence vs. validity | **Mostly already separate.** One real residue, left as an open product decision | T156 |
| 5 — long-chain migrations | **Closed.** Four real historical databases, built by the code of their era, migrated on every run | PR #390 |
| 6 — libp2p authorization | **Mostly already covered.** The one open property (bearer tokens) is now measured, not assumed | PR #389 |
| 7 — relay vs. hole punching | **No work needed.** The shipped transport is TCP + mDNS only; the ADR was already precise | — |
| 8 — approved-device trust | **Already recorded** in `SECURITY.md`, with the owner's decision and date | — |
| 9 — replicated PIN material | **A real weakness, now raised and documented honestly** | PR #389 |
| 10 / 11 / 12 / 13 | Watch items. 12 was treated as defects and fixed; 11 and 13 now have a tripwire and a boundary ADR | T157, ADR 2026-09-13 |

Three things found by doing the work that the review did not ask about, and that
are worth more than most of what it did ask about:

1. **`appendBulkReplaceOp`'s document failure was a `console.error` and nothing
   else** — the highest-volume write in the app, since one op carries a whole
   regenerated schedule.
2. **A self-inflicted vulnerability, caught in self-review before it merged:**
   sizing scrypt's `maxmem` from the *stored* hash's `N`, when that hash
   replicates. A peer could have stored `N=2^30` and made every login on every
   device try to allocate hundreds of gigabytes.
3. **`withRetry` was reporting a failed write as a success.** It re-invoked a
   non-idempotent apply; an attempt that seeded the document and then failed to
   save it left the document cached, so the retry took the already-seeded path,
   skipped the save entirely, and logged *"succeeded on attempt 2 after a
   transient failure"* for a failure that was neither transient nor survived.

## Recommended sequence

1. **Item 1(b) and 1(c)** — two omissions, small, no design decision required.
2. **Item 12** — four stale statements, one of them user-facing. Cheapest correctness win available.
3. **Item 9** — scrypt cost parameters.
4. **Item 3** — promote the probe into the suite; state the camps-row precondition in the promise.
5. **Item 2** — the domain-state migration guard, before the first migration that needs it.
6. **Item 1(3)** — honest write acknowledgement in the renderer. Real design work.
7. **Item 5** — era fixtures.

Items 4, 6, 8, 10, 11, 13 are monitoring. Item 7 needs nothing but keeping the claim as narrow as the
ADR already keeps it.
