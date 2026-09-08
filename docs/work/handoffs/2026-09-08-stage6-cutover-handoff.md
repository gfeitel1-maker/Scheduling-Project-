---
title: Stage 6 cutover — handoff
document_type: handoff
status: active
created: 2026-09-08
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
archive_when: Stage 6 cutover is merged and the op-log is retired
---

# Stage 6 cutover — handoff

**Reach the outgoing session:** `SendMessage` to **`automerge-libp2p-stage-5c-7-57f50d-c5`**
(ref `bbc454`). It has full context on every decision below and the reasoning behind each. If that
name does not resolve, run `ListAgents` — the session may have been renamed or ended. Ask rather than
re-deriving; several findings below cost hours to reach.

**Authority:** [ADR 2026-09-06](../../adr/2026-09-06-productionize-automerge-libp2p-sync.md).
**The plan you are executing:** [Stage 6 cutover plan](../plans/2026-09-07-stage6-cutover-plan.md).
Read that first — it has the measured blast radius and the slice sequence.

## Owner context (matters — it changes what "safe" means)

- **Pre-production. No live users, no real camp data, no real schedules.** The owner has said this
  repeatedly and been mildly frustrated at being asked again. Do NOT frame findings as
  "data at risk" or hedge on back-compat. Prefer clean cutovers. Existing `.automerge` files may be
  discarded at will.
- The owner is all-in on the cutover and wants momentum, but has consistently backed real stops when
  given concrete evidence. Evidence moves them; caution alone does not.
- **Standing product constraint, their words:** the join flow "has to be a recognizable form of
  identity pairing for people." A director on a second device should experience pairing *their camp*,
  not an opaque key exchange.
- They will push back, and they have been right when they did — twice their pushback found real bugs
  (the connection-reuse fix, and the rules-layer question that surfaced the genesis regression).

## State: what is merged and true

Stage 5 is complete and **hardware-validated on two real machines** (macOS + Windows, real Wi-Fi,
both directions, all five checks). PRs #305–#325.

- Engine: shared genesis, real Automerge sync protocol, mutual auth over libp2p, camp-scoped mDNS,
  seeding, unified document ownership, LAN binding.
- **28 entities modeled, 0 deferred** — including `template_slots` (the schedule), all parent-scoped
  entities, `day_overrides`, and now `users` + `camps`. All project from the document with
  `operations` EMPTY.
- Packaged build verified: Automerge WASM + all-ESM libp2p load inside the packaged app.
- Windows: per-user NSIS target added (never built ON Windows — see gaps).
- **The flag is still default-`oplog`.** Nothing is deleted.

## STOP — 6b and 6d are BLOCKED on an owner decision (2026-09-08)

**Two devices that concurrently create the SAME entity id lose fields.** Each assigns a fresh
container to that key; Automerge keeps one and discards the other's fields into `getConflicts`,
which nothing in this codebase reads.

Reproducible with no libp2p, no SQLite, no timing:

```js
const genesis = createEmptyDoc()
let a = A.clone(genesis), b = A.clone(genesis)
a = applyWrite(a, { entity:'activities', entity_id:'x1', field:'name',     value:'Archery'  })
b = applyWrite(b, { entity:'activities', entity_id:'x1', field:'location', value:'Lakeside' })
A.merge(A.clone(a), b)
// => {"location":"Lakeside"}   — "Archery" is gone
// getConflicts: 2 entries, one of them holding {"name":"Archery"}
```

**Which side loses is ARBITRARY, and one side ALWAYS loses.** Measured independently by two
sessions: 99/101/0 and 88/112/0 (name-wins / location-wins / both-survive). **Across 400 combined
merges, not one preserved both fields.** So there is no rare-interleaving case to tolerate — the
"0" is the load-bearing number, not the coin toss. The winner follows Automerge's random
actor ids, not write order — so this is not last-write-wins, which a director could at least learn
the shape of. It is a coin toss, both devices agree on the same arbitrary answer, and one device's
edit is always destroyed.

**The decisive datum: the op-log does NOT have this failure.** The same shape replayed through
`applyProjection` yields `{"id":"x1","name":"Archery"}` — both field-writes applied, nothing lost,
because op-log ops are field-level and merge additively.

So **Stage 6 as specified would trade a correct behaviour for a lossy one.** That makes 6b (flip the
default) and 6d (remove the op-log) a *correctness regression*, not a mechanism change. It is a
different decision from the one the plan authorises, and it is the owner's to make. Do not run 6b or
6d until it is made.

