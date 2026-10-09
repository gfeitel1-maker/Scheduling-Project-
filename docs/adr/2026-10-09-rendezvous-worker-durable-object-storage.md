---
title: "Rendezvous Worker storage moves from Workers KV to one SQLite-backed Durable Object for the whole service"
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

# Rendezvous Worker storage: one SQLite-backed Durable Object for the whole service

## Status

ACCEPTED by the keeper under owner delegation. Implementation is a follow-up slice.

## Amendment 2026-10-09 (owner): single store

Owner ruling, verbatim: **"i do not want each camp getting their own storage. this is a tiny relay
service"**. This supersedes the one-instance-per-namespace design first accepted above (merged as #824,
never deployed). The amended design, in the owner's spirit: **one Worker, one store, nothing per camp.**

- **One Durable Object instance for the whole service**: `env.RENDEZVOUS_DO.idFromName("rendezvous")`,
  a constant never derived from the namespace. Its SQLite holds every namespace as rows.
- **Migration.** `wrangler.toml` keeps `[[migrations]]` tag `"v1"` with `new_sqlite_classes` and the new class
  name (`RendezvousStore`). Reusing the tag is safe because #824 was never deployed: no live Worker has a `v1`
  with the old class (`RendezvousNamespace`) to conflict with.
- **A global write budget** is added (below), because fresh namespaces now share one store and one quota.
- **Owner posture call (2026-10-09, relayed by the board keeper): stay on the Free plan, and accept the
  stranger-outage of rung 3 until 00:00 UTC as a residual.** The global budget bounds that outage; it does not
  prevent it (Residuals).

Sections Decision, Residuals and Acceptance checks below are written for the amended design.

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

The Worker keeps its HTTP surface and moves storage to ONE SQLite-backed Durable Object class with exactly
ONE instance for the whole service (`env.RENDEZVOUS_DO.idFromName("rendezvous")`).

**Owner ruling (verbatim): "i do not want each camp getting their own storage. this is a tiny relay
service".** Therefore: one Worker, one store, nothing per camp. ONE `wrangler deploy`, ZERO per-camp setup;
a new camp is just a new `namespace` value in existing rows.

- **Schema.** `peers (namespace, peerId, record /* opaque base64 */, expiresAt)` with `PRIMARY KEY
  (namespace, peerId)` (`WITHOUT ROWID`) and an index on `(namespace, expiresAt)`; `writes (namespace, at)`
  with an index on `(namespace, at)` as the rolling per-namespace log; `budget (day, n)` holding one counter
  row per UTC day for the global budget.
- **Register** is one serialized request with no `await` between check and write: check the global budget,
  check the per-namespace budget, count UNEXPIRED distinct peers in the namespace; refuse a NEW peer beyond
  200 with 429 (re-registering an existing peer is exempt); then purge, log and upsert. The cap is EXACT.
  Every refusal returns before any write.
- **Per-namespace write budget: N_ns = 30 accepted registers per exact rolling 60s**, held in the store with
  no IP or IP-derived key. Error string `namespace write budget exhausted`.
- **Global write budget: N_global = 7,000 accepted registers per UTC day** for the whole service, one counter
  row updated in place, exact. Error string `service write budget exhausted` (429). It resets at 00:00 UTC.
  Refused requests do NOT count against either budget, so a flooder cannot extend their own lockout.
- **Sizing from the Free limit (100k rows written/day, account-wide).** Conservative worst-case rows written
  per accepted register: upsert into `peers` 1 + secondary index 2 = 3; `writes` insert 1 + index 1 = 2 and its
  later deletion 2; global counter update 1; eventual deletion of the peer row 3. Total 3 + 2 + 2 + 1 + 3 = 11.
  7,000 x 11 = 77,000 rows/day, plus the once-a-day sweep (bounded by rows already counted) and one old-day
  counter delete: at or below 80,000 (20% margin on 100,000). N_ns = 30 is far under half of N_global (3,500).
  A single namespace sustaining 30/min would take about 233 minutes to spend the global budget; that
  is the namespace-holder residual below, not something a per-minute window can prevent.
