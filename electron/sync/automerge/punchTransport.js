// S1 of the relay-less cross-network reconnect (docs/adr/2026-10-08-relayless-cross-network-reconnect.md,
// "Mechanism decision" / "Integration ruling" / "Hazards"; ticket T347).
//
// A custom libp2p TRANSPORT whose pipe is a node-datachannel (libdatachannel) DTLS data channel.
// The opened channel is wrapped as a libp2p MultiaddrConnection and handed to libp2p's normal
// upgrader, so Noise, authGate/T331 mutualAuth, isPeerRevoked, Yamux and Automerge sync run over it
// UNCHANGED. The DTLS layer authenticates nothing about the camp; admission is still entirely the
// auth stack above. A side channel that bypassed the upgrader was REJECTED by the ADR.
//
// INERT: nothing imports this module unless syncStarter.js's strict SHORESH_PUNCH_ENABLED === 'true'
// gate passes. Signaling is an injected interface ({ sendSignal(msg), onSignal(cb) => unsubscribe});
// S1 builds no real signaling channel. One signaling channel per transport instance; every message
// carries a session id so concurrent sessions cannot cross.
//
// NATIVE SAFETY (ADR "Hazards"): libdatachannel aborts the whole process on some API misuse (e.g.
// "No DataChannel or Track to negotiate"), which no JS try/catch can intercept. So every input is
// validated BEFORE any node-datachannel call, the session state machine makes an out-of-order call
// unreachable, and every teardown path calls pc.close() and, once nothing is live, the module's
// cleanup(). Probed on 0.33.4: close() alone leaves the process unable to exit, and cleanup() called
// in the same tick as close() segfaults — so teardown waits for each pc's 'closed' state first.
// Isolating node-datachannel in a utilityProcess is a recorded follow-up, not built here.
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { InvalidParametersError, NotStartedError, TimeoutError, AbortError, serviceCapabilities, transportSymbol } from '@libp2p/interface'
import { AbstractMultiaddrConnection } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'

const DATA_CHANNEL_LABEL = 'shoresh'
const MAX_SDP_CHARS = 16 * 1024
const MAX_CANDIDATE_CHARS = 512
const MAX_QUEUED_CANDIDATES = 32
// Well under every SCTP stack's max message size; AbstractMessageStream chunks writes to this.
const MAX_MESSAGE_BYTES = 16 * 1024
const BUFFER_HIGH_WATER = 256 * 1024
const BUFFER_LOW_WATER = 64 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_PENDING_INBOUND = 4
const CLOSE_SETTLE_TIMEOUT_MS = 1_000
const SID_RE = /^[0-9a-f]{32}$/
const STUN_RE = /^stun:[A-Za-z0-9.-]+(:\d{1,5})?$/
const PUNCH_ADDR_RE = /^\/ip[46]\/[^/]+\/udp\/\d+(\/p2p\/[^/]+)?$/

let loadedNdc = null
export function loadNodeDataChannel() {
  loadedNdc ??= createRequire(import.meta.url)('node-datachannel')
  return loadedNdc
}

const liveSessions = new Set()
let activeTransports = 0
let cleanupNdc = null

// Closes every live session, waits for libdatachannel to report each closed, then runs the
// module-level cleanup() that lets the process exit. Safe to call repeatedly and when nothing was
// ever started. Called by the transport's stop() when the last transport stops and by main's quit.
export async function shutdownPunchNative() {
  const sessions = [...liveSessions]
  for (const s of sessions) s.close()
  await Promise.all(sessions.map((s) => s.whenClosed))
  await new Promise((resolve) => setImmediate(resolve))
  if (liveSessions.size === 0 && cleanupNdc) {
    try { cleanupNdc() } catch { /* shutting down; nothing useful to do with a native cleanup error */ }
  }
}

function invalid(message) {
  return new InvalidParametersError(`punch: ${message}`)
}

function validateSdp(sdp, kind) {
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) throw invalid(`${kind} sdp must be a string of 1..${MAX_SDP_CHARS} chars`)
  if (!/^v=0\r?\n/.test(sdp)) throw invalid(`${kind} sdp is not an SDP document`)
  if (!/^m=application \d+ \S*DTLS\S* webrtc-datachannel/m.test(sdp)) throw invalid(`${kind} sdp has no data channel section`)
  if (/^m=(audio|video)\b/m.test(sdp)) throw invalid(`${kind} sdp offers media; only a data channel is accepted`)
  if (!/^a=ice-ufrag:\S+/m.test(sdp) || !/^a=ice-pwd:\S+/m.test(sdp)) throw invalid(`${kind} sdp carries no ICE credentials`)
  if (!/^a=fingerprint:\S+ \S+/m.test(sdp)) throw invalid(`${kind} sdp carries no DTLS fingerprint`)
}

