---
title: "Open decisions from the architecture review — options in plain language, with a recommendation"
document_type: architecture-report
status: current
created: 2026-09-14
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [T156, T157]
---

# Open decisions from the architecture review

Six questions the review left open that are **product decisions, not defects**.
Each is written for someone who owns the outcome and does not need to read the
code. The seventh — the game-integration boundary — was decided on 2026-09-14
and its ADR is accepted.

Confidence is stated per recommendation, because "I am sure this works" and "I
think this is the right tradeoff" are different claims.

| # | The question, plainly | What is actually at stake | Your options | Recommendation |
|---|---|---|---|---|
| **1** | **A camp PIN is four digits, and every computer holds a scrambled copy of it.** | Scrambling is done properly, but four digits is ten thousand guesses. Someone who copies the camp file off a staff laptop can work out the PINs at leisure — no lockout applies offline. They already have all the camp's data at that point, so what they gain is **acting as someone else** — and cracking a *director's* PIN gets them director powers. | **(a)** Leave it — the person needs an approved laptop first. **(b)** Allow longer PINs for everyone. **(c)** Require 6+ digits **for directors only**, leave staff at 4. **(d)** Reduce what a director can do that staff cannot, so it matters less. | **(c).** The thing worth protecting is the director capability, and directors are a handful of people who set a PIN once. Staff keep the four digits they type all day. **Confidence: high** that it closes the real exposure; **medium** on how much it annoys anyone. |
| **2** | **The generated schedule does not warn you when two groups end up in one place; the manual one does.** ([T156](../tickets/T156-generated-route-validity-after-merge.md)) | The generated route never warned because the engine refuses to *create* a clash. Now two directors editing offline can each move a group into the same room, the copies merge cleanly, and nobody is told. On the manual route they would see it immediately. | **(a)** Show the same warning on both routes. **(b)** Re-run the engine's checks after every merge and refresh the flags. **(c)** Accept it and write it down, as we did for role enforcement. | **(a).** A director reading a warning does not care which route drew it, and the manual route already computes exactly this. **(b)** is a much larger job — it has to reconcile fresh engine output against hand edits without undoing them. **Confidence: high.** |
| **3** | **Once a device is approved it carries a pass, and a copied pass works from another machine.** | Copying it means reaching an approved device's storage — and at that point they already hold the whole camp file. Revoking the device kills the copied pass immediately. | **(a)** Leave it; revisit if the threat model changes. **(b)** Give every device a permanent identity and tie the pass to it. **(c)** Make passes expire sooner (they last 24h). | **(a).** The attacker gains nothing they did not already have, and **(b)** introduces per-device keys to manage and recover — real ongoing cost for no gain under a "devices the director approved are trusted" model. Revisit **(b)** the day you have users you do *not* trust with the whole camp. **Confidence: high.** |
| **4** | **"Wipe this computer's copy and rebuild it from the camp" works, but there is no button — only steps.** | Proven to restore the camp exactly. It does **not** bring back Trash, the old values behind a restore, or import-undo — those are each computer's own diary, not shared. | **(a)** Leave it as a written procedure. **(b)** Add a support command you can be walked through on the phone. **(c)** Put a "repair this computer" button in the app. | **(b).** It reuses the machine-access surface that already exists, and a support command is something you run *deliberately* with someone. **(c)** is a button whose worst day is worse than the problem it solves. **Confidence: medium-high.** |
| **5** | **If the disk is full, the app cannot even write down that it failed.** | Every safeguard we added writes a note to the same disk that just refused a write. It now tags the failure so the log lines can be tied together, and says plainly when nothing was recorded — but it cannot fix itself on a full disk. | **(a)** Accept it; the tag is the mitigation. **(b)** Keep a reserved sliver of space or a second location to write into. **(c)** Warn when the disk gets low, **before** it matters. | **(c).** It is the only one that actually helps, and it is simple. **(b)** is complexity that still fails when the disk truly fills. **Confidence: medium-high.** |
| **6** | **Five separate features remember "you taught me this", all built much the same way.** ([T157](../tickets/T157-camp-acquired-knowledge-pattern.md)) | Aliases, compound cells, location words, declined splits, reconciliation decisions. Merging them into one system now would be guessing at what they have in common while they are still diverging. | **(a)** Leave them separate; a tripwire fires at the sixth. **(b)** Build one shared "camp memory" system now. | **(a).** The outside reviewer's own advice, and the right one: five similar things is a pattern to watch, not yet proof of a shared idea. The tripwire means the decision happens on evidence. **Confidence: high.** |

## Sequencing, if you want them done

1. **#2** (warn on both routes) — smallest, most visible to a director, closes a real hole.
2. **#1(c)** (6-digit director PIN) — small, and the only security item with a clear owner decision behind it.
3. **#5(c)** (low-disk warning) — small, prevents a class of silent loss.
4. **#4(b)** (support command) — useful the first time something goes wrong; no rush before then.
5. **#3** and **#6** — no work; both are "revisit when X happens", and X is recorded.
