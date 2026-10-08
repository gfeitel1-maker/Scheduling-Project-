---
title: "T340 precondition evidence — C2/C4 re-confirm, dcutr-subtree audit, literal-'true' flag"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-08
governing_docs: [docs/work/tickets/T340-wan-activation-go-live-checklist.md, docs/adr/2026-10-08-max-connections-dos-mitigation.md, docs/work/security/2026-10-03-t336-c4-preauth-sizing.md, SECURITY.md]
archive_when: T340 is archived
---

# T340 precondition evidence (2026-10-08)

Evidence gathered in the same slice as the connection-manager DoS hardening (T340 item 1). Nothing
here activates anything; `SHORESH_RELAY_ENABLED` is untouched. Re-run at the activation gate.

## (a) T337 C2 and C4 re-confirmed against current code

**C2 — client camp-only reservation. Holds.**
- `electron/sync/automerge/transport.js:137` `wrapClientRelayDiscoveryToCampOnly` wraps the relay
  transport factory; `:172-181` replaces `instance.discovery.filter` so `has()` returns `true`
  (treated as already-seen, never notified) for any peer where `isPeerAdmittedForRelay(id)` is false.
- `:284` binds `isPeerAdmittedForRelay` to the same `authenticatedPeers` set every other admission
  check reads; `:194` `retryClientRelayDiscoveryFor` re-attempts a reservation only after admission.
- Pinned by `electron/sync/automerge/relayClientCampOnlyReservation.test.js` (passes in the
  `electron/sync/automerge` run recorded below).

**C4 — 64 KiB pre-auth sizing. Holds.**
- `electron/sync/automerge/wireProtocol.js:65` `AUTH_MAX_FRAME_BYTES = 64 * 1024`.
- `electron/sync/automerge/authGate.js:392` passes `{ maxDataLength: AUTH_MAX_FRAME_BYTES }` to the
  `receiveFramed` on `AUTH_PROTO`, the only protocol reachable before admission; the 32 MiB
  `MAX_FRAME_BYTES` (`wireProtocol.js:54`) applies only to the doc-sync handlers, which refuse
  un-admitted peers first.
- Per-source rate limits on pairing/login are unchanged in `authGate.js`.

Gate evidence: `npx vitest run --no-file-parallelism electron/sync/automerge` -> 52 files, 471 tests
passed; `npm run test:integration` -> 28/28 passed.

## (b) dcutr-subtree `npm audit` and install-script re-check

`npm ls @libp2p/dcutr --all` -> `@libp2p/dcutr@3.0.28` (declared `^3.0.28`, `package.json:50`).

```
$ npm audit --omit=dev
found 0 vulnerabilities
```

Install-script walk over the full transitive dependency tree of `@libp2p/dcutr` (57 packages,
resolved from `node_modules`): no `preinstall`, `install` or `postinstall` script anywhere. Three
packages carry `prepare` (`@dnsquery/dns-packet`, `@leichtgewicht/ip-codec`, `utf8-codec`) and one
`prepublish` (`netmask`); npm runs those only when building from a git checkout or publishing, not
when installing a registry tarball, so none executes on a consumer install.

Not in the subtree, recorded for honesty: plain `npm audit` (including devDependencies) reports 32
vulnerabilities (1 low, 14 moderate, 15 high, 2 critical) in build/test tooling and Electron itself
(`electron`, `electron-builder`, `vite`, `vitest`, `tar`, ...). None is a dcutr dependency. They are
outside T340's check as scoped but are not claimed clean.

## (c) The literal-`'true'` flag

`electron/sync/automerge/syncStarter.js:386`:
`const relayEnabled = process.env.SHORESH_RELAY_ENABLED === 'true'`. Strict equality with the string
`'true'`; `'1'`, `'TRUE'`, `'yes'`, `' true'`, or unset all evaluate false and leave relay and dcutr
inert (fail closed). `relayRuntimeEligible` additionally requires the next rung's package to be
present. Operational rule for go-live: set exactly `SHORESH_RELAY_ENABLED=true`, lowercase, no
whitespace. No other code site reads the variable.