Full analysis, reproducer, and three options:
`docs/work/evidence/2026-09-08-concurrent-entity-creation-loses-fields.md`. Both sessions that looked
at this independently prefer **post-merge conflict reconciliation** (~40 lines, one place, and it
directly answers "nothing reads `getConflicts`") over **flattening the record shape** (touches the
genesis again and every entity's projection) — but two agents agreeing is a data point, not a
decision.

### Why ~5,000 green tests missed it

**Test scaffolding that serialises two participants hides every concurrency defect in the thing under
test.** The old harness's `seedCampIdentity` shortcut effectively serialised the second device, so no
test in this repo had ever had two independent devices create the same record at the same time.
Rebuilding the harness around a real join is what made the failure deterministic. This generalises
well past this bug: treat any fixture that sequences two peers as hiding something until proven
otherwise.

### A design constraint on whatever fix is chosen — decide this BEFORE writing it

State this before implementation so it is not retrofitted. The requirement is **not** "the reconciler
handles conflicts." It is: **the system cannot be in a state where a conflict went unhandled.**

Those are different, and the weaker one is the easy one to build. A reconciler wired into one call
site is a check somebody has to remember to call — correct at the merge point today, and silently
bypassed tomorrow by any path that writes the document without going through it. That failure is
invisible, because the symptom is identical to the bug it was meant to fix: a field quietly gone,
with the evidence sitting in `getConflicts` that nothing reads.

The module-load subset guard is the shape to beat. Its strength was never its logic — it was that
module load gives it **no path around it**. Aim for that property, not for correct conflict-reading.

### A requirement on whatever fix is chosen

The module-load subset guard's value was never that it read conflicts correctly — it was that it
**converted a silent-data-loss class into a loud failure**. It structurally cannot reach the record
level (a runtime id can never be in a frozen genesis), so do not strain it. But any reconciler must
ship with the equivalent: something that makes an unread conflict impossible to ignore, rather than
something that happens to read `getConflicts` correctly today and gets deleted in two years by
someone who cannot see what it was for.

## Next slice, and why it is next

**Resume at the libp2p join flow.** Stage 6a (porting the integration harness) reached only 3/27 and
stopped — correctly — on this: a genuinely new Client cannot bootstrap its camp identity over
libp2p. The harness needed test-only scaffolding (`seedCampIdentity`) to get there. `users`/`camps`
are now modeled (#325), so a device can RECEIVE identity once syncing; what is missing is the human
join step that makes it start. That is simultaneously the owner's stated constraint and 6a's blocker.

After that, resume the plan's sequence: finish 6a to 27/27 → 6b flip default → 6c remove WS →
6d remove op-log → 6e conflict UI (a product question for the owner, not yours).

**CORRECTION (2026-09-08, caught by the incoming session):** Stage 6a's partial work is **NOT on
`main`** — an earlier revision of this document said it was, and that was wrong. It lives on branch
`claude/am-stage6a-harness` (`5dd3d11`, 5 files, +570), now pushed to the remote (it had existed only
on one machine). It is additive and wired into no npm script, so merging it cannot affect the gate —
but **do not merge it as-is**: `harnessAutomerge.js`'s header asserts as an "ARCHITECTURAL FACT" that
`camps`/`users` are never modeled in the document, which #325 made false. Some scenarios it retired
on that basis may now be revivable. Fix the comment before merging, or supersede the file.

That branch contains `test/integration/harnessAutomerge.js`, `run.automerge.js`, and three ported
scenarios. Its
report documents every retired scenario with a reason — several are genuinely obsolete under a CRDT
(client_write_id idempotency, the lock manager, host_seq ordering, full_sync manifests). One ported
scenario (08) flakes ~50% in sequence; root cause unknown, suspected libp2p stream teardown between
in-process node lifecycles. Not smoothed over — inherit it as a known issue.

## Hard-won findings — do not rediscover these

Every one of these passed a **green full test suite** and was invisible until two independent
participants merged or two real machines talked.

1. **`A.merge` CONSUMES its first argument.** Returning early on a "nothing new" merge without
   updating the registry leaves a dead handle; the next local write throws "outdated document"
   permanently. Redundant frames are routine in a mesh.
2. **Every device must share ONE genesis.** Independently created documents have unrelated roots;
   merging silently discards one side's entire entity collection, visible only via `getConflicts`,
   which nothing reads. There is now a **module-load subset guard** that throws if a modeled entity
   is missing from `GENESIS_ENTITIES` — if it fires, regenerate `GENESIS_B64`; do NOT weaken it.
3. **Whole-document pushes are not reliably deliverable.** A frame rejected by the peer's admission
   gate does not throw on the sender. An initial-sync built that way was intermittent and was removed
   rather than shipped flaky. Use the sync protocol.
4. **A node only sends to peers that authenticated to IT**, so one-way auth means nothing flows in
   either direction. Mutual auth is required.
5. **libp2p connections are bidirectional** — never require a dial-back. A firewalled Windows peer
   can dial out but not accept; requiring the return dial killed sync entirely.
6. **`DEFAULT_LISTEN` is loopback.** Production must bind `0.0.0.0` explicitly.
7. **Windows blocks inbound on "Public" networks** — the app discovers peers, looks healthy, and
   accepts nothing. Environmental, documented, not automated (needs admin, conflicts with the
   per-user install).
8. **`electron:build` ships whatever ABI `node_modules` holds.** `preelectron:build` now fixes it;
   without it the packaged app cannot open its own database.

## Working rules that earned their place

- **Full `npm run verify` green before every merge.** Capture npm's real exit code to a file —
  `| tail` reports the last pipeline command and can false-green.
- **Machine load has hit 250–1000 here.** `verify` takes ~11 min quiet and 40+ loaded. Check `uptime`
  before trusting a red, and re-run isolated. Do not add wall-clock assertions to the suite; two have
  already flaked (a 300ms throttle test, a 5s scale bound now loosened to 60s).
- **Verify load-bearing claims yourself.** Subagent reports have been good, but the two most serious
  bugs were caught by independently re-running the merge, not by reading the report.
- **Doc-path fixture traps** (I hit three in one sitting): parents must be in the DOCUMENT, not just
  SQLite, or delete-reconcile removes them and you get an FK error instead of your result; some paths
  need a `devices` row; check real field names in `PROJECTIONS` first (`event_slots` uses
  `event_group_id`, not `group_id`). I wrongly asserted a defect because of one of these.
- Subagent Makers repeatedly stall waiting on their own background gates. Tell them to run gates in
  the FOREGROUND, and be ready to take the gate over.
- Never delete a test to make a red go away. One flaky feature was removed instead — that is the
  right trade.

## The join blocker, decomposed (incoming session's analysis, confirmed)

A fresh Client cannot join over libp2p for **three stacked reasons**, not one:

- `startAutomergeSyncNodeIfEnabled` returns early when there is no `camps` row, so no node starts.
- `createMdnsDiscovery`'s serviceTag derives from `campIdHash(campId)`, so a device with no campId
  structurally cannot discover its Host.
- `login` for `mode=client` routes to `syncClient.loginRemote` over WebSocket; the libp2p `login`
  handler exists and is tested (`pairingLogin.test.js`) but nothing in `main.js` reaches it.

**Direction agreed: "join with a camp code."** While the director has an explicit *Add a device*
window open, the Host advertises a second mDNS tag derived from `hash(joinCode)`. The Client's Join
screen asks for that code, derives the tag, starts a node on a clone of the shared genesis (no
campId, no doc yet), does `pairing_request` → director approves → PIN login over the libp2p auth
protocol. Document sync then delivers `camps`/`users` (possible only because of #325), the Client
projects, learns its campId, and re-scopes to the camp tag for every later session. The recognition
moment lands at the end — "You've joined Camp X" — over the authenticated channel.

Rejected: having the Host broadcast the camp NAME in the clear during a consented, time-boxed
window. Simpler for humans, but it reintroduces exactly the plaintext-name mDNS leak that PR #309
deliberately removed, and a typed code shown on the Host is already the canonical recognizable
pairing idiom (Apple TV, Chromecast, Signal).

## Known-open, tracked

- Windows installer never built ON Windows; firewall rule documented, not automated.
- PIN material (`pin_hash`/`pin_salt`) replicates in the document. This is **status quo** — it
  already replicated via the op-log — but the cleaner shape is authenticating against the Host over
  libp2p so it never replicates. Costs offline login on a second device. Owner's call.
- No operational reseed path if a seeded doc is ever wrong.
- Stage 7 (WAN: DHT, dcutr, circuit relay) untouched.
