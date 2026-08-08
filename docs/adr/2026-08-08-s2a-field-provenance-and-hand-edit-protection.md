---
title: "Field provenance: the import-vs-human bit (S2a)"
document_type: adr
authority: normative
status: proposed
date: 2026-08-08
supersedes: []
implementation_state: not_started
affects:
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s1b-source-aliases.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - electron/ops/operations.js
  - electron/ops/ingest.js
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/sync/syncClient.js
  - electron/sync/syncServer.js
---

# Field provenance: the import-vs-human bit (S2a)

**Status: PROPOSED.** This is the first of two ADRs the S2 slice (FIELD-LEVEL UPDATE with hand-edit
protection) is split into. S2 is the program's payoff — re-importing a corrected source *updates*
rather than duplicates or wipes — and its most dangerous slice: a stale source silently reverting a
director's hand-edit is the trust-killer the whole program exists to prevent.

- **S2a (this ADR) — the protection SIGNAL.** Persist, per field, whether the field's current value
  was written by an *import* or by a *human*. This is the one fact the op-log does not already carry,
  and it is the fact hand-edit protection needs. It is a schema + sync-replication change with its own
  migration/rollback gate, and it makes **no behavior change to the importer** — S2a only starts
  recording the bit; S2b consumes it.
- **S2b (`2026-08-08-s2b-field-level-update-and-stale-conflict.md`) — the merge LOGIC.** Turns a
  recognized entity whose fields differ into `op:"update"` (S1a made it `unchanged`), and turns a
  change that S2a's signal says would clobber a hand-edit into a gated `op:"conflict", reason:"stale"`.
  Pure logic on top of S2a; no schema change.

S2a sits on the landed S0 (`ReconciliationPlan` as commit input) and S1a (recognition + commit-time
re-resolution + hold-the-whole atomicity) ADRs. **Governor sequencing decision (2026-08-08): S1b is not
built, so S2a takes schema version 29, gated `>= 28`** (see §5). Should S1b later land ahead of S2a, its
migration renumbers around whichever version S2a has already claimed.

---

## Context

### The base-generation asymmetry (why the clock is not enough)

Foundation D (`MATCH_AND_MERGE_SEMANTICS.md`; synthesis §3D) protects against stale *overwrites* with a
happens-before clock: a supplied value whose *base generation* is older than the field's
last-authoritative write is a `conflict`, not a silent update. The clock lives in the Plan type today —
`FieldConflict.clock = { field_last_seq, source_base_seq }` (`RECONCILIATION_PLAN_TYPE.md` §1).

**The clock only works when the incoming source carries a `base_generation`.** That stamp exists **only
on Shoresh-exported sources** — the S4 enrichment workbook, which Shoresh itself generated from a known
op-log generation. **S2's actual input is a raw schedule** (an xlsx/CSV/PDF the camp authored). A raw
source has **no** base generation: `buildPlan` hardcodes `base_generation: 0`
(`src/ingest/buildPlan.js` ~186), and every `SourceRef` for the `schedule` family carries none. With
`source_base_seq = 0`, the clock says *every* field with any prior write is "older than me" — it cannot
distinguish "this field was import-written last year, re-importing is fine" from "a human hand-edited
this field after the last import, protect it." **The clock is structurally inert for the raw-schedule
re-import S2 must handle.**

### What the op-log already tells you per field, and the one thing it cannot

`appendOp` (`electron/ops/operations.js` ~77) persists, for every field write:
`author_user_id`, `device_id`, `timestamp`, and a monotonic `seq`. `latestOp(db, entity, entity_id,
field)` (~421) returns the field's most recent op. So for any field the op-log already answers **who**
last wrote it, **from which device**, **when**, and **in what order**.

It **cannot** answer the one question hand-edit protection turns on: **was that last write a hand-edit
(via `ActivitiesScreen` → `localClient.write` → `appendOp`) or an import write (via
`commitPlan` → `appendOp`)?** Both go through the *same* `appendOp`, both stamp the *same* director as
`author_user_id` on the *same* `device_id`. There is no marker anywhere in the op that separates them.
`ActivitiesScreen.writeFields` (`src/screens/ActivitiesScreen.jsx` ~336) and `commitCreate`
(`electron/ops/ingest.js` ~395) emit byte-indistinguishable field ops.

**Conclusion: foundation C is REQUIRED for S2, and the clock alone cannot substitute for it.** For a
raw-schedule re-import, the *only* way to protect a hand-edit from a stale overwrite is to know which
fields a human authored — a fact that does not exist in the system today and must be recorded.

