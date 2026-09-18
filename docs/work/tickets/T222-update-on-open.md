---
title: "Update-on-open: keep a device current before it is allowed to sync"
document_type: ticket
status: open
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
