---
title: "Tell a director when no other computer holds a copy of the camp"
document_type: ticket
status: completed
created: 2026-09-15
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-15-at-rest-encryption-scoping.md]
archive_when: a camp with no second paired device says so where the director already looks, and the count means a surviving copy rather than a row in the devices table
---

# T176 — "only this computer"

**A precondition of at-rest encryption being switched on**, agreed cross-session
with the owner of that work: the warning is only useful while the data is still
recoverable.

## Why

`docs/current/KEY_RECOVERY_STORY.md` has exactly one case where a camp loses data
it cannot get back: **the only device is lost.** The storage key goes with the
machine, the data is unreadable even to its owner — by design, because a
director-remembered passphrase was rejected as the worse day.

Its mitigation is **operational, not cryptographic**: keep more than one device
paired and synced. And a second synced device is not a backup chore someone has
to remember — it *is* the backup, continuously.

That advice is useless if a director cannot tell they have not followed it. Until
now the device count lived behind the Devices screen, which is where you go once
you already suspect something.

## What it is

A third state on the one-line label beside Devices, alongside `unsharedWrites`
(T153) and `lowDisk` (T160). **Not a banner** — a surface that already exists
gains a state rather than the app gaining chrome.

> **only this computer** — *No other computer has a copy of this camp. If this one
> is lost, stolen or replaced, there is no second copy to restore from. Adding
> another device keeps the two in step automatically.*

**Lowest priority of the three, and that ordering is the point.** An unshared
write is already lost; a full disk is about to fail; this is a standing
condition. `tone: 'secondary'`, not `danger` — nothing has gone wrong, and
shouting it would train people to ignore the tones that mean something has.

## The part that could have been quietly wrong

`otherDeviceCount` counts **surviving copies, not rows**:

```sql
WHERE id != ? AND authorized_at IS NOT NULL AND revoked_at IS NULL
```

`devices` carries inert `pairing_status='unknown'` stubs for any peer this device
merely *heard an op from* — they never paired and hold nothing. And a revoked
device is one the director deliberately cut off; counting it would be the most
dangerous possible wrong answer, telling a camp it is safe **because of a machine
they took away on purpose**. Both have their own test.

## Copy that is true today and stays true

It says there is *no second copy to restore from* — a fact about the camp right
now — rather than *the data cannot be recovered*, which only becomes true once
at-rest encryption is switched on. Writing the stronger sentence early would be a
claim the code does not yet support: the T149 defect class, avoided in advance
rather than fixed afterwards. Pinned by a test that asserts the phrase is absent.