### This does not contradict the synthesis; it completes it

Synthesis §3C reasoned that provenance is **per-row** (`confirmed`/`source` columns) and explicitly *not*
a per-field table, "because the op-log already persists field-level author/device/timestamp." That
reasoning is right about everything except the import-vs-human bit, which is exactly the field-level fact
the op-log is *missing*. S2a completes §3C's own logic — field-level provenance lives in the op-log — by
adding the **single missing column** there, rather than a parallel per-field confidence table (which
§3C correctly rejects). The per-row `confirmed`/`source` display columns of §3C are a *separate* concern
(the three-look visual grammar) and remain deferred to S5; see §6.

Per `docs/governance/constitution/CONSTITUTION.md` this clears the ADR bar twice: it introduces a new
persistent, **replicated** data shape (a column on the `operations` op-log other devices must agree on)
and makes a not-obviously-reversible consistency tradeoff (a provenance bit that must replicate
deterministically or commits diverge across devices).

### Candidate approaches considered

The open technical question is **where the per-field import-vs-human bit lives**. Three genuinely
different homes:

- **A. Per-ROW `confirmed`/`source` columns on each entity table (the synthesis's literal foundation
  C).** *Rejected as the protection store.* Per-row is too coarse for the payoff: a director who
  hand-edits *one* field of an activity would flip the whole row to "human", so re-import could no longer
  quietly update the fields the human never touched — it re-freezes the entire row and defeats the
  "re-import updates" goal for every untouched field. Per-row can express only the noisy Policy B (§S2b),
  never the precise Policy A. It stays useful for **display** (S5), not protection.
- **B. A per-FIELD provenance table keyed `(entity, entity_id, field)`.** *Rejected.* This is the
  per-field confidence table synthesis §3C already rejected. It doubles writes (every field op needs a
  companion provenance write), invents a second thing to keep in sync with the op-log, and re-derives
  information (author/device/timestamp/seq) the op-log already holds — to add one bit.
- **C. One `source` column on the `operations` op-log (chosen).** The op-log is *already* the
  field-level provenance store §3C names; it is already written exactly once per field, already
  replicated, already the thing `latestOp` reads. Adding one nullable `source` marker to it makes the
  import-vs-human bit a **derived, per-field** property (`latestOp(field).source`) with **no new table
  and no second write**. **Selected** — smallest home that yields the per-field precision Policy A needs,
  and the only one that reuses the machinery §3C points at instead of duplicating it.

---

## Decision

### 1. Add a nullable `source` marker to each op

Add `source TEXT` (nullable) to the `operations` table. It records the **provenance of the write**, an
enum, not a score:

- `'import'` — the op was written by the reconciliation committer (`commitPlan`) from an imported
  source.
- `'human'` — the op was written by a person through the app's normal edit path.
- `NULL` — **treated as `'human'`** (see §3). Every pre-S2a op, and every op the app writes that is not
  explicitly tagged, is human-authoritative by default. This is the safe default: absence of evidence
  resolves to "a person may have set this — protect it," never to "safe to overwrite."

`source` is metadata *about the write*, parallel to `author_user_id`/`device_id`. It is **not** a
projected entity field — it never appears in `PROJECTIONS` and never reaches an entity table — so
`appendOp`'s field-allow check and every projection are untouched.

**THE PRODUCIBILITY INVARIANT (load-bearing for security — see §2, Security V1).** `source:'import'`
is producible by **EXACTLY ONE path: host-local `commitPlan` writing the local DB.** **NO message
handler may emit it.** `source` is a *server-derived* attribute, not a client-asserted one:

- The op-replication wire carries `source` (a `'human'` op replicates as `'human'`, an `'import'` op
  replicates as `'import'` — §4), but the host **never trusts `msg.op.source` as the authority for a
  NEW write.** When a peer submits a field op, the host is the *originator of record* for that op's
  provenance: `handleSubmitOp` (`syncServer.js` ~555) MUST force `source:'human'` (or strip it →
  `NULL`, which §3 decodes as human) rather than copy `msg.op.source`. A submitted op can *never* be
  the way `'import'` enters the log.
- This is the crucial contrast with `author_user_id`, which **is** itself client-asserted on the
  submit path (`handleSubmitOp` spreads `{...msg.op, device_id: ws.deviceId}` and trusts the client's
  `author_user_id`). §2/§4 must therefore **NOT** tell the Maker to "thread `source` like
  `author_user_id`" — that guidance would replicate a trust boundary that is already loose for
  `author_user_id` onto the one bit whose whole job is to gate overwrites. See §2.

