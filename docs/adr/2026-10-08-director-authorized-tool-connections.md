---
title: "Director-authorized tool connections: how an MCP/CLI tool is authorized to a camp, and how that authorization releases the at-rest DB key"
document_type: adr
authority: normative
status: accepted
implementation_state: not-started
date: 2026-10-08
decided: 2026-10-08
deciders: [product-owner-delegate-organizer]
program: security-hardening
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md, docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md]
supersedes: []
amends: [docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md]
implements: []
blocks: [T175]
---

# Director-authorized tool connections (T175 prerequisite)

## Status

ACCEPTED. The interpretation flagged below was put to the owner and ruled.

> **Owner ruling, 2026-10-08, verbatim:** "A. it's accountability."

Interpretation A is confirmed: this is a **governance and accountability** control layered on the
existing same-OS-user + keychain boundary — **no new cryptographic boundary, no posture change**; the
2026-09-16 ADR's "same-OS-user = already trusted" tradeoff stands. Accepted by the organizer under
delegation with the owner's interpretation on record. Design-only.

### Non-goal (explicit)

This authorization layer **does NOT defend against a same-OS-user attacker.** A process running as the
same OS user, with the same keychain access the app has, can still obtain the key by running the
unlock helper itself — unchanged and inherent to `safeStorage` (2026-09-16 ADR). The control's value
is **accountability**: a director's explicit, named, revocable, listed, audited choice of which tools
connect, and a clear named refusal when one is not authorized. It is not, and must not be presented
as, a cryptographic barrier against a local attacker.

## First principle (owner, verbatim)

> "the idea here with the mcp and cli is that someone is authorizing their tools to connect here.
> that is a simple principle. and it is a first principle."

The owner rejected both removing the MCP/CLI and having them refuse when encryption is on. So the
tools stay, they work with at-rest encryption on, and a director **explicitly authorizes** each tool
to connect to their camp — and that authorization is **also** how the tool obtains the DB key.

## Context

With at-rest encryption (T175) on, the camp DB opens only with the key, which lives in the OS
keychain and is reachable only under Electron via `safeStorage`
(`electron/db/dbEncryptionKey.js` `getOrCreateDbKey`; `electron/main.js` `acquireDbKey`). Plain-Node
headless callers — `scripts/mcp/tools.js` (MCP server), `scripts/ingestCli.js`,
`scripts/electivesCli.js`, `scripts/preferenceSheetCli.js` — cannot reach the keychain, so with no
key they throw the opaque `db_key_unavailable`.

The key-RELEASE mechanism already exists (ADR 2026-09-16, T179 slice 2):
`electron/unlockDbKey.js` runs under Electron, unseals the key via `safeStorage`, and spawns the tool
with `SHORESH_DB_KEY` in its child env only — never on disk. The tools already consume the key only
from `SHORESH_DB_KEY`/`SHORESH_DB_KEY_FILE`, never argv (`scripts/mcp/server.js:55`;
`scripts/mcp/tools.js:157` `openLocalDb(dbPath, { key })`).

