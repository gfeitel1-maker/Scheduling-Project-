---
title: T14-dev-run-reports-as-packaged-build
document_type: ticket
status: open
created: 2026-07-28
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-explicit-userdata-directory.md]
related_tickets: [docs/work/tickets/T13-stamp-build-provenance.md]
archive_when: resolved
---

# T14 — A development run reports itself as a packaged build

**Risk:** Low operationally — the packaged app is correct and no camp data is affected.
Meaningful for diagnosis: it reintroduces, in the opposite direction, the ambiguity T13
was filed to eliminate.
**Found:** 2026-07-28, during the first visual verification of the T8–T13 changes.

---

## The problem

Under `npm run electron:dev`, the sidebar footer reads:

```
v43.1.1 · 655e57a · 2026-…
```

Per [`electron/buildInfo.js`](../../../electron/buildInfo.js) it should read `v0.1.0 · dev`.

A development run therefore claims to be a packaged build from a specific commit. T13 exists
so that "what am I actually running" is answerable at a glance; right now that glance returns
a confident wrong answer. The commit shown is whatever was last packaged, so it will look
plausible and stale — the same failure mode that cost a diagnosis cycle on T12.

The DEV badge (T9) is unaffected and does render correctly, so the two indicators in the same
footer currently disagree with each other.

## Causes

Two independent causes, both required for the observed string.

**1 — the stamp file survives packaging and leaks into dev runs.**
`scripts/write-build-info.js` writes `electron/build-info.json` at package time. It is
gitignored (`.gitignore:44`) but never removed afterwards, so it persists in the working tree
and `readBuildInfo()` reads it on every subsequent development run, returning
`{ isDev: false, commit: '655e57a…' }`.

The comment at [`electron/buildInfo.js:16-19`](../../../electron/buildInfo.js) states the
governing assumption directly:

> A development run has no such file, and that is a meaningful answer rather than a missing one

That assumption is false on any machine that has ever run `npm run electron:build` — which is
every machine that has ever shipped the app.

**2 — `app.getVersion()` returns Electron's version in an unpackaged run.**
[`electron/main.js:799`](../../../electron/main.js) calls `app.getVersion()`. Unpackaged, that
returns Electron's own version (`43.1.1`), not the app's `0.1.0`. Packaged, it correctly
returns `0.1.0`.

## Why the tests did not catch it

`electron/buildInfo.test.js` exercises `parseBuildInfo` and `formatBuildLabel` as pure
functions. Both are correct and both pass. Neither cause lives in them:

- Cause 1 is in *which file reaches* `readBuildInfo()` — a filesystem and lifecycle question.
- Cause 2 is in *what `main.js` passes as `version`* — an Electron runtime question.

T13's completion evidence required verification under `npm run electron:build`. It did not
require verification of the *development* case, which is where both defects live. This is the
gap to close, not merely the symptom.

## Proposal

Confirm the approach before implementing.

1. Have `readBuildInfo()` return `DEV_BUILD` whenever `app.isPackaged` is false, so a stale
   `build-info.json` cannot be read by a development run regardless of what is on disk.
   Prefer this over deleting the file — cleanup can be skipped, an explicit guard cannot.
2. Source the version from `package.json` rather than `app.getVersion()`, so the number shown
   is the app's in both run modes.
3. Add tests covering the unpackaged case for both causes — the current suite structurally
   cannot fail on either.

## Completion evidence

1. `npm run electron:dev` shows `v0.1.0 · dev` in the sidebar footer.
2. It still shows `v0.1.0 · dev` immediately after a `npm run electron:build`, with
   `electron/build-info.json` present on disk.
3. A packaged build still shows `v0.1.0 · <commit> · <date>` — T13's behaviour is unchanged.
4. Tests fail if either cause is reintroduced.
5. Verified by looking at both run modes, not only by unit tests — this is a defect that only
   appears when the real app runs.