- **Peers listing** is one query filtered by `namespace` and `expiresAt > now`; no writes.
- **Purge:** the `expiresAt` filter at query time, plus opportunistic deletion of the written namespace's expired
  rows on each accepted register, plus one service-wide sweep on the first accepted write of each UTC day (a
  full scan once a day, not per write). No DO alarm.
- **Unknown namespaces.** A GET for a namespace with no rows performs zero writes and returns an empty list.
  Everything the Worker can validate cheaply (method, path, namespace and peer-id shape, record size) is
  rejected BEFORE dispatch, and the dispatch to the store is header-less.
- **Untrusted opaque cache, unchanged.** The Worker never decodes, orders, or applies "latest wins"; the
  client's `(epoch, seq)` watermark still arbitrates (2026-09-18 ADR).
- **`[[ratelimits]]` stays as BEST-EFFORT only**, no guaranteed bound, and it is the only in-line control
  that runs before dispatch. A missing or failing binding fails closed (503).
- **Deploy.** `wrangler.toml` has one `[[durable_objects.bindings]]` entry (`RENDEZVOUS_DO`, class
  `RendezvousStore`) and `[[migrations]]` tag `v1`; the KV binding is gone. Existing KV records are NOT
  migrated (TTL about 2h; no app points at the Worker yet).
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

1. **Stranger-outage of rung 3 until 00:00 UTC (availability, ACCEPTED by the owner's posture call: stay on
   the Free plan).** The per-IP throttle is best-effort, so a stranger who knows NO camp can still spend the
   GLOBAL budget with requests on fresh random 64-hex namespaces. The global budget bounds the damage (it keeps
   the service under the Free quota and stops the attack from costing anything) but does not prevent it: once
   the 7,000 accepted writes are gone, rung 3, the LAST-RESORT fallback, is down for EVERY camp until 00:00 UTC.
   LAN and rungs 1-2 keep working and no camp data is exposed. Future options: the paid plan, or an
   authenticated register.
2. **Holder write volume.** One namespace-holder at N_ns = 30 can spend the whole global budget in about
   233 minutes (7,000 / 30), denying the other camps the same way. Realistic load is far lower: after S4c the
   client reaches rung 3 only while rungs 1-2 fail, with backoff (60s doubling, capped near 30 min).
3. **Budget lockout.** A namespace-holder who holds the budget at N_ns makes honest refreshes get 429, so
   honest peers lapse after the 2h TTL. The cap likewise remains a lockout primitive. T210 namespace
   rotation is the fix for both.

## Acceptance checks (post-deploy, run by the keeper)

- **(a) Budget:** a burst of 300 registers to one namespace within 60s yields exactly 30 accepted and 270
  refused with 429 (refused requests do not consume budget).
- **(b) Cap:** register 200 distinct peers spread across enough minutes to stay under N; peer 201 gets 429;
  an existing peer's refresh is still accepted. The cap counts UNEXPIRED rows only.
- **(c) No setup:** a brand-new, never-seen namespace registers and lists with no prior setup of any kind.
- **(d) Unknown GET:** `GET /v1/peers/<never-used namespace>` returns `{"peers":[]}` and does not move the
  rows-written counter.
- **(e) Global budget, counted by error string:** from fresh namespaces, exactly 7,000 registers are accepted
  in a UTC day; every further one is 429 with `service write budget exhausted` (not
  `namespace write budget exhausted`). Do NOT run this against the deployed Worker without owner say-so: it
  spends the day's budget and takes rung 3 down until 00:00 UTC. The in-repo test (f) is the evidence.
- **(f) One store:** the Cloudflare dashboard shows exactly one Durable Object instance for the class.
