---
title: "Rendezvous Worker storage moves from Workers KV to one SQLite-backed Durable Object per namespace"
document_type: adr
authority: normative
status: accepted
implementation_state: not-started
date: 2026-10-09
decided: 2026-10-09
deciders: [keeper (owner delegation)]
program: security-hardening
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md, docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md]
supersedes: []
amends: []
implements: []
---

# Rendezvous Worker storage: one SQLite-backed Durable Object per namespace

## Status

ACCEPTED by the keeper under owner delegation. Implementation is a follow-up slice.

## Context

The rendezvous Worker (`workers/rendezvous/worker.js`) stores opaque signed peer records in Workers KV
and relies on the Workers Rate Limiting binding (`[[ratelimits]]`) for abuse bounds. Measured and
documented evidence shows both are the wrong primitive on the Cloudflare Free plan:

1. **KV quota is exhausted by one honest device.** Free KV allows 1,000 writes/day and 1,000 list
   ops/day, resetting 00:00 UTC
   ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The client ticks
   register plus `GET /v1/peers` every 60s per device (`electron/sync/automerge/rendezvousClient.js`,
   `intervalMs: 60_000`; `registerRecord` then `fetchPeers`), and the peers route calls `kv.list`.
   One device is about 1,440 lists/day, over quota. A live 300-register burst by the keeper on
   2026-10-09 consumed 30% of the day's writes: enough to deny service to every camp until UTC midnight.
2. **Neither bound held under the same burst.** All 300 requests returned HTTP 200, so the
   `[[ratelimits]]` binding never refused. Cloudflare documents it as permissive, eventually
   consistent, not an accurate accounting system, and counted per location
   ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
   `MAX_PEERS_PER_NAMESPACE=200` also did not trip, because KV list is eventually consistent (up to
   about 60s) and non-atomic ([docs](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
3. **SQLite-backed Durable Objects are available on Free**: 100k requests/day, 100k rows written/day,
   5M rows read/day, 5 GB ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
   A Durable Object processes requests for one id serially, which gives the exact counting KV cannot.

## Decision

The Worker keeps its HTTP surface and moves storage to ONE SQLite-backed Durable Object per namespace
(`env.NAMESPACE_DO.idFromName(namespace)`).

- **Schema.** Per-DO table of `(peerId TEXT PRIMARY KEY, record TEXT /* opaque base64 */, expiresAt INTEGER)`.
- **Register** is one serialized request: count unexpired distinct peers; refuse a NEW peer beyond 200
  with 429 (re-registering an existing peer stays exempt, as today); upsert. The cap becomes EXACT.
- **Exact write budget.** N register writes per rolling minute per namespace, held in the DO, with no IP
  or IP-derived key. This is the hard abuse bound. N is sized from 20-device camps at one register per
  minute each, with headroom (value fixed in the implementing slice and recorded in the README).
- **Peers listing** is one query filtered by `expiresAt > now`. Expired rows are reclaimed by a DO alarm
  or an opportunistic purge on write.
- **Untrusted opaque cache, unchanged.** The Worker still never decodes, orders, or applies "latest
  wins"; the client's `(epoch, seq)` watermark still arbitrates (2026-09-18 ADR).
- **`[[ratelimits]]` stays as BEST-EFFORT only**, with no guaranteed bound. The overclaiming wording in
  the `worker.js` header ("bounds abuse") and in `workers/rendezvous/README.md` is corrected to say so.
- **Deploy.** `wrangler.toml` gains a `[[durable_objects]]` binding and a `[[migrations]]` entry with
  `new_sqlite_classes`; the KV namespace binding is removed. Existing KV records are NOT migrated: TTL
  is about 2h and no app points at the Worker yet (`SHORESH_RENDEZVOUS_URL` is unset everywhere).
- **Privacy unchanged.** No IP, namespace, or peer id is logged; no IP is stored anywhere.

### Related decision (implemented in slice S4b)

The client polls the rendezvous ONLY while rungs 1 and 2 of the relay-less ladder are failing, with
backoff. It never ticks every 60s indefinitely. See
`docs/adr/2026-10-08-relayless-cross-network-reconnect.md`. This bounds steady-state load on the DO
free limits.

## Consequences

- The cap and the write budget become exact and atomic per namespace; the quota-denial failure in
  (1) no longer lets one device or one burst starve other camps.
- **Residuals.** DO Free daily limits still apply: a namespace-holder can exhaust their own
  namespace's budget, and the account-global 100k requests/day applies. The cap remains a lockout
  primitive for anyone holding the namespace; namespace rotation (T210) is still the fix.
- Cost: a new Cloudflare primitive (DO + migration) and a rewritten test fake in place of `fakeKv.js`.
- Reversibility: moderate; the HTTP contract is unchanged, so clients are unaffected.

## Acceptance check

After deploy, the keeper re-runs the 300-register burst against one namespace and expects exactly
200 accepted and 100 refused (429).
