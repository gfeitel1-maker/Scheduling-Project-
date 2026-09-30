---
title: "Mixed-version replication: the ADR promises nothing and nothing prevents it"
document_type: ticket
status: wont-fix
created: 2026-09-27
task_class: database-sync
archive_when: "either (a) a device running a different app/libp2p major is demonstrably kept off the sync path and the out-of-scope ADR's safety argument is restored, or (b) the owner rules that mixed-version sync must WORK, the cross-version harness has been run against a real version pair, and its result — pass or a director-visible failure — is recorded here"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs:
  - docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md
related_tickets:
  - docs/work/tickets/T222-update-on-open.md
  - docs/work/tickets/T215-libp2p-3x-upgrade.md
  - docs/work/tickets/T217-libp2p-3x-residual-findings.md
---

# T284 — Mixed-version replication: the ADR promises nothing and nothing prevents it

## Why

`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` is `status: accepted`,
`authority: normative`, and asserts that Shoresh does **not** promise replication between devices
running different app versions. That decision was affordable **only because update-on-open would keep
a camp's devices on one build**.

[T222](T222-update-on-open.md) was then closed by owner ruling **without shipping**, and says so
itself:

> "closing this ticket removed the mechanism its safety argument depended on … The dependency was
> therefore not forgotten; it was **deliberately cut**, and the ADR was left standing with nothing
> behind that specific property."

The owner's direction was the opposite default — *"when someone comes online, they sync."* That
removed the updater, the version gate and the minimum-supported-version record.

So the current state is a **two-sided gap**, and neither side is an accident:

1. The product **promises nothing** about mixed-version replication (the ADR).
2. **Nothing prevents** mixed-version replication (T222 cut the gate).

Verified in code 2026-09-27: no minimum-version check exists anywhere in `electron/`.
`recordPeerSchemaVersion` (`electron/sync/automerge/joinSession.js:376`) *records* a peer's
self-reported schema version; it does not refuse on mismatch. `electron/buildInfo.js`'s
`readAppVersion` is used only for the About panel and a build label in `electron/main.js`.

This also sits directly against a standing product requirement in the owner's own words, quoted in
the harness this ticket restores: **"i would like for laptops to talk to one another no matter what
upgrades are happening."** The ADR and that requirement cannot both hold.

## Why this is not merely theoretical

The failure mode is **silent, and a connect-only test cannot see it**. Protocol IDs (`/noise`,
`/yamux/1.0.0`, `/multistream/1.0.0`, `/ipfs/id/1.0.0`) are byte-identical across the libp2p major
and structurally must be, being shared with go-/rust-libp2p — so two differently-versioned nodes
**will** connect and identify each other. That is not evidence a camp's document replicates: Yamux's
initial window size is negotiated **in-band**, after protocol selection. "Connects, then misbehaves
once data moves" is exactly what a handshake test reports as green.

A camp hits this the ordinary way — one laptop updates, another does not — and the symptom is a
schedule that quietly stops arriving, not an error.

## The instrument already exists

`test/integration/crossVersionReplication.manual.mjs` + `crossVersionRunner.js` drive **real
Automerge writes** across two separately-`npm ci`'d checkouts (one process each, since two libp2p
majors cannot both be required into one Node process), in both directions, including a **2 MiB write
to force at least one Yamux window-update round trip past the 256 KiB default**, and assert the data
lands in the receiving side's projected SQLite row.

It is deliberately **not** in `npm run verify`: it needs a second checkout pinned to an older commit
with its own `npm ci` (minutes), which is evidence-gathering infrastructure, not a per-commit gate.

```bash
git worktree add /tmp/shoresh-libp2p-210 08e971b   # pinned: libp2p 2.10.0
(cd /tmp/shoresh-libp2p-210 && npm ci)
SHORESH_XVER_OLD_TREE=/tmp/shoresh-libp2p-210 node test/integration/crossVersionReplication.manual.mjs
```

**Provenance, recorded because it nearly did not survive.** This harness was written for T215/T217,
never opened as a PR, and sat unmerged on a branch for 9 days. During the 2026-09-27 worktree cleanup
it was **deleted** on the reasoning that the out-of-scope ADR had settled the question — a judgement
made by reading two ticket *statuses* (T215 `closed`, T217 `closed`) without reading T222's body,
which is where the cut dependency is recorded. It was restored on the owner's instruction and is **merged by this ticket's own PR**, so it can no
longer be reaped for want of a PR. Original branch: `cross-version-evidence` (`8c4a948d`).

## What this ticket is not

Not a request to build an updater. T222's rejection was an owner ruling and stands. This ticket
exists so the gap is **recorded and decided** rather than sitting as an unenforced normative claim.

## Options for the owner

1. **Make the promise true.** Treat "laptops talk no matter what upgrades are happening" as the
   requirement, run the harness at each libp2p major bump, and amend the ADR to say replication
   across versions is *expected* — with the harness as its evidence. Merges the branch.
2. **Make the absence honest.** Keep the ADR's position but surface a version mismatch to the
   director (a flag, per the no-banners rule) so a camp learns why a device stopped syncing instead
   of discovering it through a missing schedule. Cheaper than an updater; does not resurrect T222.
3. **Record the gap as knowingly accepted.** Amend the ADR to state plainly that nothing enforces
   single-build operation and that mixed-version behaviour is untested, so the next reader does not
   infer enforcement from a normative claim.

Recommended: **2, then 1 when a libp2p bump is next in flight.** Option 2 removes the silent-failure
property, which is the genuinely dangerous part; option 3 alone leaves a camp's sync failing quietly.

## Done when

- The owner has chosen among the options above and it is recorded here.
- `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` no longer asserts a property that
  nothing enforces without saying so.
- ~~The `cross-version-evidence` branch is either merged or explicitly recorded here as declined.~~
  **Done** — the harness is merged with this ticket, so the instrument survives independently of
  whichever option is chosen.

## Closed — owner ruling, wont-fix (2026-09-30)

> "devices on different versions is not possible. i am in production, no users. once this goes it is
> open source. i will not be updating."

This declines the ticket's premise outright rather than choosing an option from it. Both branches of
`archive_when` are disposed of by the ruling, not satisfied by it: branch (a) (demonstrably keeping a
different-major device off the sync path) is not built, and branch (b) (the owner ruling mixed-version
sync must **work**, proven against a real version pair) is the opposite of what was ruled — the owner
states the scenario does not arise operationally (no users today, no further updates once the project
goes open source), so neither enforcing nor proving cross-version replication is worth building. The
harness `test/integration/crossVersionReplication.manual.mjs` stays merged as an instrument for a
future maintainer who does need it; it is not run to closure here. `status: wont-fix` reflects a
declined premise, not deferred work.
