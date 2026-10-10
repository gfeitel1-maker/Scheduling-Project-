// T207 — the detection half of the Tier-4 transport-boundary guard
// (docs/adr/2026-09-14-internet-transport-security-gate.md,
//  docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md §2.3 C1).
//
// WHY THIS IS A MODULE AND NOT A REGEX INSIDE THE GUARD TEST.
//
// The guard has now been wrong twice in the same way. Its first version asserted that
// transport.js's DEFAULT_LISTEN stayed loopback — a constant that is dead in production, while the
// real node binds 0.0.0.0 (found by the 2026-09-15 WAN assessment). Its second version is
// package-shaped and marker-shaped: it checks package.json for forbidden libp2p packages, checks
// transport.js's imports, and checks that main.js still matches a `createMdnsDiscovery(` regex.
//
// The rendezvous design now on the table (a Cloudflare Worker bulletin board reached over plain
// HTTPS) defeats all three without any malice: an HTTPS `fetch` is not an npm libp2p package, is
// not imported by transport.js, and a rendezvous service appended AFTER createMdnsDiscovery( in
// the peerDiscovery array still satisfies that regex. A node could publish its real WAN addresses
// to a public bulletin board with a fully green gate.
//
// So the boundary is restated behaviourally: **the sync path performs no outbound internet egress
// of its own.** All of its traffic goes through libp2p, to peers found on the link-local network.
// A rendezvous client — by any name, in any file, using fetch or https or undici — is egress, and
// that is what this scanner looks for.
//
// Pulling it out as a pure function is deliberate: it makes the detection independently testable
// against defect shapes the guard's author did NOT have in mind (see internetRendezvousScan.test.js).
// A non-vacuity test that plants only the shape the guard was designed around proves nothing — this
// repository has shipped exactly that mistake before.
//
// KNOWN LIMITS, stated because a guard's description is part of the guard:
//   * It is a text scanner, not a type system. Egress reached through an indirection it cannot
//     see — a helper in another tree, a string built at runtime, an IPC round-trip to a renderer
//     that fetches on the sync path's behalf — is invisible to it.
//   * `stripComments` is naive about `//` and `/* */` sequences inside string literals. It can
//     therefore under-report (a construct hidden inside what it wrongly took for a comment).
//     It errs toward under-reporting rather than false alarms; it is a tripwire, not a proof.
//   * It says nothing about whether egress is *safe*. It says a human must re-decide the boundary.

// Each entry is a distinct way to reach the internet from Node/Electron main-process code.
// `label` is what the failure message shows a reader who has never seen this file.
export const DGRAM_LABEL = 'dgram UDP socket'
const EGRESS_PATTERNS = [
  { label: 'fetch()', re: /(?:^|[^.\w])(?:globalThis\.|window\.|self\.)?fetch\s*\(/m },
  { label: "node http/https module", re: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?https?['"]/m },
  { label: 'http(s).request/get', re: /\bhttps?\s*\.\s*(?:request|get)\s*\(/m },
  { label: 'undici', re: /['"]undici['"]/m },
  { label: 'axios', re: /['"]axios['"]/m },
  { label: 'node-fetch', re: /['"]node-fetch['"]/m },
  { label: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/m },
  { label: 'raw net/tls socket', re: /\b(?:net|tls)\s*\.\s*connect\s*\(/m },
  { label: 'hard-coded http(s) URL', re: /['"`]https?:\/\//m },
  // T359 slice 5 — a UDP socket is egress the HTTP-shaped patterns above cannot see (SSDP multicast,
  // NAT-PMP). It is the one label a LAN-egress allowlist can exempt (see unauthorizedEgress).
  { label: DGRAM_LABEL, re: /['"`](?:node:)?dgram['"`]|\bdgram\s*\.\s*createSocket\s*\(/m },
  // T288 addendum §1.3 — a dynamic import() whose argument is NOT a string literal is a computed
  // module specifier, which can resolve to an internet-egress package at runtime without any
  // static import to grep for. A static `import('./x.js')` (or "x.js", or `x.js`) is excluded by
  // requiring the char immediately after `(`/whitespace to NOT be a quote — this is what keeps
  // syncStarter.js's legitimate `await import('./syncNode.js')` from false-positiving (confirmed
  // against the real file before shipping this pattern, per the addendum's own open item).
  { label: 'dynamic import()/computed require()', re: /\bimport\s*\(\s*[^'"`]/m },
]

/**
 * Remove line and block comments so a URL or an example in prose does not read as egress.
 * Naive by design — see the KNOWN LIMITS note above.
 */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

/**
 * Pure: source text -> the labels of every internet-egress primitive it contains.
 * Returns [] for source that reaches the network only through libp2p.
 */
export function findInternetEgress(source) {
  const code = stripComments(source)
  return EGRESS_PATTERNS.filter(({ re }) => re.test(code)).map(({ label }) => label)
}

export const EGRESS_LABELS = EGRESS_PATTERNS.map((p) => p.label)

/**
 * Pure: given a package-lock.json `packages` map (the RESOLVED dependency tree — every nested
 * node_modules path, not just direct deps) and a list of forbidden package names, returns the
 * subset of forbidden names present anywhere in the tree. Extracted so the guard's non-vacuity
 * tests can feed it an in-memory, modified lockfile fixture without touching the real file
 * (T288 addendum §6, seams 1-2).
 */
export function forbiddenPackagesPresent(lockfilePackages, forbiddenPackages) {
  const resolvedNames = new Set(
    Object.keys(lockfilePackages ?? {}).map((p) => p.replace(/.*node_modules\//, ''))
  )
  return forbiddenPackages.filter((p) => resolvedNames.has(p))
}

/**
 * Pure: given a list of `{relPath, basename, source}` and the discovery egress allowlist state,
 * returns offender description strings. A file is exempt only if its OWN full repo-relative path
 * is on the allowlist AND discovery is currently signed off — never by basename (a second file
 * sharing a basename at a different path must not inherit the exemption — Round 2 FIX 3) and
 * never by virtue of who imports it (T288 addendum §1.3's file-identity-not-import-graph rule;
 * seam 3's importer-inheritance exploit).
 */
export function unauthorizedEgress(files, { discoveryOn, allowlist, lanOn = false, lanAllowlist = [] }) {
  const allowed = new Set(allowlist)
  const lanAllowed = new Set(lanAllowlist)
  return files
    .map(({ relPath, source }) => {
      const labels = findInternetEgress(source)
      if (labels.length === 0) return null
      if (discoveryOn && allowed.has(relPath)) return null
      // T359 slice 5: a port-mapping module may open UDP sockets to the LAN (SSDP, NAT-PMP) and nothing else.
      const remaining = lanOn && lanAllowed.has(relPath) ? labels.filter((l) => l !== DGRAM_LABEL) : labels
      return remaining.length === 0 ? null : `${relPath} (${remaining.join(', ')})`
    })
    .filter(Boolean)
}