### 2. `appendOp` carries `source`; provenance is SERVER-DERIVED, and the writer census is complete

`appendOp` (`operations.js` ~77) gains a `source` parameter (default `null`) and binds it into the
`operations` INSERT alongside `author_user_id`/`device_id`. **The guidance is NOT "thread `source`
through the op object like `author_user_id`."** `author_user_id` is client-asserted on the submit path
(Security V1); replicating that pattern onto `source` is exactly the vulnerability. Instead: each
**writer** sets `source` structurally from *where the code is*, and the host **derives** `source` for
any op that arrives over the wire rather than copying the client's claim. The wire still carries
`source` for **already-committed** ops (§4) — replication of a stored fact — but a NEW submitted write
is stamped by the host, never by the submitter.

**Every field-op writer and the `source` it sets (the complete census — R2/R3):**

| Writer | Path | `source` |
|---|---|---|
| `commitCreate` field-delta loop (`ingest.js` ~395) | host-local `commitPlan` | `'import'` |
| `replaceScope` weather-null write (`ingest.js` ~113–123) | host-local `commitPlan` | `'import'` |
| fixed-events `anchor_activities` writes (`ingest.js` ~541) | host-local `commitPlan` | `'import'` |
| `replaceScope` `__deleted__` teardown ops | host-local `commitPlan` | `NULL` (not a field-value write) |
| S2b `update` arm (`ingest.js` ~434, added in S2b) | host-local `commitPlan` | `'import'` |
| interactive edit → `performWrite` (`syncClient.js` ~792) | host-local edit seam | `'human'` (hard-set) |
| local `write()` shim (`syncClient.js` ~149) | host-local edit seam | `'human'` (hard-set) |
| `handleSubmitOp` (`syncServer.js` ~555) | **peer submit over wire** | **force `'human'` / strip → `NULL`; MUST NOT copy `msg.op.source`** |
| `applyRemoteOp` INSERT (`syncClient.js` ~400) | replicating an **already-committed** op | preserve the op's stored `source` (§4) |
| `restoreEntity` (`restore.js` ~143–166) | trash→restore re-emit | see below (R2) |
| `resolveConflict` (`main.js` ~661) | conflict-resolution write | see S2b R1 — a `stale`-accept must stamp `'import'`; other resolutions are `'human'` |

Two consequences of the census:

- **The `'import'` label is emitted at a `commitPlan`-WIDE seam, not only inside `commitCreate`'s delta
  loop (R3).** `replaceScope`'s weather-null write and the fixed-events anchor writes are import-authored
  but live *outside* that loop; a literal "tag in `commitCreate`" would leave them `NULL` and mislabel
  import writes as human. The Maker threads `source:'import'` into **every** `appendOp` the committer
  makes (the teardown `__deleted__` ops are the one deliberate exception — they carry no field value, so
  they stay `NULL`). Practically: give the committer a single `source` argument it passes to all its
  `appendOp` calls, rather than tagging one call site.
- **`restoreEntity` must be in the census, or it launders import→human (R2).** `restore.js` re-emits
  every field of a restored entity through plain `appendOp` with no `source`. Left untagged, a
  trash→restore cycle rewrites an import-owned field as `NULL` = human = permanently protected —
  silently converting Policy A into Policy B for any restored entity. **Decision: `restoreEntity`
  preserves the ORIGINAL provenance of the op it is restoring when that op is recoverable** (restore
  already reads the entity's op history to rebuild it — carry each field's last-op `source` forward). If
  the original `source` is not recoverable for a given field, it defaults to `NULL` (human) —
  documented, deliberate **over-protection** (the safe direction: a false "protect" costs a review
  click, never a lost hand-edit). The Maker MUST confirm whether restore has the source of each
  re-emitted field in hand; if not, the documented `NULL` fallback stands.

**The two host-local edit seams hard-set `'human'`.** Every UI field edit flows `localClient.write` →
preload `shoresh:write` → the main-process write handler → `syncClient.performWrite` (~792) / the local
`write()` shim (~149). Both **hard-set `source:'human'`** — one seam, covering `ActivitiesScreen`,
`GroupsScreen`, `TiersScreen`, `TimeBlocksScreen`, `DaysScreen`, and every future entity screen. No
per-screen `writeFields` change. Because §3 defines `NULL = human`, this explicit tag is a
belt-and-suspenders over the default — Red Hat's "a hand-edit must be human-authoritative" holds even
for an untagged `NULL` write — but hard-setting it makes the intent legible and keeps `restoreEntity`'s
provenance-preservation meaningful.

