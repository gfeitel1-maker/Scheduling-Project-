---
title: "ADR: Declared message schema for the libp2p pairing/login handshake (AUTH_PROTO)"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-09-15
decided: null
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-09-06-libp2p-membership-mapping.md, docs/adr/2026-09-08-libp2p-join-flow.md]
related_adrs:
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
depends_on_external: []
related_discovery: []
program: shoresh-future-architecture
---

# ADR: Declared message schema for the libp2p pairing/login handshake (AUTH_PROTO)

## Status

**Proposed**, 2026-09-15. The owner has approved replacing hand-written JSON on the handshake path
with a declared schema *in principle*; this document proposes the specific design and is not yet
accepted. It is deliberately sequenced *behind* T165 (see "Sequencing with T165" below) — do not
implement until that ticket's payload-shape decisions land.

## Context

`electron/sync/automerge/transport.js` and `authGate.js` speak three distinct libp2p protocols:
`PROTO` (whole Automerge documents), `SYNC_PROTO` (Automerge's own sync-message format), and
`AUTH_PROTO` (`/shoresh/auth/1.0.0`, `wireProtocol.js:21`). The first two carry Automerge's own
wire format — Automerge owns that schema, and it is out of scope here (see Non-goals). `AUTH_PROTO`
is different: it carries **hand-encoded JSON with no declared shape at all**. Every message is
built as an inline object literal and parsed with `JSON.parse(new TextDecoder().decode(bytes))` —
in `authGate.js`'s `decodeMessage` (receiving side, `authGate.js:75`) and in `transport.js`'s
`authenticateWith` (`transport.js:251`, confirmed by reading the file — this is the outbound
"reconnect" call, not the only JSON.parse site as the task brief's summary suggested; `decodeMessage`
in `authGate.js` is the other, and it is the one that handles all *inbound* frames on this
protocol). There is no shared source of truth for what fields `{type:'authenticate', ...}` or
`{type:'login_ok', ...}` must contain — each caller (`joinSession.js`, `mutualAuth.js`,
`authGate.js`, `connectionAuth.js`) hand-writes both sides and the seven message shapes are
documented only in prose comments, not enforced anywhere.

**Blast radius, verified against the graph and the files (not assumed):**
`graphify affected "sendFramed"` (the shared framing primitive both `PROTO` and `AUTH_PROTO` use)
returns `authGate.js`, `transport.js`, `syncNode.js`, `wireProtocol.test.js`, and
`test/fuzz/wireAndCrypto.fuzz.test.js` as direct consumers — but `sendFramed` is
protocol-agnostic (it frames any byte payload; `PROTO`/`SYNC_PROTO` carry Automerge bytes, not
JSON) so most of that list is out of scope for a JSON schema change. `graphify affected
"AUTH_PROTO"` returned no result — the graph does not index it as a symbol (it's a `const` string
export re-exported and pattern-matched on, not a called function; a null result here means
"unknown," not "nothing depends on it," per this repo's own graph-limits doc). The reliable
source of truth is the `grep -rn AUTH_PROTO electron/` pass, confirmed by opening every hit:
handshake message producers/consumers are exactly `electron/sync/automerge/authGate.js`,
`transport.js` (`authenticateWith` only — its `sendDocTo`/`sendSyncMessage`/`broadcastDoc` carry
`PROTO`/`SYNC_PROTO` bytes and are untouched by this ADR), `joinSession.js`, and `mutualAuth.js`.
Test files that construct these messages by hand (`authGate.test.js`, `transport.test.js`, plus
the join-flow and mutual-auth test suites) are also affected — they currently build the seven
message literals inline and will need to build them through whatever the schema module exports.

**The seven message shapes on the wire today** (enumerated by reading `authGate.js` and
`joinSession.js`/`mutualAuth.js` in full, not from memory):
`authenticate` → `auth_ok` | `auth_failed{reason}`; `pairing_request` →
`pairing_approved{device_secret_identifier, join_confirm?}` | `pairing_pending{join_confirm?}` |
`pairing_denied`; `login` → `login_ok{token, userId, role, camp?, host_device_id?}` |
`login_failed{locked?, retryAfterMs?}`. `pairing_approved`/`pairing_denied` are also sent
*unsolicited* later, via `deliverPairingDecision`'s own outbound dial (`authGate.js:330`), not just
as an immediate reply — the schema must accommodate both.

## Sequencing with T165 — do not freeze the payload shape yet

`docs/work/tickets/T165-credential-signature-replay-and-degrade-permanence.md` is in flight and its
Finding 1 fix direction is "bind a monotonic per-user credential version into the signed payload" —
that changes what `authSignature.js` signs, not the `AUTH_PROTO` handshake messages themselves
(T165 touches the *document's* credential fields, projected via `projector.js`, not the
`login`/`authenticate` wire frames). Reading T165 confirms the two are architecturally separate:
T165 is about credential-tuple freshness inside the replicated document; this ADR is about the
*framing and validation* of the handshake messages that arrive over `AUTH_PROTO` before any
document exists. **They do not share a payload.** The one place they could collide is `login_ok`'s
`token`/`role` fields, if T165's fix ever needed to add a field to the login response — it does not,
per the ticket's stated fix direction (a `cred_version` column and at-rest re-verification sweep,
both server-side/document-side). Sequencing recommendation: **this ADR's ticket may proceed in
parallel with T165**, but the Maker implementing it must re-read T165's final state before locking
the `login_ok` schema, since T165 is the one open ticket most likely to want a new field there. If
T165 lands first, incorporate its fields as part of this work rather than as a second schema
revision.

## Non-goals

- **Not a transport change.** libp2p, Noise, yamux, mDNS, and the `PROTO`/`SYNC_PROTO` protocol
  ids are untouched.
- **Not a sync-payload change.** Automerge owns the `PROTO`/`SYNC_PROTO` wire format; this ADR
  does not touch `A.generateSyncMessage`/`A.receiveSyncMessage` or whole-document bytes.
- **Not an internet-reachability change.** Nothing here adds a relay, DHT, non-loopback listen
  address, or any of the mechanisms `docs/adr/2026-09-14-internet-transport-security-gate.md`
  gates. See "Options rejected" for the one candidate that would have tripped that gate.

## Candidate approaches considered

1. **Protocol Buffers (protobuf) with codegen.** Strongest wire compactness and cross-language
   portability. Rejected: this is a single-language (Node/Electron) codebase with no
   cross-language consumer of `AUTH_PROTO` on the roadmap, and protobuf requires a `.proto` file,
   a codegen step wired into the build (`npm run build`/`electron:build`), and generated code
   Vitest has to resolve — real new build-graph surface for seven flat, tiny JSON objects that
   already fit in one frame. `depends_on_external` would gain a native or near-native toolchain
   dependency (`protobufjs` avoids the native-binary problem but still adds codegen ceremony this
   project's build has never had). Assumption: no other consumer needs the compactness or
   cross-language guarantees protobuf buys — true today, and nothing in the roadmap docs
   (`PLATFORM_STATE.md`, the future-architecture notes) contradicts it.
2. **CBOR/msgpack with an attached schema.** Binary framing, smaller frames than JSON. Rejected:
   the handshake messages are tens to a few hundred bytes (a token, a device id, a reason string) —
   binary encoding buys nothing measurable here, while JSON stays human-readable in the
   `authGate.test.js`/`transport.test.js` fixtures and in ad-hoc debugging (`console.error` lines
   throughout `authGate.js` already assume string-shaped payloads). This does not touch the
   *versioning* problem either — CBOR is an encoding, not a schema, so it would still need the
   same declared-shape-plus-version-rule work this ADR does, for no compatibility benefit.
3. **JSON Schema + a validation library (e.g. ajv).** Declarative, and ajv is a real,
   well-maintained pure-JS dependency with no native binary. Considered viable. Rejected in favor
   of option 4 only on proportionality grounds: ajv's JSON-Schema-Draft dialect, `$ref`, and
   compiled-validator-function machinery is built for schemas an order of magnitude larger and
   more nested than seven flat message shapes with 1-6 fields each. Would be the right call if
   this surface grows nested/recursive messages later — it does not today.
4. **Hand-rolled validated codec: one small local module, `handshakeSchema.js`, declaring each of
   the seven message shapes as a flat field list (`{name, type, required}`) and one shared
   `validate(message, shapeName)` function.** No new npm dependency, no native module (this
   project already carries real native-module pain from `better-sqlite3` — see the Commands
   section of `CLAUDE.md` on the `electron-rebuild`/`npm rebuild` dance — a second native
   dependency for a codec is a cost this project specifically has reason to avoid), no codegen
   step, and every message is still plain JSON so `sendFramed`/`receiveFramed`
   (`wireProtocol.js`) and `JSON.parse`/`JSON.stringify` are untouched — only what sits *between*
   the object literal and the wire changes. Runs under Vitest with zero ceremony: it's a function
   call. **This is the recommended option** (see Approach).

**Recommendation: option 4, confidence high.** Evidence: `package.json` has no existing JSON-schema
or validation dependency (`grep` for `zod`/`ajv`/`joi`/`yup` returns nothing) so any of options
1-3 is a net-new dependency choice, and the actual schema surface (seven flat message shapes, no
nesting, no arrays-of-objects, no cross-message references) is small enough that a ~40-60 line
hand-rolled validator is smaller and more auditable than pulling in a general-purpose validation
library for it. If the handshake message surface grows materially (nested payloads, nested
optional groups, nested arrays) reopen this decision in favor of ajv — do not organically grow the
hand-rolled validator into an ad-hoc schema language instead.

## Approach

### 1. New module: `electron/sync/automerge/handshakeSchema.js`

Declares each of the seven message shapes as a flat schema object and exports one `validate`
function plus one `encode`/`decode` pair that both `authGate.js` and `transport.js` call instead
of hand-writing `JSON.stringify`/`JSON.parse`. Sketch (illustrative, not final field lists — the
Maker brief should carry the exact current field lists read out of `authGate.js` verbatim, since
this ADR's job is the mechanism, not re-transcribing every field name):

```js
// electron/sync/automerge/handshakeSchema.js
export const HANDSHAKE_SCHEMA_VERSION = 1

const FIELD_TYPES = { string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', number: (v) => typeof v === 'number' }

const SHAPES = {
  authenticate: { v: 'number', type: 'string', token: 'string', device_id: 'string' },
  auth_ok:      { v: 'number', type: 'string' },
  auth_failed:  { v: 'number', type: 'string', reason: 'string' },
  // ...pairing_request / pairing_approved / pairing_pending / pairing_denied / login / login_ok / login_failed,
  // one entry per shape enumerated in the Context section above, fields copied verbatim from the
  // current object literals in authGate.js/joinSession.js/mutualAuth.js.
}

export function validate(shapeName, msg) {
  const shape = SHAPES[shapeName]
  if (!shape) return { ok: false, reason: 'unknown_message_type' }
  for (const [field, type] of Object.entries(shape)) {
    const optional = field.endsWith('?')
    const name = optional ? field.slice(0, -1) : field
    if (msg[name] === undefined) {
      if (!optional) return { ok: false, reason: 'missing_field', field: name }
      continue
    }
    const isValid = FIELD_TYPES[type]
    if (!isValid(msg[name])) return { ok: false, reason: 'wrong_type', field: name }
  }
  // Unknown extra fields are NOT rejected — see "Version compatibility rule" below.
  return { ok: true }
}
```

`encode(shapeName, fields)` stamps `v: HANDSHAKE_SCHEMA_VERSION` and `type: shapeName` onto the
object before `JSON.stringify`, so callers never hand-write the discriminant or the version field
— the two places version-skew bugs would otherwise hide.

### 2. Version-compatibility rule (the load-bearing part)

Every message gains one new required field, `v` (an integer, starting at `1`), stamped by
`encode()`. The rule set, in the order a receiver applies it:

1. **Malformed frame** (not valid JSON at all) — unchanged from today: `authGate.js` already
   aborts the stream with `malformed_auth_frame` before any schema check runs. No change here.
2. **Unknown `type`** — a message whose `type` string is not one of the seven declared shapes.
   Today this hits the generic `unsupported_auth_message` abort at the bottom of the handler
   (`authGate.js`'s final `stream.abort`). **Keep that behavior**, but only reach it after the
   version check below has had a chance to explain *why* the type is unrecognized — an unknown
   type from a *lower* declared version is a version-mismatch story, not a "this peer sent
   garbage" story, and the two must not collapse into the same generic abort.
3. **Missing/wrong-typed *required* field** — a message with a known `type` but a required field
   absent or the wrong type. New `validate()` rejects with `{ok:false, reason:'missing_field'|
   'wrong_type', field}`. Callers that currently `stream.abort(new Error('unsupported_auth_message'))`
   on any shape problem now abort with this more specific reason string — an operational
   improvement (the existing `console.error` lines in `authGate.js` become actionable) but not a
   new user-visible behavior by itself.
4. **Unknown *extra* fields** — never rejected. `validate()` only walks the declared shape's own
   keys; a field present in the message but absent from the shape is silently ignored. This is
   the forward-compatibility rule: a newer sender can add an optional field to, say, `login_ok`
   (e.g. T165 adding something to the login response) and an older receiver running the *current*
   validator keeps working, ignoring the field it doesn't know about — no schema bump required for
   additive fields.
5. **Version mismatch** — the field that does not exist today and is the actual point of this
   ADR. Define `MIN_SUPPORTED_HANDSHAKE_VERSION = 1` (a constant in `handshakeSchema.js`,
   bumped only when a *breaking* change to a shape ships — removing a required field, changing a
   field's type, or removing a message type entirely). On receipt, before running `validate()`:
   if `msg.v` is missing or `msg.v < MIN_SUPPORTED_HANDSHAKE_VERSION`, reply with a **new,
   distinct reason code** — `unsupported_protocol_version` — on whichever failure frame that
   message type would otherwise use (`auth_failed`, `pairing_denied`, or `login_failed`), then
   abort the stream. This reuses the existing reason-code convention verified in
   `connectionAuth.js` (`invalid_token`, `not_paired`, `bad_secret`, `invalid_credentials`,
   `locked`, `invalid_request` are already distinct, renderer-mapped reason strings) rather than
   inventing a new error channel.

**What the camp director sees.** `src/hooks/useDeviceMode.js` already maps `reason` strings from
these handshake failure frames into phase transitions and (per the existing pattern for
`locked`/`invalid_credentials`) can map user-facing copy per reason. Today an
incompatible-version peer would either hang (protocol string mismatch causes `dialProtocol` to
reject before any frame is ever sent — a real but different failure the current code already
handles as a connection-level error) or, once both sides speak the *same* protocol id but a
different message-field set, silently misparse or `undefined`-reference somewhere downstream —
exactly the failure mode this ADR exists to close. After this change: a v1 laptop pairing with a
v2 laptop that has bumped `MIN_SUPPORTED_HANDSHAKE_VERSION` sees a specific, legible state —
propose the copy "This device's Shoresh needs an update to pair with [other device]" gated behind
the new `unsupported_protocol_version` reason, wired the same way `locked`'s copy is today. Wiring
that renderer copy is implementation, left to the Maker brief, not decided further here.

**Additive (non-breaking) evolution needs no version bump.** Adding an optional field to a shape,
or adding an entirely new message `type`, is additive — old receivers ignore fields they don't
declare (rule 4) and never see a `type` they don't expect unless the new type is sent *to* them,
which only a new sender does deliberately. Only removing/retyping a required field, or removing a
message type outright, requires bumping `MIN_SUPPORTED_HANDSHAKE_VERSION`.

### 3. Idempotency / retry / concurrency (org-interface-contracts checklist)

- **Idempotency.** Handshake messages are not mutations against the op-log or the replicated
  document — they are transport-local admission decisions. `authenticate`/`login` retries are
  already idempotent in effect (a repeated valid `login` just re-derives the same token check);
  this ADR does not change that, and the schema module adds no new idempotency surface.
- **Concurrent retries.** Unaffected — `authGate.js`'s existing per-peer/per-device rate limiting
  (`shouldThrottle`) is untouched by this ADR; the schema module sits strictly between "bytes
  arrived" and "call the existing `onAuthenticate`/`onPairingRequest`/`onLogin` callback," and
  throttling still happens before any callback runs.
- **Unknown outcomes.** A stream that closes mid-handshake is already handled (the `.catch(() =>
  {})` guards in both `authGate.js` and `transport.js`) — this ADR does not change what happens on
  a dropped connection, only what happens when bytes *do* arrive but are malformed or
  version-incompatible.
- **Error shape.** Strengthened, not weakened: today a shape problem produces the single generic
  `unsupported_auth_message` reason; after this change, `missing_field`/`wrong_type`/
  `unsupported_protocol_version` are distinguishable, matching the existing reason-code
  convention in `connectionAuth.js`.
- **Scope/authority boundary.** No change to `authorize()`, camp isolation, or the admission gate
  itself (`authenticatedPeers`) — this ADR validates *shape*, not *authority*. A message that
  passes `validate()` still goes through exactly the same `onAuthenticate`/`onPairingRequest`/
  `onLogin` decision functions as today.
- **Trust boundary.** `AUTH_PROTO` frames are the definition of "data crossing a trust boundary"
  (an unauthenticated peer's bytes) — that is precisely why this ADR exists; `validate()` is the
  new boundary check, applied before any field is trusted enough to reach `connectionAuth.js`.

## Files/modules affected

- **New:** `electron/sync/automerge/handshakeSchema.js` (+ `handshakeSchema.test.js`).
- **Changed:** `electron/sync/automerge/authGate.js` (`decodeMessage`/`encodeMessage` replaced by
  calls into the schema module; the version/shape checks added to the `AUTH_PROTO` handler before
  each `msg.type === '...'` branch); `electron/sync/automerge/transport.js`
  (`authenticateWith`'s inline `JSON.stringify`/`JSON.parse`, `transport.js:251` area, routed
  through `encode`/`decode`); `electron/sync/automerge/joinSession.js` and `mutualAuth.js` (message
  construction routed through `encode()` instead of inline object literals).
- **Changed (tests):** `authGate.test.js`, `transport.test.js`, and any join-flow/mutual-auth test
  suites that currently build these seven message shapes as inline literals — verified as affected
  by the `graphify affected "sendFramed"` result plus the `grep -rn AUTH_PROTO` pass.
- **Not affected:** `wireProtocol.js` (framing stays byte-agnostic), `syncNode.js`, `PROTO`/
  `SYNC_PROTO` handling, anything under `src/` other than the `reason`-string mapping in
  `useDeviceMode.js` for the new `unsupported_protocol_version` reason (a small follow-on, not
  part of this ADR's core surface).

## Reused vs. new

**Reused:** the existing `sendFramed`/`receiveFramed` byte framing (`wireProtocol.js`, untouched),
the existing reason-code convention already established in `connectionAuth.js`
(`invalid_token`/`not_paired`/`bad_secret`/`invalid_credentials`/`locked`/`invalid_request`), the
existing per-peer/per-device rate limiting in `authGate.js`, and the existing
`auth_failed`/`pairing_denied`/`login_failed` frame shapes as the delivery vehicle for the new
`unsupported_protocol_version` reason — no new failure-frame type is introduced.

**New:** the `handshakeSchema.js` module itself (shape declarations, `validate`, `encode`/
`decode`), the `v` field on every handshake message, `MIN_SUPPORTED_HANDSHAKE_VERSION`, and the
`unsupported_protocol_version` reason string. Nothing else — no new dependency, no new protocol
id, no new transport concept.

## ADR required: yes

This ADR **is** the required record. It changes an existing contract other modules already call
(every `AUTH_PROTO` message producer/consumer enumerated above moves from ad-hoc object literals
to a declared, versioned schema) and introduces a durable compatibility rule
(`MIN_SUPPORTED_HANDSHAKE_VERSION`) that future changes to the handshake must respect — exactly the
"changes an existing contract" and "tradeoff that isn't obviously reversible" bar from the
constitution. Filed at `docs/adr/2026-09-15-declared-handshake-message-schema.md`, status
`proposed`: the owner approved the direction, not this specific mechanism (hand-rolled codec vs.
ajv) or this specific version rule, so it is not `accepted` until reviewed.

## Ticket sequence proposed

One ADR, sliced into two ticket-sized units — small enough each to be independently tested and
reviewed, sequenced so the second can be skipped if T165 changes the calculus:

1. **Ticket A — schema module + wiring, additive only.** Write `handshakeSchema.js` with the seven
   current shapes at `v:1`, wire `authGate.js`/`transport.js`/`joinSession.js`/`mutualAuth.js`
   through `encode`/`decode`, keep behavior byte-for-byte identical on the happy path (existing
   tests must pass unmodified in assertion content, only in how messages are constructed). This
   ticket alone already buys the "declared schema, not hand-written JSON" goal and the
   unknown-extra-field forward-compatibility rule (rule 4). No version-mismatch UX yet.
2. **Ticket B — version-mismatch reason code + renderer copy.** Add `MIN_SUPPORTED_HANDSHAKE_VERSION`,
   the `unsupported_protocol_version` reason on the three failure frame types, and the
   `useDeviceMode.js`/renderer mapping so a camp director sees the specific message instead of a
   generic pairing/login failure. Depends on Ticket A. Should re-check T165's final `login_ok`
   shape before merging, per "Sequencing with T165" above.

Both tickets are LAN-only, additive to the existing `AUTH_PROTO` protocol id — neither trips the
Tier-4 internet-transport gate, and neither should be scoped to try.

## Open questions for Governor

1. **Exact field lists per shape** — this ADR intentionally left the `SHAPES` table's field-by-field
   contents as "copy verbatim from the current code" rather than re-transcribing all seven here, to
   avoid the design doc silently drifting from the code it describes between now and Maker's
   read of it. Governor/Maker should re-derive the field list from `authGate.js`/`joinSession.js`/
   `mutualAuth.js` at implementation time, not from this document, in case those files change
   before Ticket A lands.
2. **Renderer copy for `unsupported_protocol_version`** (Ticket B) is a product-copy decision, not
   a technical one — propose it to the owner rather than Maker inventing wording.
3. **Whether Ticket B ships before or after T165 closes** is a scheduling call, not an
   architectural one; this ADR only states the technical reason they're independent (see
   "Sequencing with T165").
