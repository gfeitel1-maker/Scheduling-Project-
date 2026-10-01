# Raw performance measurement — commit/finalize document flush

Everything the ADR amendment's table is derived from. All numbers are
`process.cpuUsage()` (user+sys), never wall clock — wall ms is in the raw cell
logs beside it, never instead of it. Every harness run spawns its cells
INTERLEAVED (oplog/automerge alternating, order flipped per repeat) because on
this 4-core machine a block of same-arm runs measures the machine's mood.

## How to re-derive

```
node --import ./scripts/fixtures/registerElectronStub.mjs \
     scripts/electiveFreezePerf.mjs --sizes 40,80,160,312 --repeats 3
```

The three arms differ only in `DOC_CHANGE_CHUNK`
(`electron/sync/automerge/liveDoc.js`), which is why they are comparable:

| arm | `DOC_CHANGE_CHUNK` | equivalent to |
| --- | --- | --- |
| baseline | `1` | `origin/main` — one `A.change` per field write |
| round 1 | `Number.MAX_SAFE_INTEGER` | commit `d2a579c9` — one `A.change` per run |
| round 2 | `250` | this branch |

| file | arm |
| --- | --- |
| `perf-baseline-per-write-same-machine.txt` | baseline, n=80/160, repeats 2 |
| `perf-round1-one-change-same-machine.txt` | round 1, n=160/312, repeats 2 |
| `perf-round2-chunked-head.txt` | round 2, n=40/80/160/312, repeats 3 |
| `micro-empty-doc.mjs` | isolates `applyWrites` chunk size, empty document |
| `micro-prepopulated-doc.mjs` | same, against a 6000-key document |

## commit — document flush, cpu µs per op

| n | baseline | round 1 | round 2 |
| --- | --- | --- | --- |
| 80 | 3292 | — | 1625 |
| 160 | 4851 | 7256 | 1490 |
| 312 | — | 12551 | 1415 |

**The round-1 commit regression reproduces.** At n=160, same machine, spreads
under 3% in both arms: 4851 → 7256 is **1.50× worse than `origin/main`**, which
is Verifier's finding (1.25×/1.53×/1.62× at n=80/160/312) confirmed
independently. Round 2 is 3.3× better than baseline and 4.9× better than round 1,
and its cpu/op DECLINES with n (2018 → 1625 → 1490 → 1415) rather than rising.

## finalize — document flush, cpu µs per op

| n | baseline | round 1 | round 2 |
| --- | --- | --- | --- |
| 80 | 6351 | — | 1053 |
| 160 | 13061 | 5012 | 1227 |
| 312 | — | 8903 | 1483 |

Growth per doubling: baseline ×2.06, round 1 ×1.78, round 2 ×1.04/×1.17/×1.21.

## Where the time actually went (the diagnosis)

`node --cpu-prof` over one `312:automerge` cell of the ROUND-1 code, aggregated
by self time (168.8s sampled):

```
136.47s  80.9%  <automerge::transaction::inner::TransactionInner>::exid_to_obj   (automerge_wasm)
  2.47s   1.5%  makeSyncRequest                                                  (node esm hooks)
  1.32s   0.8%  leb128::read::signed                                             (automerge_wasm)
  1.04s   0.6%  applyOneWriteInto                                                (campDocument.js)
```

Every property access on a collection proxy inside an OPEN transaction
re-resolves that collection against the transaction's own pending ops, so the
cost of write *k* is linear in the number already pending. One `A.change` of n
writes is therefore O(n²) in the same shape a per-write `A.change` was O(n²) in
document size — a smaller constant, the same curve. Commit is a bigger run on a
smaller document than finalize, which is why round 1 made commit worse and
finalize better.

## Choosing the chunk size (`micro-prepopulated-doc.mjs`, 6000-key document)

cpu µs per write, min of 2 interleaved samples:

| arm | n=500 | n=1000 | n=2000 | n=4000 |
| --- | --- | --- | --- | --- |
| 1 change | 649 | 773 | 1418 | 2862 |
| chunk 50 | 991 | 1044 | 1020 | 1138 |
| chunk 100 | 737 | 794 | 771 | 796 |
| chunk 250 | 642 | 596 | 620 | 664 |
| chunk 500 | 583 | 598 | 655 | 657 |
| chunk 1000 | 626 | 720 | 745 | 728 |

Against an EMPTY document (`micro-empty-doc.mjs`) chunk 100/250 are both flat at
~460–510 µs/write while 1 change rises 568 → 741 → 1354 → 2875. 250 is the only
size that is at or near the optimum in both regimes; 50 pays the per-change
document cost 80× over and is the worst arm at every size.

## What these numbers do NOT support

Read the spreads. The round-2 run was taken on a loaded machine (n=312 automerge
finalize spread 4.99s..7.62s, a 1.5× range) while the round-1 and baseline runs
were quiet (spreads under 3%) — so round 2's numbers are if anything inflated and
the improvement is understated, but the round-2 growth factors ×1.04/×1.17/×1.21
are NOT distinguishable from each other at this sample size. "Flatter than
round 1, which was flatter than baseline" is supported. Any finer reading of
those three numbers is not.