**`handleSubmitOp` forces `'human'` (Security V1 — CRITICAL).** The host is the originator of record for
a peer's submitted field write. `handleSubmitOp` currently does `{...msg.op, device_id: ws.deviceId}`,
which — once `source` is a bound column — would flow `msg.op.source` straight into the INSERT and
broadcast it as canonical. A STAFF client submitting `source:'import'` on a victim's hand-edited field
would flip that field to import-owned and let the next import silently overwrite it (S2b gate bypass).
The fix: `handleSubmitOp` **forces `source:'human'`** (or strips `source` from the spread so it lands
`NULL`, which §3 decodes as human) — it NEVER copies `msg.op.source`. This preserves the invariant that
`'import'` enters the log only via host-local `commitPlan`.

### 3. `NULL` means human-authoritative (graceful degradation for all history)

Defining `NULL = 'human'` gives S2 a safe migration story with no data backfill:

- Every op written before S2a (all history, including the fields S0/S1a imports wrote) is `NULL` →
  human-authoritative → **protected** on the first S2 re-import. For a pre-S2 camp this means the first
  re-import is conservative (it may surface conflicts on fields an import originally set), which is the
  *safe* direction — a false "protect" costs a review; a false "overwrite" costs a lost hand-edit.
- **How provenance is acquired is a designed resolution path, NOT automatic decay (R1).** A pre-S2a
  field is `NULL` and stays `NULL` — a plain re-import cannot rewrite it, because the protection gate
  *holds* the write (S2b hold-the-whole). The field acquires `source:'import'` **only** when the director
  resolves the resulting `stale` conflict by **accepting the import value**, and that acceptance is a
  resolution path that stamps `source:'import'` on the write (S2b §"Escaping the NULL trap"). So a
  pre-S2a camp's FIRST corrected re-import surfaces its changed fields for a one-time review; once
  resolved, those fields are import-owned and later re-imports update them quietly. A **new** (post-S2a)
  camp never hits this — its imports write `source:'import'` from day one. There is **no blanket
  backfill** (which would strip protection from genuine pre-S2a hand-edits — the dangerous direction).

This is why no historical backfill is needed and why the migration is purely additive.

### 4. `source` MUST replicate to keep op-logs EQUAL (the load-bearing sync obligation)

**Re-framed (R4): the divergent-commit story is unreachable, so it is not why `source` replicates.**
Import is **host-only** — exactly one device runs `commitPlan` and the S2b protection gate, so two
devices never independently evaluate the same re-import and cannot reach conflicting `update`/`conflict`
verdicts. The earlier "nondeterministic commit across devices" framing overstated the risk. `source`
must nonetheless replicate, for reasons that ARE real:

- **Op-log equality / the golden-ops invariant.** The S0 GOLDEN-OPS anchor and this codebase's
  two-device characterization require every peer's `operations` table to converge to the **same** rows.
  A `source` column that replicated on some paths and not others would make peers' op-logs unequal on a
  bound column — a golden-invariant break independent of any commit-verdict divergence.
- **Future host reassignment (S5+).** If the host role ever moves to another device, that device must
  already hold correct per-field provenance to run the gate. A client whose replicated ops lack `source`
  would mis-gate the first import after reassignment.
- **S5 client display.** The three-look display grammar (S5) reads provenance on every device, not just
  the host.

So `source` is a **mandatory replicated column**, threaded wherever an **already-committed** op crosses
the wire or is re-inserted — as a *stored fact being copied*, distinct from the host-derived stamping of
a NEW write (§2, Security V1):

- **Confirmed correct in review — keep:** the `operations` INSERT in `appendOp` (`operations.js` ~90);
  the second INSERT in `syncClient.applyRemoteOp` (`syncClient.js` ~400–404), whose explicit column list
  must include `source` and **preserve** the replicated op's stored value; `performWrite`
  (`syncClient.js` ~792) which hard-sets `'human'` per §2; `handleSubmitOp`'s spread carries the key but
  §2 **forces** it to `'human'`, never trusting `msg.op.source`; and `sendMissedOps`'s `SELECT *`
  already carries the column once it exists.
