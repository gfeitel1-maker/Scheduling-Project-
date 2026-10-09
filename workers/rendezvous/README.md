# Rendezvous Worker (T209, Phase A) — undeployed

This directory holds the source and tests for a Cloudflare Worker + SQLite-backed Durable Object "bulletin board"
described in `docs/work/tickets/T209-rendezvous-worker-phase-a.md` and
`docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md`. **Nothing here is deployed, and
nothing in this repository's automated workflow deploys it.** It is not wired into the Shoresh
app in any way — no code under `src/` or `electron/` imports or calls anything in this directory.

Deploying it is an **owner action**, outside every ticket in this program (T209 §"Does NOT count
as done"). This README exists so that whoever does deploy it knows what is and is not handled by
the code.

## What this Worker does

- `POST /v1/register` — stores an opaque, already-signed record blob for a peer id in the
  single store, with a ~2h TTL.
- `GET /v1/peers/<namespace>` — returns the (unordered, capped) list of record blobs currently
  live under a namespace.

It never decodes, parses, or verifies the record it stores — see the contract comment at the top
of `worker.js`. All trust decisions happen client-side, in code that is not part of this ticket.

## What the code defends against, and what it does not

`worker.js`'s file header spells this out in detail. Owner ruling, 2026-10-09: **"i do not want each camp
getting their own storage. this is a tiny relay service"**. So: **one Worker, one store, nothing per camp.**
Storage is ONE SQLite-backed Durable Object for the whole service
(`env.RENDEZVOUS_DO.idFromName("rendezvous")`, a constant), holding every namespace as rows, per
`docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md` (Amendment 2026-10-09 (owner): single store).

- **Exact, per namespace** (held in the store, serialized): at most `MAX_PEERS_PER_NAMESPACE = 200`
  unexpired distinct peers, and at most `WRITES_PER_WINDOW = 30` accepted registers per rolling 60s.
  Over either: 429. No IP or IP-derived value is stored.
- **Exact, whole service**: at most `GLOBAL_WRITES_PER_DAY = 7000` accepted registers per UTC day, one counter
  row. Over it: 429 with `service write budget exhausted` (the per-namespace error is `namespace write budget
  exhausted`). Refused requests consume no budget and perform no write.
- **Best-effort only**: the per-IP throttle (`REGISTER_LIMITER`, `PEERS_LIMITER`). Per-location and
  approximate, so it has no guaranteed bound; it runs before dispatch. Missing binding: 503.
- **Cheap rejects before dispatch**: method, path, namespace/peer-id shape, body size and shape. A GET
  for a namespace with no rows performs zero writes and returns an empty list.
- **Accepted residual (owner posture call 2026-10-09: stay on the Free plan)**: the global budget bounds the
  exhaustion attack but the IP throttle is best-effort, so a stranger can still spend the whole global budget
  with fresh namespaces. Rung 3 (this last-resort rendezvous) is then down for **every** camp until 00:00 UTC.
  That is the honest residual; a paid plan or an authenticated register would close it.
- **Accepted residual, request quota**: GETs and refused requests write no rows, but each still costs a
  Durable Object and a Worker REQUEST, and the Free plan gives 100k requests/day. A stranger can exhaust the
  request quota with cheap GETs. The impact is the same: rung 3 is down for every camp until 00:00 UTC; LAN
  and rungs 1-2 are unaffected.

### Sizing the budgets from the Free limit

The Free plan allows 100k rows written/day account-wide. Worst-case rows written per accepted register,
counted conservatively: `peers` upsert 1 + secondary index 2 = 3; `writes` log insert 1 + index 1 = 2, and its
later delete 2; global counter update 1; eventual delete of the peer row 3. **11 rows.**
`7000 x 11 = 77,000` rows/day, plus the once-a-day sweep (rows already counted above) and one old counter row,
so at or below ~80,000: a 20% margin. `N_global = 7000`. `N_ns = 30` is far under half of that (3,500). One
namespace at 30/min would need about 233 minutes to spend the day's budget. After S4c the client reaches
rung 3 only while rungs 1-2 fail, with backoff (60s doubling, capped near 30 min), so real load is small.

It does not, and cannot, control Cloudflare's own edge request logging.

**The per-namespace cap is a lockout primitive, not just an abuse bound.** Anyone who knows a
namespace can register up to `MAX_PEERS_PER_NAMESPACE` fabricated peer ids in it. Already-registered
peers keep refreshing without limit, but a new legitimate device (e.g. a re-imaged staff laptop)
that has not registered yet is then permanently refused with 429 until the owner rotates the
namespace (T210 Decision 3) or an existing entry's TTL expires. Namespace rotation closes this;
lowering the cap does not — see the fuller note in `worker.js`'s file header.

## What the owner must configure before or at deploy time

1. **Rate limiting.** Both routes are unauthenticated by design (any previously paired peer can
   publish). Per-caller throttling ships in code via the `[[ratelimits]]` bindings in
   `wrangler.toml` (a `workers.dev` route has no zone, so no WAF rule can front it); `wrangler
   deploy` creates them. Re-deploy after changing the limits. If the Worker ever moves to a custom
   domain with a zone, a WAF rate-limiting rule can be added in front as a second layer.
2. **Log retention.** This board is a live register of the public IP addresses of staff laptops at
   children's camps. The Worker itself never logs a request body, IP, namespace, or peer id (there
   is no logging call in `worker.js`), but Cloudflare's own edge request logs are outside the
   Worker's control and outlive the ~2h record TTL. Set the account's log retention as short as the
   Cloudflare plan allows, and do not enable Logpush or any other logging integration for this
   route without re-checking that decision against the privacy finding in
   `docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md` §2.3.
3. **Durable Object binding.** Nothing to create by hand. "i do not want each camp getting their own
   storage": one `wrangler deploy` ships the Worker, the `RENDEZVOUS_DO` binding and the `[[migrations]]` tag
   `v1` (`new_sqlite_classes = ["RendezvousStore"]`). The tag is safe to reuse because the earlier
   per-namespace design (#824) was never deployed. Deploy order: `npx wrangler deploy --dry-run`, then
   `npx wrangler deploy`, then the acceptance checks in the ADR.
4. **Domain.** The spec names `rendezvous.shoresh.org` as the intended host; registering and
   routing that domain to this Worker is the owner's to do, not this ticket's.

## Testing

`worker.test.js` runs under this repository's existing Vitest (`npm run test`), against an
in-memory fake Durable Object binding (`fakeDurableObject.js`, real SQLite via `better-sqlite3`) with a faked `Date` — no `wrangler`, no
`miniflare`, no network call, and no new dependency. It calls the handler's exported
`fetch(request, env)` function (via `handleRequest`) directly, so what it proves is a
handler-level round-trip — two independent calls into the same in-process handler, one crossing
the TTL boundary via the injected clock — not a live network round-trip against a deployed Worker.
