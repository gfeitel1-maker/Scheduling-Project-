# T7 — A second device joins successfully and shows an empty camp

**Risk:** HIGH — this is the blocker for installing the app on other camp computers.
**Found:** 2026-07-27, Red Hat review of the op-log coercion change.
**Status:** CONFIRMED in code. Needs an ADR before implementation — this is a structural decision, not a bug fix.

---

## The defect

`sendFullSyncIfFirstPairing` (`electron/sync/syncServer.js:104-120`) ships exactly two tables:

```js
const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
const camps = db.prepare('SELECT id, name, signing_secret, signing_public_key FROM camps').all()
send(ws, { type: 'full_sync', users, camps })
```

No groups, days, time blocks, tiers, activities, anchors, templates or slots. And `sendMissedOps` (`syncServer.js:164-177`) does not backfill: for a device whose `last_synced_seq` is NULL it *baselines* the watermark to `currentMaxOpSeq(db)` and returns **without sending anything**. The comment says this is deliberate and out of scope.

Net effect: a joining device authenticates, is fully writable, and every domain `list()` returns `[]`.

## The second-order failure, which is worse

`ScheduleScreen.jsx:232-234` resolves the working template with:

```js
list('schedule_templates').find(x => x.camp_id === campId)
```

On an empty table that returns undefined, so `generate()` / `placeAnchors()` mint a **new** `crypto.randomUUID()` template and write to it. The Host then holds two "Master Template" rows. Each device's `.find()` resolves to a different one and they diverge permanently. `bulk_replace` is scoped per template, so neither clobbers the other and **no conflict is ever recorded**. The failure is silent — likely discovered only when two people print different schedules.

## Observable completion evidence

1. Pair a second device against a Host with a populated camp. Without any manual step, the Client's Schedule screen shows the same groups, days, blocks, activities, anchors and slots as the Host.
2. The Client resolves the **same** `schedule_templates.id` as the Host. After a generate on either device, `SELECT count(*) FROM schedule_templates` is unchanged.
3. An edit on the Client appears on the Host, and vice versa.
4. Restart both devices; both still agree.
5. Pairing a device to a camp with **no** schedule yet still works, and only one template is ever created.

## Approach

Recommended: extend `full_sync` to ship the domain tables as row snapshots, the same mechanism it already uses for `users` and `camps`. Bounded payload, matches the existing pattern, and avoids replaying an op log that contains known-bad historical entries (see the two orphaned `template_slots` ops at seq 257 and 293 in the production DB).

Alternative considered: replay the op log from seq 0 for a first-time device instead of baselining. Architecturally purer, since every mutation is in the log, but it drags that bad history along and is O(all history) on every join.

The ADR should also settle template identity — resolving by `.find()` on an unordered list is the actual mechanism of the silent fork, and shipping data without fixing that only narrows the window.

## Files expected to change

- `electron/sync/syncServer.js` — `sendFullSyncIfFirstPairing`
- `electron/sync/syncClient.js` — `full_sync` handler
- `src/screens/ScheduleScreen.jsx:232` — template resolution
- `docs/adr/` — new ADR

## Do not ship without

An integration scenario under `test/integration/scenarios/`. This is precisely the class of failure the existing scenarios exist to catch, and there are already 16 of them to follow.