- **Op-validation guards do NOT enumerate a strict allow-list** — `isValidRemoteOp` (`syncClient.js`
  ~373) and `validateSubmitOpMsg` (`syncServer.js` ~482) are presence-checkers, so a `source`-bearing op
  is accepted and stored, not rejected as malformed (see §5, R5).

**Two persistence paths the earlier draft missed (R4):**

- **`pending_writes` — the durable offline queue (`pendingWrites.js`).** It persists queued writes with
  a **fixed column list that has no `source`**. A human edit queued offline and reloaded after an app
  restart would lose its `'human'` tag → `NULL`. This is *safe by value* (human→NULL still decodes to
  human, §3) but it is a real census gap. **Decision: add `source` to `pending_writes`** so a reloaded
  queued write keeps its provenance; if the Maker finds the column addition disproportionate for the
  human→NULL-is-safe case, the documented degradation (queued writes reload as `NULL`/human) is an
  acceptable fallback — but it MUST be recorded, not left implicit.
- **`full_sync` omits the `operations` table (`syncServer.js` ~176–189).** A first-paired client
  receives entity state but **zero pre-pairing ops** — its op-log starts empty of history. This is benign
  while the gate is host-only (the client never runs the gate), but it is a **known limitation** for S5
  and any future host reassignment: a reassigned host would lack pre-pairing provenance. Recorded here as
  a known limit, not fixed in S2a.

This is the **same op-replication surface** the program's sync obligations already flag. The wire changes
land with S2a's migration-version gate (§5).

### 5. Migration/rollback (v29, gated `>= 28`) + two migration-skew GUARDRAILS

Follow the established two-places pattern (schema.sql + a `localDb.js` version block +
fresh-vs-migrated equivalence):

- **`schema.sql`** — add `source TEXT` to the `operations` `CREATE TABLE` (so fresh installs have it).
- **`localDb.js`** — a new migration block, gated `getSchemaVersion(db) >= 28 && < 29`, running
  `ALTER TABLE operations ADD COLUMN source TEXT` guarded by a `PRAGMA table_info(operations)` presence
  check (the exact idiom of the v15/v17 `if (!has) ALTER` blocks), then stamping version 29.
  `CURRENT_SCHEMA_VERSION` → **29**.
- **Version decision (Governor, 2026-08-08).** Today `CURRENT_SCHEMA_VERSION = 28`. **S1b is not built,
  so S2a takes v29 and gates on `>= 28`** — the next free version, matching how v27 gates on `>= 26` and
  v28 on `>= 27`. (If S1b is later built and needs its own migration, it renumbers around v29.)
- **Migration-skew (the pre-v29 peer bug class).** A pre-v29 peer receiving a `source`-bearing op must
  not choke. Because `source` is *additive and nullable* and lives on `operations` (which older peers
  already accept and store column-by-column), an older peer that ignores the column simply stores the op
  without provenance and treats it as `NULL`/human — safe. This safety rests on **two explicit
  guardrails, stated as NON-GOALS (R5):**
  1. **`source` stays NULLABLE — never `NOT NULL`.** A `NOT NULL` constraint would reject
     provenance-less ops from older peers and break the `NULL = human` decode. Nullability is a
     correctness requirement, not a convenience.
  2. **Do NOT add strict unknown-key op rejection.** `isValidRemoteOp` (`syncClient.js` ~373) and
     `validateSubmitOpMsg` (`syncServer.js` ~482) are presence-checkers today, and they MUST stay that
     way for this slice. If either were tightened into a strict allow-list that rejects an op carrying an
     unknown key, a `source`-bearing op would be dropped by a peer that predates the column — turning a
     benign forward-compatible column into a replication break. Hardening the validators is explicitly
     **out of scope** for S2a.
- **Rollback.** Reverting S2b (the consumer) returns behavior to S1a: nothing reads `source`, nothing is
  protected, imports recognize-but-don't-update as before. The `source` column may remain inert; it is
  nullable and additive, so there is nothing at the data layer to undo. Reverting S2a itself is a code
  revert plus leaving a harmless unused column (the standard "additive column, no down-migration"
  posture this codebase already takes).

### 6. Per-row `confirmed`/`source` DISPLAY columns are NOT in S2a

Synthesis §3C's per-row `confirmed`/`source` columns exist to drive the Designer's **three-look**
grammar (inferred / confirmed / unknown) on the setup screens and the readiness hub. That is a *display*
concern, and its natural home is **S5** (the readiness hub), not S2. S2a adds only the per-field
protection signal on the op-log. Keeping the two apart is deliberate: the synthesis conflated a per-row
*display* enum with a per-field *protection* bit, and they have different granularity requirements
(§Candidate A). S2a resolves the protection half where it actually belongs; S5 owns the display half.

