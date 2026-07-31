---
title: T22-most-ops-record-no-author
document_type: ticket
status: completed
created: 2026-07-30
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md]
archive_when: resolved
---

> **RESOLVED 2026-07-30.** All three write paths in `electron/sync/syncClient.js` now accept
> `author_user_id` as a parameter — the local `write`, `writeBulkReplace`, and the remote
> `performWrite` — falling back to the constructed value only when a caller supplies none.
>
> **`main.js` was never at fault.** It has always passed `author_user_id: userId` on every write
> (`:509`). The write functions simply did not declare the parameter, so the value was discarded
> and the closure's — `null`, fixed at construction before anyone logs in (`main.js:228`) — was
> written instead. Not missing schema, not a missing caller: a parameter that was never declared,
> silently swallowing a value that was correctly supplied.
>
> Proven before fixing, with a probe that constructed the client and called it exactly as main.js
> does: `author recorded -> null` for a caller passing `user-1`. After the fix, `user-1`.
>
> **This only attributes ops written from now on.** The existing unattributed ops cannot be
> reconstructed, so Trash and History will keep showing "Unknown" for everything already done.

# T22 — Most operations record no author, so "who did this" is usually Unknown

**Risk:** Medium. It silently defeats the attribution the product owner explicitly asked for.
Pre-existing.
**Found:** 2026-07-30, immediately on using the new Trash screen.

---

## What happens

The Trash screen's **BY** column reads:

> Unknown · Gregs-MacBook-Air-3.local

The device resolves; the person does not. The delete op carries an empty `author_user_id`.

Measured on the dev camp:

```
total ops   402
with author  32      (8%)
```

92% of operations record no author at all. The op log's `author_user_id` column exists and is
populated on some path, so this is not missing schema — it is a write path that mostly does not
supply it.

## Why it matters

The product owner decided on 2026-07-30 that attribution is shown to everyone, on the stated
assumption of no shared devices
([ADR](../../adr/2026-07-30-restore-deleted-records-from-the-op-log.md), Product-owner
decisions). Both new surfaces — Trash and record History — are built to display it.

They will display **Unknown** for almost everything. A history that cannot say who did something
is a list of timestamps, and the feature reads as broken even though it is faithfully reporting
what the log contains.

## Where to look

`syncClient` is constructed with an `author_user_id`, and at least one existing test asserts the
host path creates it with **null** (`electron/main.test.js`, "creates a local syncClient with
author_user_id null"). That suggests the client is built before a user is known — at mode
selection rather than at login — and never updated once someone signs in. Confirm before fixing;
this is a lead, not a diagnosis.

Worth checking at the same time whether the 32 attributed ops come from a different path, which
would identify the one place that does it correctly.

## Completion evidence

1. An op written after sign-in carries the signed-in user's id.
2. Trash and History show a person's name for actions taken while signed in.
3. Ops written before anyone signs in — bootstrap, pairing — remain honestly unattributed rather
   than being assigned to a guessed user.
4. A test asserts the author is set, so this cannot silently regress to null again.
