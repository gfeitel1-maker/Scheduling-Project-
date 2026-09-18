# Rendezvous Worker (T209, Phase A) — undeployed

This directory holds the source and tests for a Cloudflare Worker + Workers KV "bulletin board"
described in `docs/work/tickets/T209-rendezvous-worker-phase-a.md` and
`docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md`. **Nothing here is deployed, and
nothing in this repository's automated workflow deploys it.** It is not wired into the Shoresh
app in any way — no code under `src/` or `electron/` imports or calls anything in this directory.

Deploying it is an **owner action**, outside every ticket in this program (T209 §"Does NOT count
as done"). This README exists so that whoever does deploy it knows what is and is not handled by
the code.

## What this Worker does

- `POST /v1/register` — stores an opaque, already-signed record blob under a KV key scoped to a
  namespace and peer id, with a ~2h TTL.
- `GET /v1/peers/<namespace>` — returns the (unordered, capped) list of record blobs currently
  live under a namespace.

It never decodes, parses, or verifies the record it stores — see the contract comment at the top
of `worker.js`. All trust decisions happen client-side, in code that is not part of this ticket.

## What the code defends against, and what it does not

`worker.js`'s file header spells this out in detail; in short, the code bounds per-request work,
validates namespace/peer-id shape strictly (so they cannot be used to forge or collide KV keys),
caps the record size, and caps entries per namespace. It does **not** rate-limit by caller, and it
does not, and cannot, control Cloudflare's own edge request logging.

## What the owner must configure before or at deploy time

1. **Rate limiting / WAF.** `POST /v1/register` is unauthenticated by design (any previously
   paired peer can publish). Configure a Cloudflare Rate Limiting rule (or a WAF custom rule) on
   this route — this is an account/dashboard setting, not something expressible in `wrangler.toml`
   or Worker source.
2. **Log retention.** This board is a live register of the public IP addresses of staff laptops at
   children's camps. The Worker itself never logs a request body, IP, namespace, or peer id (there
   is no logging call in `worker.js`), but Cloudflare's own edge request logs are outside the
   Worker's control and outlive the ~2h record TTL. Set the account's log retention as short as the
   Cloudflare plan allows, and do not enable Logpush or any other logging integration for this
   route without re-checking that decision against the privacy finding in
   `docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md` §2.3.
3. **KV namespace binding.** Create the KV namespace (`wrangler kv namespace create
   RENDEZVOUS_KV`) and fill in its id in `wrangler.toml`, which is left blank in this repository on
   purpose.
4. **Domain.** The spec names `rendezvous.shoresh.org` as the intended host; registering and
   routing that domain to this Worker is the owner's to do, not this ticket's.

## Testing

`worker.test.js` runs under this repository's existing Vitest (`npm run test`), against an
in-memory fake KV namespace (`fakeKv.js`) with an injectable clock — no `wrangler`, no
`miniflare`, no network call, and no new dependency. It calls the handler's exported
`fetch(request, env)` function (via `handleRequest`) directly, so what it proves is a
handler-level round-trip — two independent calls into the same in-process handler, one crossing
the TTL boundary via the injected clock — not a live network round-trip against a deployed Worker.