function normalizeCandidate(candidate, mid) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_CANDIDATE_CHARS) throw invalid('candidate must be a non-empty string within the length cap')
  if (typeof mid !== 'string' || !/^[\w-]{1,64}$/.test(mid)) throw invalid('candidate mid is malformed')
  const bare = candidate.replace(/^a=/, '')
  const m = /^candidate:\S+ \d+ UDP \d+ \S+ \d{1,5} typ (host|srflx|prflx)(?: |$)/i.exec(bare)
  if (!m) throw invalid('candidate is not a UDP host/srflx/prflx candidate (relay candidates are never accepted)')
  return bare
}

function validateIceCredentials(init) {
  if (init == null) return
  const { iceUfrag, icePwd } = init
  if (typeof iceUfrag !== 'string' || typeof icePwd !== 'string') throw invalid('iceUfrag and icePwd must be given together as strings')
  if (!/^[A-Za-z0-9+/]{4,256}$/.test(iceUfrag)) throw invalid('iceUfrag must be 4..256 ICE characters')
  if (!/^[A-Za-z0-9+/]{22,256}$/.test(icePwd)) throw invalid('icePwd must be 22..256 ICE characters')
}

function validateFile(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !existsSync(value) || !statSync(value).isFile()) throw invalid(`${label} must be the path of an existing file`)
}

function validateOptions(opts) {
  if (opts == null || typeof opts !== 'object') throw invalid('options are required')
  const { signaling, role, iceServers = [], portRange, certificatePemFile, keyPemFile, ice, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, maxPendingInbound = DEFAULT_MAX_PENDING_INBOUND } = opts
  if (!signaling || typeof signaling.sendSignal !== 'function' || typeof signaling.onSignal !== 'function') throw invalid('signaling must provide sendSignal(msg) and onSignal(cb)')
  if (role != null && role !== 'offerer' && role !== 'answerer') throw invalid("role must be 'offerer' or 'answerer'")
  if (!Array.isArray(iceServers) || iceServers.some((s) => typeof s !== 'string' || !STUN_RE.test(s))) throw invalid('iceServers may only be stun: URLs (TURN is never used)')
  if (portRange != null) {
    const { begin, end } = portRange
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 1024 || end > 65535 || begin > end) throw invalid('portRange must be integers with 1024 <= begin <= end <= 65535')
  }
  if ((certificatePemFile == null) !== (keyPemFile == null)) throw invalid('certificatePemFile and keyPemFile must be given together')
  if (certificatePemFile != null) {
    validateFile(certificatePemFile, 'certificatePemFile')
    validateFile(keyPemFile, 'keyPemFile')
  }
  validateIceCredentials(ice)
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) throw invalid('connectTimeoutMs must be a positive integer')
  if (!Number.isInteger(maxPendingInbound) || maxPendingInbound <= 0) throw invalid('maxPendingInbound must be a positive integer')
  return { signaling, role, iceServers, portRange, certificatePemFile, keyPemFile, ice, connectTimeoutMs, maxPendingInbound }
}

function rtcConfigFrom(opts) {
  return {
    iceServers: opts.iceServers,
    disableAutoNegotiation: true,
    enableIceTcp: false,
    ...(opts.portRange ? { portRangeBegin: opts.portRange.begin, portRangeEnd: opts.portRange.end } : {}),
    ...(opts.certificatePemFile ? { certificatePemFile: opts.certificatePemFile, keyPemFile: opts.keyPemFile } : {}),
  }
}

class PunchMultiaddrConnection extends AbstractMultiaddrConnection {
  constructor({ session, dc, remoteAddr, direction, log }) {
    super({ remoteAddr, direction, log, maxMessageSize: MAX_MESSAGE_BYTES })
    this.session = session
    this.dc = dc
    dc.setBufferedAmountLowThreshold(BUFFER_LOW_WATER)
    dc.onBufferedAmountLow(() => this.safeDispatchEvent('drain'))
    dc.onMessage((msg) => {
      if (typeof msg === 'string') {
        this.abort(new Error('punch: peer sent a text frame on a binary channel'))
        return
      }
      this.onData(new Uint8Array(msg))
    })
    dc.onClosed(() => this.onTransportClosed())
    dc.onError((err) => this.abort(new Error(`punch: data channel error: ${err}`)))
  }

