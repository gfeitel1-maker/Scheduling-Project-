// findFreeSuffix — the shared "smallest free disambiguating suffix" scan.
//
// T104 (extract the duplicated scan) and T103 (bound it) are one change: the
// ceiling has to live wherever the scan lives, and there should only be one
// scan for it to live in.
//
// Two call sites, deliberately different in shape, which is why this takes a
// `probe` rather than a collection:
//   - electron/ops/locationId.js  keys by ID   and wants three answers
//     (free / this one is already mine, reuse it / taken, keep looking)
//   - electron/ops/duplicateWeek.js keys by NAME and wants two
//     (free / taken)
//
// PURE. No IO, no DB, no clock, no randomness — `probe` supplies all knowledge
// of the world, so a caller can drive this from a db query, a preloaded array,
// or a test fixture without this module knowing the difference. Deterministic
// and cross-device convergent by construction: two devices probing the same
// synced state walk the same sequence and stop at the same n.
//
// ---------------------------------------------------------------------------
// On T103's premise, recorded because the ticket overstates it.
//
// T103 reported that `${base}:${n}` could collide with a location literally
// NAMED with a colon, since deriveLocationId never escapes them. Measured
// 2026-09-12, driving resolveLocationCandidateId directly in both orderings:
// it does not. The scan probes each candidate before minting it, so an id
// already owned by a literal-colon row is skipped, and a literal name whose
// base is taken scans past it. No collision in either direction.
//
// What IS real is the unbounded `for (let n = 2; ; n++)`. A corrupt or
// adversarial state that occupies every candidate spins forever inside a
// synchronous write path, taking the UI thread with it. That is what `limit`
// exists for. It is a programmer-error backstop, not a business rule: hitting
// it means the world is not what the caller believes, so it THROWS rather than
// returning a degraded id that would then be written to the op log.
// ---------------------------------------------------------------------------

// Deliberately far above any real camp. A camp with 1000 same-named locations
// has a data problem this function must surface, not paper over.
export const DEFAULT_SUFFIX_LIMIT = 1000

/**
 * @param {object}   opts
 * @param {(n: number) => string} opts.format  builds the candidate for n
 * @param {(candidate: string) => 'free'|'reuse'|'taken'} opts.probe
 * @param {number}  [opts.start=2]   first suffix tried (2 = "the second one")
 * @param {number}  [opts.limit]     max attempts before throwing
 * @param {string}  [opts.label]     what is being disambiguated, for the error
 * @returns {{ candidate: string, n: number, reused: boolean }}
 */
export function findFreeSuffix({ format, probe, start = 2, limit = DEFAULT_SUFFIX_LIMIT, label = 'value' }) {
  for (let n = start; n < start + limit; n++) {
    const candidate = format(n)
    const verdict = probe(candidate)
    if (verdict === 'free') return { candidate, n, reused: false }
    if (verdict === 'reuse') return { candidate, n, reused: true }
  }
  throw new Error(
    `findFreeSuffix: no free suffix for ${label} after ${limit} attempts (from ${start}). ` +
      'This means the collection is not in the state the caller expects — see T103.',
  )
}
