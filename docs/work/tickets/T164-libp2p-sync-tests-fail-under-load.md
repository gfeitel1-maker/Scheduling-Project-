---
title: "The libp2p sync tests fail when the machine is busy, which is when agents work"
document_type: ticket
status: open
created: 2026-09-14
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a loaded machine no longer turns the libp2p sync tests red, or the suite says plainly that it did so for load rather than for a defect
---

# T164 — The libp2p sync tests fail when the machine is busy

Filed from the architecture-review program (T148-T163), where this cost real
time three separate times and each time had to be re-diagnosed from scratch.

## What happens

`electron/sync/automerge/syncProtocol.test.js` fails under concurrent load —
observed on `converges reliably across repeated connect cycles (not
timing-dependent)` (35.9s) and `concurrent writes on both sides converge to the
same document on both` (9.9s) — and passes in isolation on the same commit
seconds later (5/5, 28.8s). The tests bind real ports and race real timers, so
"the machine is busy" and "the code is wrong" produce the same red.

They are not alone; this program also fixed two neighbours of the same family:
- `parentScoped.test.js`'s 480-slot case had raised its ASSERTION ceiling to 60s
  to tolerate load and then left itself under the suite's 20s `testTimeout`.
  Fixed in T160 with a per-test timeout.
- The T151 rebuild property test measured ~22s in isolation, already past the
  20s default. Same fix.

## Why it matters more than an ordinary flake

The condition that triggers it — a loaded machine — is the *normal* condition in
this repository, because several agent sessions run this suite concurrently by
design (`vitest.setup.js` and `vite.config.js` both already say so in their own
comments, and both already raise budgets for it).

So the failure arrives exactly when someone is least able to judge it, and the
honest response costs 20 minutes: run the file in isolation, confirm it passes,
conclude flake. During this program I did that dance three times, and each time
had to first rule out my own change.

The danger is not the lost time. It is that the correct response and the
negligent response look identical — "it passed when I ran it again" — so the
habit this trains is re-running, which is precisely the habit that lets a real
regression through.

## Directions, none chosen

1. **Make the failure self-describing.** The cheapest. Have these tests report
   the machine state they observed when they fail, the way `parentScoped`'s
   tripwire comment does in prose, so the message distinguishes "too slow" from
   "did not converge". Does not reduce flake; removes the diagnosis cost.
2. **Serialize the port-binding tests** into their own non-parallel project or
   pool, so they cannot contend with each other or with the rest of the suite.
3. **Make convergence deterministic** — drive the protocol with an injected
   clock and an in-memory transport, and keep one real-socket test as the
   end-to-end proof. Largest change; also the only one that removes the class
   rather than managing it. Note the repo has already taken this shape twice
   with success (`attemptLogin({ now })` in T160, `diskSpace`'s injected clock).

## Not urgent, deliberately filed anyway

Nothing is broken in the product. What is broken is the signal, and signal decay
is the kind of thing that is only ever cheap to fix before someone has learned to
ignore it.
