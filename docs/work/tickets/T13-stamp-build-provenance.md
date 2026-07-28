---
title: T13-stamp-build-provenance
document_type: ticket
status: open
created: 2026-07-28
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-explicit-userdata-directory.md]
archive_when: build stamp visible in-app and verified under electron:build
---

# T13 — A packaged build cannot be told apart from a current one

**Risk:** Low in isolation, but it directly cost a diagnosis cycle on T12.
**Found:** 2026-07-28, while diagnosing T12.

---

## The problem

`/Applications/Shoresh.app` reports `CFBundleShortVersionString` **0.0.0**. Nothing in the
app, the bundle metadata, or the UI says which commit it was built from or when.

During T12 the reported bug could have lived in three places — `main`, the
`ui/state-primitives` worktree, or the installed app — with different suspects for each.
Settling it required reading `operations.js` out of the shipped `.asar` and comparing
against commit timestamps. That should have been a glance.

ADR 2026-07-28 gave the app a DEV badge, so a **development** build is now obvious. A stale
**packaged** build still looks exactly like a current one.

## Proposal

1. Inject the short commit SHA and build date at package time.
2. Set a real `version` in `package.json` rather than `0.0.0`.
3. Surface both in the sidebar footer, next to the database name and the DEV badge — the
   place a user already looks to answer "what am I actually running".

## Completion evidence

1. A packaged build reports its commit and build date in-app.
2. Two builds from different commits are distinguishable without opening the bundle.
3. Verified under `npm run electron:build`, not only in dev — the stamp has to survive
   packaging, which is exactly where a build-time injection is most likely to silently fail.