---

## Consequences

- The op-log gains, per field, the one fact it lacked: import vs human. Hand-edit protection (S2b)
  becomes *possible* — before S2a there is no signal on which to base it, and any protection scheme would
  be guessing.
- The write surface acquires a provenance dimension parallel to `author_user_id`/`device_id`, but —
  unlike `author_user_id` — `source` is **server-derived on the submit path**, never client-asserted
  (Security V1). This is the main risk area and the reason §2's producibility invariant is load-bearing.
- No importer behavior changes at S2a. `commitPlan` starts tagging `source:'import'`, but S1a still
  emits only `create`/`unchanged`; the tag has no consumer until S2b. S2a is therefore independently
  shippable and independently revertible.
- All historical data is treated as human-authoritative, so the first re-import of a pre-S2 camp errs
  toward protecting (surfacing conflicts) rather than overwriting — the safe direction. Provenance is
  acquired only through the S2b conflict-resolution path, never by blanket backfill.

---

## Completion evidence

1. **`source` column exists in both places.** `schema.sql` `operations` and a `localDb.js` v29 migration
   both add `source TEXT`; a fresh-install DB and a DB migrated 28→29 have **identical**
   `PRAGMA table_info(operations)` (the fresh-vs-migrated equivalence check this repo already runs for
   other columns).
2. **`appendOp` round-trips `source`.** A test writes an op with `source:'import'` and one with
   `source:'human'` and reads each back from `operations`; an op written with no `source` stores `NULL`.
3. **The complete writer census tags correctly (R2/R3).** A test asserts **every** field op `commitPlan`
   writes carries `source:'import'` — including `replaceScope`'s weather-null write and the fixed-events
   anchor writes, not just `commitCreate`'s delta loop — while `__deleted__` teardown ops stay `NULL`; a
   field op through the app edit seam (`performWrite` / `write` shim) carries `source:'human'`; and a
   trash→restore cycle (`restoreEntity`) **preserves** an import-owned field's `'import'` provenance (or,
   where unrecoverable, the documented `NULL`/human over-protection) rather than laundering it to human.
4. **Security V1: a forged `submit_op` cannot inject `'import'` (CRITICAL).** A peer submits
   `submit_op{ op: { source: 'import', ... } }` on an existing field; after `handleSubmitOp` the stored
   op has `source` = `'human'` (or `NULL`), **never** `'import'`. The only path that ever stores
   `'import'` is host-local `commitPlan` — asserted by grepping that no message handler passes
   `source:'import'` and by the round-trip test above.
5. **`source` replicates deterministically.** A two-device sync test: an op written with `source:'import'`
   on the host is present with `source:'import'` on the client after `applyRemoteOp` (a stored fact
   copied, distinct from §2's host-derived stamping of NEW writes). A device that predates v29 stores the
   op and treats missing provenance as `NULL`/human without rejecting it (relies on the R5 guardrails:
   nullable column + presence-checker validators).
6. **`NULL = human` is honored by the reader** (asserted where S2b consumes it): `latestOp(field).source
   === null` classifies the field as human-authoritative.
7. **`pending_writes` provenance (R4).** A human edit queued in `pending_writes` and reloaded after
   restart carries `source:'human'` (if the column was added) or reloads as `NULL`/human (the documented
   degradation) — either way it decodes to human, never `'import'`.
8. **The S0 GOLDEN-OPS anchor and the S1a recognition tests stay green.** Adding a nullable column and
   tagging writes does not change any op's `entity`/`entity_id`/`field`/`value`/order; the byte-identical
   op-sequence characterization (normalizing `source` alongside `client_write_id`) still holds.

---

## Open questions for the product owner / follow-up

- **The protection POLICY is DECIDED: Policy A** (product owner, 2026-08-08 — protect only human-authored
  fields). The per-field op-log tag S2a adds is *required* by Policy A. Recorded in full in S2b
  §"The protection policy". No open policy question remains.
- **`pending_writes.source` (implementation choice, R4).** Add the column, or accept the documented
  human→NULL degradation. Both are safe; the Maker picks based on the column-addition cost. Not a product
  question — flagged so it is a deliberate call, not an omission.
- **No S1b sequencing question remains.** S1b is not built; S2a is v29 gated `>= 28` per Governor.
