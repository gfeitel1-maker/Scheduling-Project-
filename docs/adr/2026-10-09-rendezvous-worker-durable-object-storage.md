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

The Worker keeps its HTTP surface and moves storage to ONE SQLite-backed Durable Object class, with one
instance per namespace (`env.NAMESPACE_DO.idFromName(namespace)`).

**Owner constraint (verbatim): "i am not making stores for every camp uniquely".** Therefore: ONE Worker,
ONE `wrangler deploy`, ZERO per-camp manual setup. Per-namespace DO instances are created on demand by
`idFromName(namespace)` inside the single Worker; the DO class migration ships in that same deploy; nothing
per camp is ever done in the Cloudflare dashboard.

- **Schema.** Per-DO table `(peerId TEXT PRIMARY KEY, record TEXT /* opaque base64 */, expiresAt INTEGER)`.
- **Register** is one serialized request: check the budget; count UNEXPIRED distinct peers; refuse a NEW
  peer beyond 200 with 429 (re-registering an existing peer is exempt, as today); upsert. The cap is EXACT.
- **Write budget: N = 30 register writes per rolling minute per namespace**, held in the DO, with no IP or
  IP-derived key. A 20-device camp is about 20/min while rung 3 is in use, and S4b makes rung 3 polling rare
  with backoff. **Refused requests do NOT count against the budget** (only accepted writes do), so a
  flooder cannot extend their own lockout by continuing to hammer.
- **Peers listing** is one query filtered by `expiresAt > now`.
- **Purge:** the `expiresAt` filter at query time, plus opportunistic deletion of expired rows on register.
  No DO alarm: fewer moving parts, and an idle namespace costs nothing and needs no scheduled work.
- **Unknown namespaces.** A GET for a namespace whose DO holds nothing never creates storage and is
  answered from an empty read. Everything the Worker can validate cheaply (method, path, namespace and
  peer-id shape, record size) is rejected BEFORE DO dispatch.
- **Untrusted opaque cache, unchanged.** The Worker never decodes, orders, or applies "latest wins"; the
  client's `(epoch, seq)` watermark still arbitrates (2026-09-18 ADR).
- **`[[ratelimits]]` stays as BEST-EFFORT only**, no guaranteed bound, and it is the only in-line control
  that runs before dispatch. The overclaiming wording in the `worker.js` header and
  `workers/rendezvous/README.md` is corrected to say so.
- **Deploy.** `wrangler.toml` gains a `[[durable_objects]]` binding and a `[[migrations]]` entry with
  `new_sqlite_classes`; the KV binding is removed. Existing KV records are NOT migrated (TTL about 2h; no app
  points at the Worker yet).
- **Privacy unchanged.** No IP, namespace, or peer id is logged; no IP is stored anywhere.

### Related decision (implemented in slice S4b)

The client polls the rendezvous ONLY while rungs 1 and 2 of the relay-less ladder are failing, with backoff,
never every 60s indefinitely. See `docs/adr/2026-10-08-relayless-cross-network-reconnect.md`. Until S4b
ships, safety rests on `SHORESH_RENDEZVOUS_URL` staying unset.

## Consequences

The per-namespace cap and write budget become exact and atomic, and one device no longer exhausts a shared
KV quota. Cost: a new Cloudflare primitive and a rewritten test fake in place of `fakeKv.js`. The HTTP
contract is unchanged, so clients are unaffected.

## Residuals (stated honestly)

1. **Account-global exhaustion (availability, ACCEPTED pending an owner posture call).** The Free DO limits
   (100k requests/day, 100k rows written/day) are account-wide. An attacker who knows NO camp can send
   requests with fresh random 64-hex namespaces; each dispatches to a new DO, so the per-namespace budget
   and cap never apply. The only in-line mitigation is the best-effort IP throttle before dispatch, plus
   the cheap pre-dispatch rejects and no-storage-on-unknown-GET above. Impact: rung 3, the LAST-RESORT
   fallback, is unavailable until 00:00 UTC. LAN and rungs 1-2 keep working and no camp data is exposed.
   This is an availability residual of an unauthenticated public endpoint on the Free plan. Future options:
   the paid plan, or an authenticated register.
2. **Holder write volume.** One namespace-holder at budget N=30 writes about 30 x 1,440 = 43,200 rows/day
   (about 43% of the 100k row limit). Purge deletes count as rows written per the DO pricing, so worst-case
   sustained load is higher still (up to roughly double); two or three such holders can exhaust the day.
3. **Budget lockout.** A namespace-holder who holds the budget at N makes honest refreshes get 429, so
   honest peers lapse after the 2h TTL. The cap likewise remains a lockout primitive. T210 namespace
   rotation is the fix for both.

## Acceptance checks (post-deploy, run by the keeper)

- **(a) Budget:** a burst of 300 registers to one namespace within 60s yields exactly 30 accepted and 270
  refused with 429 (refused requests do not consume budget).
- **(b) Cap:** register 200 distinct peers spread across enough minutes to stay under N; peer 201 gets 429;
  an existing peer's refresh is still accepted. The cap counts UNEXPIRED rows only.
- **(c) No setup:** a brand-new, never-seen namespace registers and lists with no prior setup of any kind.