What that mechanism does NOT have is an **authorization gate**: today its trust model is implicit —
"anyone who is the OS user and can run Electron" (2026-09-16 ADR §: "it adds no new trust: anyone who
could run it could read the data anyway"). The owner's first principle asks for an **explicit,
director-granted, per-tool** authorization. This ADR adds exactly that gate, reusing the existing
release path and key custody.

## Posture — the one thing to confirm (FLAG to owner)

The 2026-09-16 ADR is explicit that the unlock helper sits on the **OS-user + keychain** trust
boundary and adds no cryptographic defense against a same-OS-user attacker — such an attacker can
run Electron and unseal the key regardless. An explicit per-tool authorization layered on that path
is therefore a **director-facing governance/usability control**: explicit grant, in-app listing,
revocation, scope, audit, and a clear named refusal instead of an opaque SQLite error. It is **not**
a new crypto boundary that stops a same-OS-user process from getting the key by other means.

- **Recommended interpretation (what this ADR designs):** the first principle is about the
  authorization *model/gesture* — the director deliberately, revocably authorizes each tool, and
  that grant is the tool's path to the key. This is additive governance on the existing boundary; it
  does not change posture, and it is the smallest design that honors the principle.
- **Alternative interpretation (NOT designed here — would change posture):** the owner wants a new
  cryptographic boundary such that a same-OS-user tool *cannot* obtain the key without a live,
  unforgeable director grant. That is a materially larger design (per-tool key wrapping, a grant
  authority outside the same-user keychain, revocation that survives a cached key, etc.) and it
  reopens the 2026-09-16 ADR's accepted "same-OS-user = already trusted" tradeoff.

I recommend the first. **Confirm which the owner means before build.** I am not deciding it.

## Decision (recommended interpretation)

A small authorization layer on the existing release path. Four parts:

### 1. The authorization record

A director-granted, named, per-tool authorization: `{ id, label (e.g. "Greg's laptop MCP"), scope:
'read' | 'read-write', created_at, created_by (director device), secret_hash }`. Stored in a
**`safeStorage`-sealed authorizations store outside the encrypted camp DB** — it must be readable at
key-release time *without* the camp key (avoiding the chicken-and-egg of "read the authorizations to
release the key, but the authorizations are in the key-protected DB"). Same keychain custody as the
key; no new storage trust. Revocation = remove the record. Each grant/revoke is also written to
`audit_events` (reusing the existing audit sink, SECURITY.md §audit).

### 2. Granting (in-app, director)

A Settings → Connected Tools screen where the director grants a new authorization (names it, picks
read vs read-write), sees the list of current authorizations, and revokes any. The grant action is a
**mutation through `authorize()`** (`electron/auth/authorize.js`) — director role, device trust
re-queried per call, exactly like every other mutation; non-directors cannot grant. On grant, a
per-tool **secret is shown once** for the director to paste into the tool's launch config; only its
hash is stored.

### 3. Key release, gated

`unlockDbKey.js` is tightened: before it unseals and spawns, the caller must present its per-tool
secret (via env/stdin, never argv — mirroring the key's own channel). The helper verifies the secret
against the **live** authorizations store (re-read each call, like `authorize()` re-queries trust —
never a snapshot), confirms the authorization is present and not revoked, and only then unseals and
env-passes the key, propagating the authorization's **scope** (a read-only authorization opens a
read-only DB handle / sets a read-only flag the tool honors). Verification funnels through a
**single** tool-auth checkpoint function (one implementation, so lockout/timing/refusal behaviour
cannot drift between callers — the same single-funnel discipline `attemptLogin`
(`electron/auth/localAuth.js`) has for PIN checks).

### 4. What an unauthorized or revoked tool sees

A **clear, named refusal** — e.g. `tool-authorization-revoked` / `tool-not-authorized`: "This tool is
not authorized to connect to <camp> (or its authorization was revoked). Ask the director to
authorize it in Settings → Connected Tools." NEVER the opaque `db_key_unavailable`. The headless
callers surface this message. `db_key_unavailable` remains only for the genuine
keychain-entry-missing case (unchanged, `electron/automerge/rebuildSupportCommand.js` territory).

### Headless / app-not-running

Unchanged from 2026-09-16: `unlockDbKey` starts Electron transiently to reach `safeStorage`; the
authorizations store is `safeStorage`-sealed and readable in that same transient context. So
authorization + key release work with the app closed, honoring the owner's headless requirement.

## Alternatives considered

- **Per-tool wrapped key (authorization = a copy of the DB key wrapped under the per-tool secret).**
  Makes "authorization is the key" literal and allows release without a live check. REJECTED for the
  recommended interpretation: it is a new crypto artifact (speculative surface — Karpathy), and a
  tool that caches the unwrapped key defeats revocation, so it needs its own no-cache discipline and a
  deletable wrap store — more moving parts than gating the existing release path, with no governance
  benefit over it. It is the natural starting point IF the owner picks the alternative interpretation.
- **Reuse the libp2p device-pairing/admission model for tools.** REJECTED: MCP/CLI tools are not
  network peers (no peerId, no Noise session); modelling them as devices adds concepts the principle
  does not need.
- **Do nothing / let tools refuse when encrypted, or remove them.** REJECTED by the owner explicitly.

## Consequences

- **Positive:** the owner's first principle is realized with minimal surface — reuses `safeStorage`
  custody, the `unlockDbKey` release path, `authorize()`, and `audit_events`. Directors get explicit,
  listed, revocable, scoped, audited tool authorizations and clear refusals; T175 can land because
  the headless callers now have a defined, authorized way to the key.
- **Honest limit:** on the recommended interpretation this is governance on the existing OS-user +
  keychain boundary; it does not defend against a same-OS-user attacker (unchanged, inherent to
  `safeStorage`). Stated so no reader mistakes it for a crypto boundary.
- **Amends** the 2026-09-16 ADR: the unlock helper is no longer "anyone who can run it" — it now
  requires a director-granted authorization. (The underlying OS-user trust boundary is unchanged.)

## Verification (for the implementing slice — test-first, full `npm run verify` gate)

1. Grant→release: a tool presenting a valid, non-revoked secret gets the key (env), opens the camp
   DB, and operates within its scope; read-only authorization cannot write.
2. Revoke→refuse: after revocation (live re-read, not snapshot), the same tool gets the named refusal,
   NOT `db_key_unavailable`; red-before-green.
3. Unknown/forged secret → named refusal; verification goes through the single checkpoint.
4. Grant/revoke are rejected for a non-director (`authorize()`), and both emit `audit_events`.
5. Key never on disk / never in argv (regression of the 2026-09-16 property); secret never logged.
6. App-closed: the transient-Electron path authorizes + releases correctly.
7. `db_key_unavailable` still fires for the genuine missing-keychain-entry case (not masked).
