---
title: "Update-on-open: keep a device current before it is allowed to sync"
document_type: ticket
status: closed
created: 2026-09-18
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md]
related_tickets: [docs/work/tickets/T215-libp2p-3x-upgrade.md]
archive_when: "a device below the minimum supported app version is kept off the sync path (blocked or updated) rather than allowed to attempt replication, and the mechanism is demonstrated to be unskippable"
---

# T222 — Update-on-open

`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` records the owner's decision that
Shoresh does not promise replication between devices running different app versions — a camp's
devices all run the same build. That decision is only true in practice because of a mechanism
called **update-on-open**: a device is kept current before it is allowed onto the sync path, so
"two versions in the same camp" never becomes a state the fleet can settle into.

**That mechanism does not exist today.** There is no code path in this repository that checks app
version before allowing a device to dial or accept sync connections, and no build/update pipeline
wired into `electron/`. The ADR's decision is currently safe only because no second app version
exists in the wild yet — an accident of timing, not a property of the system. The moment a second
version ships, this ticket's absence becomes the live gap the ADR describes as "drift-is-possible
by default, not by design."

This ticket exists to make that gap tracked rather than implicit. **It is not authorized to be
built.** The owner has not scoped an updater — how it fetches a new build, how it verifies
integrity, what happens to an offline device, what UI a director sees during/after an update. Do
not design or implement any of that from this ticket alone; it needs its own scoping pass (and
likely its own ADR, given `docs/adr/2026-09-14-internet-transport-security-gate.md` §4 already
flags update-mechanism integrity as an open question for a related surface) before any code is
written.

## Why this is load-bearing, not a convenience feature

Without update-on-open, `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`'s decision
has no enforcement — a director who has not opened the app in months, or who declines an update,
can still attempt to sync on a stale build with no compatibility guarantee behind it, and Shoresh
currently has no way to notice or prevent that. The ADR's whole argument for choosing a decision
over a demonstration relies on there being no rollout window where two versions are both live; that
premise is only true once this ticket closes.

## Scope (for the session that eventually picks this up — not authorized yet)

- Decide the check-and-block/update boundary: does a stale device get blocked from sync entirely,
  silently updated, or prompted? This is a product decision for the owner, not an engineering
  default.
- Decide what "minimum supported version" means and where it is recorded/read from.
- Cover the offline-device case named in T215 §3 (a laptop that cannot reach an update source
  cannot be forced current) without regressing to the "fails silently" class of bug fixed in the
  2026-09-17 `shoresh:auth-rejected` work.
- A test asserting a device below the minimum version is kept off the sync path rather than allowed
  to attempt replication.

## Does NOT count as done

- Any code shipped without an explicit owner scoping pass first.
- An update mechanism whose integrity/signing story is unaddressed (see
  `docs/adr/2026-09-14-internet-transport-security-gate.md` §4 for the class of question that
  applies).
- Silent update failure that leaves a director unable to sync with no explanation.

## Before you close or de-scope this ticket — read this

This is the direction of the dependency that gets read least, and it is written here deliberately.
A session deciding whether update-on-open is worth building will read **this ticket**; it will not
necessarily open `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`, which is the
document whose correctness depends on the answer.

**Closing this ticket as unnecessary silently reopens a question the owner already closed.** The
ADR does not say "mixed-version replication was tested and works" — it says the promise was
*removed at the product level*, and it removed that promise on the strength of update-on-open
existing. Drop the mechanism and the decision does not revert to "safe by default"; it reverts to
the unanswered question, with an `archive_when` on a closed T215 that is no longer satisfied and a
2.x↔3.x compatibility claim nobody ever demonstrated.

So the only two valid ways to close this ticket are:

1. **Build it** (after the owner's scoping pass — see Scope above), or
2. **Take the decision back to the owner**, get a recorded replacement for how a camp is kept on
   one build, and amend
   `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` in the same change. Amending the
   ADR is not optional cleanup; it is the thing that keeps the record honest.

Closing it as "no longer needed" without doing (2) leaves a `status: accepted`, `authority:
normative` ADR asserting a safety property with nothing behind it. That is worse than never having
written the decision down, because the next reader will trust it.

## Closed (2026-09-26)

Closed by owner ruling. Status is `closed`, not `completed` — this ticket's own `archive_when` ("a
device below the minimum supported app version is kept off the sync path ... and the mechanism is
demonstrated to be unskippable") is **undischarged and will stay undischarged**. Nothing was built.
`completed` would assert a mechanism exists; it does not, and by this decision it will not.

The owner's words:

> "when someone comes online, they sync."

**What that decides.** The premise is rejected, not deferred. Update-on-open was a gate: keep a
device current *before* it is allowed onto the sync path. The owner's direction is the opposite
default — coming online means syncing, full stop. That removes the updater, the version gate, the
minimum-supported-version record, and the ADR this ticket said it would need. The section above,
"Before you close or de-scope this ticket", argued that only two closures were valid — build it, or
take the decision back to the owner. This is the second: the decision went back to the owner and he
made it directly.

**Read this before you read that ADR: closing this ticket removed the mechanism its safety
argument depended on.**

`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` is `status: accepted`,
`authority: normative`, and it asserts that Shoresh does not promise replication between devices
running different app versions. That decision was affordable **because update-on-open would keep a
camp's devices on one build** — the ADR removed the promise at the product level on the strength of
this ticket eventually shipping. This ticket has now been closed by owner ruling and will not ship.
The dependency was therefore not forgotten; it was **deliberately cut**, and the ADR was left
standing with nothing behind that specific property.

Concretely, the property now unsupported is: *"two versions in the same camp never becomes a state
the fleet can settle into."* Nothing in the code enforces it. A stale device syncs like any other.

That ADR is held by another session in this window and was deliberately not touched from here, so
the amendment it needs is handed to the owner as an open item rather than assumed done. **Until it
is amended, do not read that ADR as load-bearing on this point** — its decision stands as a product
choice, but its enforcement story does not.

**The narrower correctness concern this ticket did not actually contain.** A peer session suggested
T222's real content might be a transport-boundary correctness question — a
version-incompatible peer malforming a shared Automerge document — rather than the stale-device
admission policy the owner rejected. Checked: that concern is **not present in this ticket**. The
scope list above is entirely about admission policy (block / update / prompt, minimum supported
version, the offline device). The document-shape hazard is real but lives elsewhere and is handed
to the owner separately; it is not kept alive here, and nothing is to be built from this ticket.

### Mixed-version leftovers — declined (2026-09-30)

> "devices on different versions is not possible. i am in production, no users. once this goes it is
> open source. i will not be updating."

What this declines: the cut update-on-open gate this ticket already recorded above is not being
revisited or replaced by anything else. The owner's 2026-09-30 ruling (quoted on T284 and here)
confirms directly that the ADR's now-unenforced property — "two versions in the same camp never
becomes a state the fleet can settle into" — is accepted as permanently unenforced, not a gap awaiting
a future mechanism. Status stays `closed`, not reopened; this is additional reasoning, not a status
change. The ADR (`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`) still needs the
amendment named above to stop asserting a property nothing enforces — that is unchanged by this note
and remains a human gate (amending an accepted ADR), flagged to the owner rather than done here.
