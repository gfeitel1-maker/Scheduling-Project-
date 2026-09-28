---
task: wan-connectivity-tier4-signoff-gate-2026-09-28
document_type: handoff
status: active
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "the Tier-4 sign-off is resolved (INTERNET_TRANSPORT_SIGNOFF flipped or the owner defers), Slice C is dispatched, and this handoff's state is superseded by the tickets themselves"
---

# WAN connectivity + hardening — where it stands, for the next session

## The single live decision
**The program is paused at the Tier-4 sign-off gate, awaiting the owner.** The refreshed Tier-4
re-assessment is committed on branch `claude/tier4-reassessment-refresh` (commit `a2ff6cfc`),
governance clean, **NOT merged**, and `INTERNET_TRANSPORT_SIGNOFF` is **still false** — the flip is
the owner's act. The doc is `docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md`.

**On the owner's "yes":** merge the re-assessment AND flip `INTERNET_TRANSPORT_SIGNOFF` to true in
one PR (records acceptance + enables), then build the internet-facing slices. Do NOT flip it without
an explicit owner sign-off — it is the Tier-4 human-approval gate.

## What flipping the flag means (the owner is signing this)
Discovery-only, opt-in per device. The public meeting-point server sees an opaque device id +
registration timing under an opaque namespace; **addresses are AES-256-GCM encrypted** (only camp-key
holders decrypt). No relay/hole-punch yet (those are Slices E/F, built after C). Controlled
two-device test on the owner's own devices is safe now; real-camp rollout still needs signed
auto-update + internet-scale rate limits.

## Shipped to main this session (all `completed`, board reconciled)
- Sync safety: **T271** version gate, **T274** join-by-code sync fix, **T276** test-extract, **T275**/**T277** sync-status UI.
- WAN hardening (the owner's "harden before exposure" precondition, both done): **T286** join-secret hardening — attack-verified (Red Hat+Security RAN six attacks, ~108-113ms/guess, holds); **T287** v2 encrypted rendezvous record — key custody verified (worker sees only ciphertext).
- Governance: board reconciled (#573), **WORK_RECORD_STANDARD §3.3** (board-truth discipline), **T283** filed (main-side board-truth audit gate, owner-decision to build).
- Elective backlog triage closed out (T257 + dispositions); other sessions own the elective/at-rest/event-model programs.

## Locked next sequence (on sign-off)
1. Merge re-assessment + flip flag (one PR).
2. **Slice C / T288 — rendezvous client v2** (first Tier-4 trip). Three forward-findings are LOCKED into its brief: (a) re-derive `rendezvousAddressKey` from the LIVE document on every publish (never cache — concurrent-mint self-heal); (b) Host+Worker rate-limiting that closes the identity-churn bypass (T286 finding-1, required-before-C); (c) target the worker's REAL `{namespace,peerId,record}`/`{peers[]}` contract and fix the stale `{recordBase64}` line at ADR 2026-09-27 §3:227.
3. **Slice E / T290 — DCUtR** hole-punch, then **Slice F / T291 — data-relay (Option B, owner-approved)**. Both add libp2p packages (not installed; re-verify caps at build); both Tier-4-gated.
4. **Cloudflare deploy** (owner has an account now) + **two-device WAN test** (the real "proving sync", needs owner hardware).

## Pending OWNER actions
1. **Tier-4 sign-off** (now) — flips the flag, unblocks C→E→F + deploy.
2. **Code-signing certs** (before real camps) — **Slice D / T289 signed auto-update**: Apple Developer ID + a Windows signing cert (`mac.identity` null, `electron-updater` not installed).
3. **Domain name** — a subdomain for the rendezvous endpoint, folded in when purchased; design is domain-agnostic (client takes the URL via config).

## Program facts
- Relay = **Option B** (capped configurable data-relay; ciphertext forwarder — owner-approved). Rate limiter = **both** (Worker edge + Host authority). Revoked-device/namespace-rotation **deprioritized** by owner.
- Next free ticket **T292**; next free schema **v79** (none of the remaining slices need a migration).
- The program has run under an in-process **Governor** agent; a fresh session re-dispatches a `governor` with this handoff as context.
- Standing owner authorization: **merge routine PRs on green** (`feedback_merge_when_green_standing_auth`); the Tier-4 flag flip is the explicit exception that needs the owner.

## Cross-session note
Multiple sibling sessions are live (elective import, at-rest, board-scrub). Scan origin/main AND all
local worktrees before allocating ticket/schema numbers; PLATFORM_STATE is a hot conflict file
(keep-both). The status-drift gate fires only on `closes T##`/`Merge` subjects, not the `T##:` merge
convention — flip ticket status as part of the work (WORK_RECORD_STANDARD §3.3).
