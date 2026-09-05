# Shoresh future architecture — investigation report

**A camp project as a shared collaborative document.** Findings from the actual
code, plus results from two disposable experiments. Written for a non-engineer.

- **Isolated environment:** git worktree at
  `.claude/worktrees/relaxed-albattani-000799`, branch
  `claude/shoresh-future-architecture-364e03`, based on `main` at commit `d412fdb`.
  Nothing here is merged, pushed, or shared with other work. It is disposable.
- **Nothing in the real app was changed.** The experiments under
  `experiments/future-arch/` import nothing from the app.

---

## The one-paragraph answer

Your instinct is **more right than you probably realize**: Shoresh already has the
hard 80% of a "shared document" engine built. Every meaningful change is already a
small, uniquely-identified, replayable **operation**; duplicates are already
ignored; genuine conflicts are already recorded (not lost); and the operation code
is already cleanly separated from the network. What is *not* built is (a) a way to
carry those operations through a plain shared folder, (b) a way to run without one
computer being a permanent "Host", (c) a way to rebuild a database from scratch, and
(d) protection against schema-version mismatches. The shared-folder idea is a **sound
transport for asynchronous sync** — my Host-less prototype converges perfectly through
a folder across every failure mode you listed (24/24). But a commodity synced folder
is **not proven to feel live**, and I'll argue below that chasing "live over a folder"
is the part most likely to waste your money. Keep folders for async; keep WebSocket
for live. Do **not** put a shared SQLite file in a Dropbox folder — that is the one
move that corrupts real camp data, and camps will try it unless the product stops them.

---

## 1. How Shoresh synchronization actually works today

Think of it as a **shared logbook**. Every change a director makes is written as one
line in a logbook, and the logbook is what travels between computers — not the
database itself.

- **The operation is the unit.** "Greg moves Archery to Field 1" becomes one row:
  `entity=activities, entity_id=archery, field=location, value="Field 1"`, plus who,
  which device, when, a globally-unique id, and a `parent_op_id` = "the change I
  believed I was building on." (`electron/ops/operations.js`, `schema.sql:165`.)
  This is **exactly** the shape you sketched in your brief.
- **Host vs Client.** One computer is the **Host** (runs a WebSocket server). Others
  are **Clients** that find it on the Wi-Fi (mDNS) and connect. The Host is the
  **referee**: only the Host assigns the official order of changes and only the Host
  decides "these two changes genuinely conflict." Clients make changes locally, send
  them to the Host, and receive everyone's changes back. (`syncServer.js`,
  `syncClient.js`.)
- **Each computer has its own SQLite database.** The database is the *current picture*.
  The logbook (`operations` table) is the *history that syncs*.
- **Idempotent + retry-safe already.** Each change carries a `client_write_id`; if a
  Client resends the same change after a dropped connection, the Host recognizes it
  and returns the original instead of duplicating it. Clients also ignore any
  operation whose id they've already seen. (This is the "won't double-apply" property
  you asked about — it's already there.)
- **Reconnect is watermark-based.** The Host remembers, per device, "the last change
  you confirmed you applied." On reconnect it sends only newer changes, one at a time,
  waiting for each to be acknowledged before sending the next — so nothing is skipped
  or duplicated. (`sendMissedOps`, T85.)
- **First-time sync is a snapshot, not the whole history.** A brand-new Client gets a
  copy of the *current rows* plus a bookmark ("you're caught up to here"), then live
  changes after that. It does **not** receive the old logbook. (Consequence in §4.)
- **Conflicts are surfaced, not resolved silently.** A real conflict is written to a
  `conflicts` table on both computers and requires someone to choose. (`conflicts`
  table; `resolveConflict`.)
- **Presence already exists in one small form.** "Locks" are explicitly *advisory
  hints* — "someone else is editing this field right now" — not hard locks. They're
  the only ephemeral, throwaway signal in the system. (`lockManager.js`.)
- **Some data deliberately never syncs.** Private signing keys, device trust/pairing,
  import evidence, and source-aliases are **host-local or device-local** and never
  leave the machine. The code even *refuses* to log them. (This is important — see §3.)

## 2. What we already have that supports the idea

Your hypothesized mapping was almost entirely correct. Corrected:

| You guessed | Reality |
|---|---|
| operation log → shared project history | **Yes, already true.** Field-level, idempotent, conflict-aware. |
| SQLite → local working state | **Yes, already true.** DB is the picture; log is the truth-in-motion. |
| snapshot → project checkpoint | **Partly.** Three different things are called "snapshot" today; none is yet a portable "checkpoint file." (§4) |
| WebSocket → one transport | **Yes, and it's cleanly separable** — the operation logic (`electron/ops/*`) touches no network at all. |
| Host → temporary coordinator | **This is the real work.** Today the Host is not just a coordinator; it is the **referee and the notary** (assigns order, mints security tokens). Removing it means moving those two jobs somewhere else. |
| Client → peer | Follows once the Host stops being special. |