  sendData(data) {
    let sentBytes = 0
    for (const chunk of data) {
      if (!this.session.sendBinary(chunk)) throw new Error('punch: data channel is not open')
      sentBytes += chunk.byteLength
    }
    return { sentBytes, canSendMore: this.session.bufferedAmount() < BUFFER_HIGH_WATER }
  }

  async sendClose() {
    this.session.close()
    await this.session.whenClosed
  }

  sendReset() {
    this.session.close()
  }

  sendPause() {}

  sendResume() {}
}

function remoteAddrFromPair(pc) {
  try {
    const remote = pc.getSelectedCandidatePair()?.remote
    const family = isIP(remote?.address)
    if (family && Number.isInteger(remote.port)) return multiaddr(`/ip${family}/${remote.address}/udp/${remote.port}`)
  } catch { /* fall through to the placeholder */ }
  return multiaddr('/ip4/0.0.0.0/udp/0')
}

// One PeerConnection + DataChannel. The state machine is the native-safety mechanism: each method
// checks `phase`, so a node-datachannel call that is only legal in a given phase is unreachable in
// any other.
class PunchSession {
  constructor({ ndc, name, rtcConfig, ice, role, sid, sendSignal, log, direction, remoteAddr, onClosed }) {
    this.sid = sid
    this.role = role
    this.log = log
    this.direction = direction
    this.fixedRemoteAddr = remoteAddr
    this.ice = ice
    this.sendSignal = sendSignal
    this.onClosed = onClosed
    this.phase = 'new'
    this.closed = false
    this.dc = null
    this.maConn = null
    this.queuedCandidates = []
    this.remoteDescriptionSet = false
    this.opened = Promise.withResolvers()
    this.opened.promise.catch(() => {})
    const closedSignal = Promise.withResolvers()
    this.whenClosed = closedSignal.promise
    this.markClosed = closedSignal.resolve
    this.pc = new ndc.PeerConnection(name, rtcConfig)
    liveSessions.add(this)
    const pc = this.pc
    pc.onLocalDescription((sdp, type) => {
      if (this.closed || (type !== 'offer' && type !== 'answer')) return
      this.emit({ type, sdp })
    })
    pc.onLocalCandidate((candidate, mid) => {
      if (!this.closed) this.emit({ type: 'candidate', candidate, mid })
    })
    pc.onStateChange((state) => {
      if (state === 'closed') this.markClosed()
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.opened.reject(new Error(`punch: connection ${state} before the data channel opened`))
        this.close()
      }
    })
  }

  emit(msg) {
    try {
      const sent = this.sendSignal({ ...msg, sid: this.sid })
      if (sent && typeof sent.catch === 'function') sent.catch((err) => this.log.error('signal send failed - %e', err))
    } catch (err) {
      this.log.error('signal send failed - %e', err)
    }
  }

  assertLive(allowed) {
    if (this.closed) throw invalid('session is closed')
    if (!allowed.includes(this.phase)) throw invalid(`operation not valid in phase ${this.phase}`)
  }

  wireChannel(dc) {
    this.dc = dc
    dc.onOpen(() => {
      if (this.closed) return
      this.maConn = new PunchMultiaddrConnection({
        session: this,
        dc,
        remoteAddr: this.fixedRemoteAddr ?? remoteAddrFromPair(this.pc),
        direction: this.direction,
        log: this.log,
      })
      this.opened.resolve(this.maConn)
    })
    dc.onClosed(() => this.close())
  }

  startOffer() {
    this.assertLive(['new'])
    this.phase = 'offered'
    this.wireChannel(this.pc.createDataChannel(DATA_CHANNEL_LABEL))
    this.pc.setLocalDescription(...['offer', ...(this.ice ? [this.ice] : [])])
  }

  acceptOffer(sdp) {
    validateSdp(sdp, 'offer')
    this.assertLive(['new'])
    this.phase = 'answered'
    this.pc.onDataChannel((dc) => {
      if (this.dc || this.closed) {
        try { dc.close() } catch { /* a second channel is refused */ }
        return
      }
      this.wireChannel(dc)
    })
    this.pc.setRemoteDescription(sdp, 'offer')
    this.remoteDescriptionSet = true
    this.flushCandidates()
    this.pc.setLocalDescription(...['answer', ...(this.ice ? [this.ice] : [])])
  }

  acceptAnswer(sdp) {
    validateSdp(sdp, 'answer')
    this.assertLive(['offered'])
    this.phase = 'established'
    this.pc.setRemoteDescription(sdp, 'answer')
    this.remoteDescriptionSet = true
    this.flushCandidates()
  }

  addCandidate(candidate, mid) {
    const normalized = normalizeCandidate(candidate, mid)
    this.assertLive(['new', 'offered', 'answered', 'established'])
    if (!this.remoteDescriptionSet) {
      if (this.queuedCandidates.length >= MAX_QUEUED_CANDIDATES) throw invalid('too many candidates queued before the remote description')
      this.queuedCandidates.push([normalized, mid])
      return
    }
    this.pc.addRemoteCandidate(normalized, mid)
  }

  flushCandidates() {
    const queued = this.queuedCandidates
    this.queuedCandidates = []
    for (const [candidate, mid] of queued) {
      try { this.pc.addRemoteCandidate(candidate, mid) } catch (err) { this.log.error('queued candidate rejected - %e', err) }
    }
  }

  sendBinary(chunk) {
    if (this.closed || !this.dc?.isOpen()) return false
    return this.dc.sendMessageBinary(chunk)
  }

  bufferedAmount() {
    return this.closed || !this.dc ? 0 : this.dc.bufferedAmount()
  }

  waitOpen({ timeoutMs, signal }) {
    const timer = setTimeout(() => this.opened.reject(new TimeoutError(`punch: data channel did not open within ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => this.opened.reject(new AbortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    return this.opened.promise.finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.opened.reject(new Error('punch: session closed'))
    liveSessions.delete(this)
    try { this.dc?.close() } catch { /* already closing */ }
    try { this.pc.close() } catch { /* already closing */ }
    setTimeout(this.markClosed, CLOSE_SETTLE_TIMEOUT_MS).unref()
    this.onClosed?.(this)
  }
}

class PunchListener extends EventTarget {
  constructor({ transport, upgrader }) {
    super()
    this.transport = transport
    this.upgrader = upgrader
    this.addr = null
    this.shutdown = new AbortController()
    this.inbound = new Set()
    this.pending = new Set()
  }

  async listen(ma) {
    if (!PUNCH_ADDR_RE.test(ma.toString())) throw invalid('listen address must be /ipX/<addr>/udp/<port>')
    this.addr = ma
    this.transport.listener = this
    this.dispatchEvent(new Event('listening'))
  }

  getAddrs() {
    return this.addr ? [this.addr] : []
  }

  updateAnnounceAddrs() {}

  onOffer(sid, sdp) {
    if (this.transport.sessions.has(sid)) {
      this.transport.log('dropping offer %s: session id already in use', sid)
      return
    }
    if (this.pending.size >= this.transport.opts.maxPendingInbound) {
      this.transport.log('dropping offer %s: too many pending inbound sessions', sid)
      return
    }
    const session = this.transport.newSession({ role: 'answerer', sid, direction: 'inbound' })
    this.inbound.add(session)
    this.pending.add(session)
    try {
      session.acceptOffer(sdp)
    } catch (err) {
      this.transport.log.error('inbound offer rejected - %e', err)
      session.close()
      return
    }
    session.waitOpen({ timeoutMs: this.transport.opts.connectTimeoutMs, signal: this.shutdown.signal })
      .then((maConn) => {
        this.pending.delete(session)
        return this.upgrader.upgradeInbound(maConn, { signal: this.shutdown.signal }).catch((err) => maConn.abort(err))
      })
      .catch((err) => {
        this.transport.log.error('inbound punch failed - %e', err)
        session.close()
      })
  }

  async close() {
    this.shutdown.abort()
    const sessions = [...this.inbound]
    for (const s of sessions) s.close()
    await Promise.all(sessions.map((s) => s.whenClosed))
    this.inbound.clear()
    if (this.transport.listener === this) this.transport.listener = null
    this.addr = null
    this.dispatchEvent(new Event('close'))
  }
}

class PunchTransport {
  [transportSymbol] = true;
  [Symbol.toStringTag] = 'shoresh/punch';
  [serviceCapabilities] = ['@libp2p/transport']

  constructor(components, opts, ndc) {
    this.components = components
    this.opts = opts
    this.ndc = ndc
    this.log = components.logger.forComponent('libp2p:punch')
    this.sessions = new Map()
    this.listener = null
    this.unsubscribe = null
    this.started = false
  }

  async start() {
    if (this.started) return
    this.ndc ??= loadNodeDataChannel()
    cleanupNdc = () => this.ndc.cleanup()
    this.started = true
    activeTransports++
    this.unsubscribe = this.opts.signaling.onSignal((msg) => this.onSignal(msg))
  }

  async stop() {
    if (!this.started) return
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    const sessions = [...this.sessions.values()]
    for (const s of sessions) s.close()
    await Promise.all(sessions.map((s) => s.whenClosed))
    if (--activeTransports === 0) await shutdownPunchNative()
  }

  newSession({ role, sid, direction, remoteAddr }) {
    const session = new PunchSession({
      ndc: this.ndc,
      name: `shoresh-punch-${role}`,
      rtcConfig: rtcConfigFrom(this.opts),
      ice: this.opts.ice,
      role,
      sid,
      sendSignal: (msg) => this.opts.signaling.sendSignal(msg),
      log: this.log,
      direction,
      remoteAddr,
      onClosed: (s) => {
        this.sessions.delete(s.sid)
        this.listener?.inbound.delete(s)
        this.listener?.pending.delete(s)
      },
    })
    this.sessions.set(sid, session)
    return session
  }

  onSignal(msg) {
    try {
      if (!msg || typeof msg !== 'object' || !SID_RE.test(msg.sid)) return
      if (msg.type === 'offer') {
        if (this.started) this.listener?.onOffer(msg.sid, msg.sdp)
        return
      }
      const session = this.sessions.get(msg.sid)
      if (!session) return
      if (msg.type === 'answer') session.acceptAnswer(msg.sdp)
      else if (msg.type === 'candidate') session.addCandidate(msg.candidate, msg.mid)
    } catch (err) {
      this.log.error('signal rejected - %e', err)
    }
  }

  async dial(ma, options) {
    if (!this.started) throw new NotStartedError('punch transport is not started')
    if (this.opts.role === 'answerer') throw invalid("a transport with role 'answerer' cannot dial")
    options.signal?.throwIfAborted()
    const session = this.newSession({ role: 'offerer', sid: randomBytes(16).toString('hex'), direction: 'outbound', remoteAddr: ma })
    let maConn
    try {
      session.startOffer()
      maConn = await session.waitOpen({ timeoutMs: this.opts.connectTimeoutMs, signal: options.signal })
    } catch (err) {
      session.close()
      throw err
    }
    try {
      return await options.upgrader.upgradeOutbound(maConn, options)
    } catch (err) {
      maConn.abort(err)
      throw err
    }
  }

  createListener(options) {
    return new PunchListener({ transport: this, upgrader: options.upgrader })
  }

  listenFilter(multiaddrs) {
    return this.opts.role === 'offerer' ? [] : multiaddrs.filter((ma) => PUNCH_ADDR_RE.test(ma.toString()))
  }

  dialFilter(multiaddrs) {
    return this.opts.role === 'answerer' ? [] : multiaddrs.filter((ma) => PUNCH_ADDR_RE.test(ma.toString()))
  }
}

// opts: { signaling, role?, iceServers?, portRange?, certificatePemFile?, keyPemFile?, ice?:
// { iceUfrag, icePwd }, connectTimeoutMs?, maxPendingInbound?, ndc? }. Invalid options throw
// here, at configuration time, before libp2p or node-datachannel is touched.
export function punchTransport(options) {
  const opts = validateOptions(options)
  const ndc = options.ndc
  return (components) => new PunchTransport(components, opts, ndc)
}

// Exposed for the native-misuse child-process tests, which drive a session without libp2p.
export function createPunchSessionForTest({ ndc, role, sid, sendSignal, ice, rtcConfig = { iceServers: [], disableAutoNegotiation: true } }) {
  validateIceCredentials(ice)
  const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
  return new PunchSession({ ndc, name: 'punch-test', rtcConfig, ice, role, sid, sendSignal, log: noop, direction: role === 'offerer' ? 'outbound' : 'inbound' })
}