**The single most encouraging finding:** the operation functions
(`appendOp`, `detectConflict`, `applyProjection`, …) already take plain operation
objects and a database — no sockets. A different transport can reuse them unchanged.

## 3. What would have to change

1. **Replace the single referee with a rule every computer can apply alone.** Today
   the Host assigns order. Without a permanent Host you need a shared rule so any two
   computers reach the *same* answer independently. My prototype uses a **logical
   clock + a deterministic tie-break** (last-writer-wins, and if two truly collide,
   record it for a human). It converges perfectly (§11).
2. **Add a "carry operations through a folder" transport.** One immutable file per
   operation, written safely (write-temp-then-rename), scanned and de-duplicated by
   others. Proven to work, including on your real OneDrive folder.
3. **Add a real "rebuild from scratch" path.** Today there is **no** routine that
   rebuilds a database purely from a checkpoint + operations. Bootstrap works only
   *forward from a live Host*. For a folder-based project you need a checkpoint file
   plus a replay routine. (Deterministic replay already works; the missing piece is
   the packaging.)
4. **Add a schema-version handshake.** Today two computers on **different app
   versions** can exchange operations with **no version check** — a real corruption/
   confusion risk once an app is packaged and auto-updates. This must gate sync.
5. **Decide the identity/authorization story without a Host.** Today the Host holds
   the private key that authorizes people ("camp tokens"). A folder has **no notion of
   users or permissions** — whoever can see the folder has the entire camp. This is a
   genuine consequence, not a detail (§17).
6. **Deal with unbounded growth.** The operation log is **never pruned**. Over
   multiple seasons it grows without limit. Folders full of hundreds of thousands of
   tiny files also degrade. You need checkpoint-and-compact.

## 4. The recommended architecture (after seeing the code)

**Keep the local-first core exactly as it is. Add a transport seam. Add a folder
journal as a *second, asynchronous* transport. Keep WebSocket for *live*. Do not
build a cloud backend yet, and never share a live database file.**

```
                 Shoresh operation engine   (electron/ops/* — already transport-free)
                            │
                 ┌──────────┴───────────┐         one Transport interface
                 │                       │
         WebSocket transport      Folder-journal transport
         (LIVE, low-latency,      (ASYNC, store-and-forward,
          same LAN, + presence)    any of OneDrive/Dropbox/NAS/Syncthing)
                 │                       │
          local SQLite            local SQLite
```

Concretely:
- **Local SQLite stays.** Fast, offline, unchanged.
- **A `Transport` seam** (send-operations / receive-operations) that both WebSocket
  and folder implement. The engine never knows which is in use.
- **The camp project on disk becomes a small folder**: identity/metadata, a schema
  version, a periodic **checkpoint** (a compacted current-state file), and the
  **journal** (operations since the checkpoint) as append-only files.
- **Ordering by logical clock + deterministic last-writer-wins**, with genuine
  collisions written to the existing `conflicts` table and shown to a human. This is
  the *smallest safe conflict model* — and it's the model you said you prefer.
- **WebSocket stays for the live experience on a LAN** and for presence (who's here,
  who's editing what). Presence is throwaway; the folder never carries it.

Why this and not a cloud database: it earns almost everything you want (offline,
async remote, LAN-live, no vendor lock-in) by **reusing code you already have**, and
it degrades gracefully — if the folder is slow, you lose *liveness between remote
sites*, never *correctness or durability*.

## 5. Is the shared-document analogy technically sound?

**As a mental model for the user and for durability: yes.** A camp project *is* well
modeled as one shared, versioned document that different screens edit.

**As a promise of Google-Docs-style live co-editing over a commodity folder: no —
and you should not promise it.** Word/Excel-in-Teams feels live because a *server*
brokers presence and cursors in real time; the *file* in OneDrive is the slow,
durable part. Your own analogy actually supports splitting the two: **folder = the
durable document; a live channel = the real-time feeling.** On a LAN you already have
that live channel (WebSocket). Between two different networks, a plain folder will
feel like *email*, not like *a phone call* — fine for "Taylor sees it a bit later,"
not for "Taylor sees it as I drag it."

## 6. Is generic shared storage a viable synchronization mechanism?

- **For asynchronous sync: yes, convincingly** — *if* you use it the disciplined way
  the prototype does: one immutable file per operation, write-temp-then-rename, ignore
  anything you've already seen, and make the final state independent of arrival order.
  Under duplicates, reordering, offline gaps, restart, and partial writes, two
  databases still converged (24/24). OneDrive accepted the write pattern cleanly.
- **For a *live* feel: unproven, and probably not** — commodity folders typically
  propagate in seconds-to-minutes and can silently batch or delay. The instrument to
  measure this on **your** providers is built (§11); until the two-machine numbers
  come back, assume async-only.
- **One hard rule: never point Shoresh at a shared *database file*.** Two computers
  opening one SQLite file over Dropbox/SMB **will** corrupt it. The folder may only
  ever carry the append-only journal + checkpoints, never the live `.db`.

## 7. What should stay WebSocket-based

- **Presence** (online, viewing, selecting, "editing this now") — lossy by nature.
- **Live LAN collaboration** — the sub-second drag-and-drop feel, already working.
- **Remote liveness** *if you decide you want it* — a folder can't do it; that needs a
  direct connection or a small relay (§8).

## 8. What requires additional infrastructure, if anything

- **Async remote + LAN-live:** *no new infrastructure.* Folder + WebSocket cover it.
- **Live remote (different networks, real-time):** needs **one** of: a tiny always-on
  **relay** (a rendezvous point that just forwards operations — cheap, stateless-ish),
  or a peer-to-peer connection (NAT traversal, more fragile). This is the *only* place
  a small server earns its keep — and only if "live across the country" is a real
  requirement, which I'd push you to confirm before paying for it.

## 9. Major risks and failure modes (the "try to disprove" section)

- **Corruption via shared DB file** — *the_ dominant risk. Product must prevent camps
  from putting the `.db` in the synced folder. Mitigation: only journal files sync.
- **Deleted items reappearing** — handled today by tombstones + order, but folders
  add a twist: **a sync provider can resurrect a file you deleted**, or fail to
  propagate a deletion. Journals must be **append-only and never rely on deletion**;
  compaction happens via new checkpoints, not by deleting old operation files out
  from under a peer who hasn't read them yet.
- **Partial writes** — mitigated by write-temp-then-rename (verified). But not every
  provider guarantees rename atomicity across machines; the two-machine test must
  confirm no torn files ever appear as `*.op.json`.
- **`.tmp` files syncing** — providers may replicate your temporary files, wasting
  bandwidth or exposing partial data. Measure; may need a provider-ignore convention.
- **Clock skew / ordering** — solved for correctness by logical clocks (not wall
  time); wall-clock timestamps are for humans only.
- **Thousands–hundreds of thousands of operations** — unbounded log today; huge folders
  of tiny files degrade sync. Needs checkpoint-and-compact and probably operation
  **batching** (one file per burst, not per keystroke).
- **Long-offline computer** — comes back to a large backlog; fine for correctness, but
  reconciliation time and a flood of conflicts need a good UI. Also risks referencing a
  checkpoint that's been compacted away — keep enough history overlap.
- **Schema/version drift** — no handshake today; two app versions can talk. Must gate.
- **Identity/permissions** — a folder is all-or-nothing access; there's no per-user
  authorization once the Host referee/notary is gone (§17).
- **Rebuild-from-scratch doesn't exist yet** — a fresh install can't reconstruct from a
  checkpoint + log today; must be built and tested, or a lost Host = lost history.

## 10. Existing technology to reuse rather than rebuild

You are, in effect, re-deriving **event sourcing + a lightweight CRDT**. Before
building more, evaluate these against *your* needs (don't adopt for fashion):

- **cr-sqlite** — adds CRDT merge + a changes-feed directly to SQLite. Closest fit to
  what you have; could replace hand-written convergence. Worth a serious look.
- **Automerge / Yjs** — mature CRDT libraries. Powerful, but heavier than "field-level
  last-writer-wins with human conflict surfacing," which is all you've said you want.
- **Litestream / LiteFS, libSQL/Turso, PowerSync, ElectricSQL, Ditto, Dqlite** — SQLite
  replication/sync systems. Most assume a server or a specific cloud; they cut against
  "no cloud dependency" but are worth knowing as the paved road if that constraint ever
  relaxes.
- **Syncthing** — a strong *transport* candidate: open, no cloud account, LAN-direct
  when possible, folders as the interface. Pairs naturally with the folder-journal.
- **The transport pattern itself** (Maildir-style one-immutable-file-per-message,
  write-temp-then-rename) is a 40-year-old, battle-tested design — reuse the *pattern*,
  not a library.

**Honest read:** your requirements are modest enough that the hand-rolled engine you
already have + a folder transport + logical clocks is *less* risk than adopting a big
CRDT framework — **except** you should prototype `cr-sqlite` head-to-head before
committing, because it may delete a whole category of your future bugs for free.

## 11. Prototype / test results

**Host-less op-log over a shared folder** (`run.cjs`): **24 / 24 pass.**
A→B, B→A, multi-change convergence, offline→reconnect catch-up, duplicate delivery
(idempotent), out-of-order arrival, app restart (persist + no re-apply), torn/partial
file skipped, and — the real one — two computers moving Archery *concurrently off the
same base*: both **converge to the same value** *and* both **record the same conflict
pair** for a human. This is direct evidence the referee-less model is sound.

**Propagation instrument** (`propagation.cjs`): local baseline (one machine, the
*instrument floor*, not a cloud number): one-way median ~14ms, 0 missed, 0
out-of-order — bounded by the 25ms poll. **Cross-device timing needs a second
computer**; the two-machine protocol is in the README, ready to run against OneDrive,
Dropbox, Drive, Syncthing, etc. **Provider compatibility**, measured against your real
OneDrive folder: 5/5 files written, renamed, and read back with 0 orphaned temp files.

## 12. Confidence, and what's still unknown

- **High confidence:** the operation engine is reusable and transport-neutral; the
  Host-less convergence math is small and correct; folders can carry operations
  asynchronously and safely with the right discipline.
- **Medium/unknown:** whether *any* commodity folder is fast/consistent enough to feel
  *live* between networks — **not yet measured on real providers/two machines.** My
  prior: no, treat folders as async.
- **Known gaps to close before trusting it:** no from-scratch rebuild routine; no
  schema-version handshake; no compaction; and no answer yet for **who's allowed** once
  the Host notary is gone.

## 13. Staged path if you proceed (each stage reversible, each teaches something)

- **S0 — Two-machine measurement.** Run the propagation instrument on OneDrive +
  one other provider across two computers. *Decides whether "live over folder" is even
  on the table.* Cheapest, most decision-changing. Do this first.
- **S1 — Transport seam.** Refactor the app so operations flow through one small
  `Transport` interface; WebSocket becomes its first implementation. No behavior change.
- **S2 — Folder-journal transport (async).** Second `Transport`: append-only operation
  files + checkpoints in a chosen folder. Ship as "async multi-site sync."
- **S3 — Referee-less ordering.** Logical clock + deterministic last-writer-wins +
  route genuine collisions into the existing conflict UI. Lets a project live without a
  permanent Host.
- **S4 — Project checkpoint + rebuild + schema gate.** A portable project folder a
  fresh install can open and reconstruct; refuse mismatched schema versions.
- **S5 — (Only if S0 says no, and you still want live-remote) a tiny relay.** Add a
  direct/relayed live transport for real-time across networks.

## 17. Anything important you're not seeing (the critical part)

1. **The analogy oversells "live"; the real prize is quieter.** Your genuine wins are
   *offline durability* and *async multi-site sync* + *LAN-live* — all reachable
   cheaply. "Live across different networks" is the expensive, fragile part, and a
   plain folder won't deliver it. Don't let the Google-Docs feeling set the roadmap;
   confirm whether remote-**simultaneous** editing is a real need or a nice mental image.
2. **Removing the Host removes your notary, not just your referee.** Today the Host
   holds the private key that says who's allowed in a camp. A folder has **no users and
   no permissions** — possession of the folder *is* full access. Before going
   Host-less you need an identity/authorization answer (shared camp key? per-user keys
   signed once at onboarding?). This is the least glamorous and most load-bearing open
   question.
3. **The biggest data-loss risk is a support problem, not an algorithm.** Some camp
   *will* drop the live `.db` into Dropbox and corrupt it. The architecture is only as
   safe as the product's ability to *prevent* that. Design the "point Shoresh at a
   folder" flow so it physically cannot select or share the working database — only the
   journal/checkpoint project folder.
4. **A boring alternative may beat five folder providers.** Supporting OneDrive +
   Dropbox + Drive + Syncthing + NAS means inheriting *five* sets of quirks (rename
   semantics, deletion propagation, temp-file syncing, throttling). A single, tiny,
   self-hostable **sync-only relay** — no database, just forwards and stores operation
   files — could be *simpler and more reliable* than being provider-agnostic, while
   still keeping you off a big cloud backend and preserving offline-first. Worth pricing
   against the folder approach before you commit to "any folder."
5. **Batch operations don't fit the folder model naively.** "Generate a schedule" is
   today *one* wholesale replace of up to 5,000 rows. As one giant operation file that's
   fine; as many it's a flood. Make sure the checkpoint/journal design handles bulk
   operations as first-class, or the engine round will surprise you.

---

*Deliverables in `experiments/future-arch/`: `oplog.cjs`, `run.cjs` (24/24),
`propagation.cjs`, `run-baseline.sh`, `README.md`. All disposable; none touches the
app. Numbering above follows your "What I want back" list; paired duplicate headings
in the brief were merged.*
