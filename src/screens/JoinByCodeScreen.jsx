import { useCallback, useEffect, useRef, useState } from 'react'
import AuthWatermark from '../components/AuthWatermark'
import { S, useEnterTransition } from '../styles/shared'
import { localClient } from '../localClient'

// Joining a camp with the code shown on the Host — docs/adr/2026-09-08-libp2p-join-flow.md §4.
//
// This screen replaces an address picker that showed rows like
// "192.168.1.14 · Port 5100 · camp-a3f9…" and told the director they would
// learn which camp it was after signing in. The owner's standing constraint on
// this work is that joining "has to be a recognizable form of identity pairing
// for people" — a director on a second device should experience pairing THEIR
// camp. A code read off their own Host and typed here is that; a list of IP
// addresses is not.
//
// The camp's NAME is deliberately never on the network (electron/sync/campIdHash.js:
// mDNS is broadcast in the clear to every device on the LAN, including a
// stranger's laptop in a shared building). So recognition happens at the first
// moment it safely can — at the end, over the authenticated channel, as
// something the director confirms rather than takes on faith.
//
// EVERY FAILURE HERE IS NAMED. Constitution Article V: the engine surfaces
// problems, it never quietly absorbs them. A join can fail in five distinct
// ways that mean five different things to the person standing there, and a
// single "couldn't connect" would send them to check their Wi-Fi for a
// mistyped character. They are kept separate on purpose.

const STEP = {
  code: 'code',
  searching: 'searching',
  notFound: 'notFound',
  wrongCamp: 'wrongCamp',
  notThisCamp: 'notThisCamp',
  notKnownHere: 'notKnownHere',
  updateNeeded: 'updateNeeded',
  erasureFailed: 'erasureFailed',
  waitingForApproval: 'waitingForApproval',
  denied: 'denied',
  signIn: 'signIn',
  receiving: 'receiving',
  noData: 'noData',
  joined: 'joined',
}

// Pair again: the can't-reach-the-camp flag's action. Same flow, run by a device that already
// belongs to the camp and keeps its data (electron/sync/automerge/joinSession.js, `rejoin`).
export function PairAgainScreen({ onNavigate }) {
  return <JoinByCodeScreen rejoin onBack={() => onNavigate('devices')} onJoined={() => onNavigate('roots')} />
}

export default function JoinByCodeScreen({ onBack, onJoined, rejoin = false }) {
  const enter = useEnterTransition('liftFade')
  const [step, setStep] = useState(STEP.code)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [camp, setCamp] = useState(null)
  const [deniedReason, setDeniedReason] = useState(null)
  const [versions, setVersions] = useState(null)
  const busyRef = useRef(false)
  // Held from the approval so login can present it; never rendered.
  const secretRef = useRef(null)
  // The sign-in this flow already did against the camp. Handed on at Continue so
  // the director signs in once, not again on a second screen.
  const sessionRef = useRef(null)

  const cancel = useCallback(async () => {
    busyRef.current = false
    try {
      const result = await localClient.joinCancel()
      // T274 round 3 completion — joinCancel no longer THROWS on a failed
      // stop (main.js now returns {status:'stop_failed'} and deliberately
      // keeps its session reference alive rather than orphaning it — see
      // its own comment). Leaving this screen is still best-effort: never
      // block the director's exit over a teardown failure. But it must not
      // be silently absorbed as if cleanup had succeeded — logged so it is
      // at least visible, and the retained session itself remains reachable
      // by a later joinStart's own stop_failed handling (submitCode above),
      // which is what actually prevents a next attempt from silently
      // reusing it.
      if (result?.status === 'stop_failed') {
        console.error('join: could not confirm the previous session was stopped when leaving the join screen')
      }
    } catch {
      // Still best-effort against a genuine throw (e.g. no join in
      // progress) — nothing to surface for that case.
    }
  }, [])

  // Leaving mid-attempt (navigating away, the screen unmounting) must not strand a join: main
  // stops it, which after Pair again also restarts this device's sync.
  const stepRef = useRef(step)
  useEffect(() => { stepRef.current = step }, [step])
  useEffect(() => () => {
    if (stepRef.current !== STEP.code && stepRef.current !== STEP.joined) {
      localClient.joinCancel().catch(() => {})
    }
  }, [])

  const startOver = useCallback(async () => {
    await cancel()
    secretRef.current = null
    setError(null)
    setStep(STEP.code)
  }, [cancel])

  const goBack = useCallback(async () => {
    await cancel()
    onBack?.()
  }, [cancel, onBack])

  // Drives code -> find -> pair, stopping at whichever outcome is real.
  const submitCode = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    setStep(STEP.searching)
    try {
      const started = await localClient.joinStart(rejoin ? { code, rejoin: true } : { code })
      if (started.status === 'invalid_code') {
        // A typo, reported as a typo. Deriving a search from nonsense would
        // surface as "no camps found" and send them to check their network.
        setError("That code doesn't look right — it's 8 characters, like K4P7-2MRQ.")
        setStep(STEP.code)
        return
      }
      if (started.status === 'stop_failed') {
        // T274 round 3 completion — the PREVIOUS join attempt's temporary
        // session could not be torn down, so joinStart correctly refused to
        // start a new one rather than risk two live sessions. Falling
        // through to joinFindHost here would silently drive that stale
        // session instead of this new code — a failure reported as
        // something else. Stay put; a later retry gets another chance to
        // actually stop it (main.js's joinCancel keeps the reference alive
        // rather than losing it).
        setError("Couldn't finish closing the previous attempt yet — wait a moment and try again.")
        setStep(STEP.code)
        return
      }

      const found = await localClient.joinFindHost()
      if (found.status !== 'found') {
        setStep(STEP.notFound)
        return
      }

      const pairing = await localClient.joinRequestPairing()
      if (pairing.status === 'approved') {
        secretRef.current = pairing.deviceSecretIdentifier
        setStep(STEP.signIn)
        return
      }
      if (pairing.status === 'wrong_camp') {
        // A computer answered but could not prove it holds this code. Either
        // the code belongs to a different camp, or something on the network is
        // pretending to be a Host. Both are "don't continue".
        setStep(STEP.wrongCamp)
        return
      }
      if (pairing.status === 'not_this_camp') {
        setStep(STEP.notThisCamp)
        return
      }
      if (pairing.status === 'not_known_here') {
        setStep(STEP.notKnownHere)
        return
      }
      if (pairing.status === 'update_needed') {
        setVersions(pairing)
        setStep(STEP.updateNeeded)
        return
      }
      if (pairing.status === 'denied') {
        setDeniedReason(pairing.reason)
        setStep(STEP.denied)
        return
      }

      setStep(STEP.waitingForApproval)
      const decision = await localClient.joinAwaitPairingDecision()
      if (decision.status !== 'approved') {
        setDeniedReason(decision.reason)
        setStep(STEP.denied)
        return
      }
      secretRef.current = decision.deviceSecretIdentifier
      setStep(STEP.signIn)
    } catch (err) {
      setError(err?.message || "Something went wrong while joining. You can try again.")
      setStep(STEP.code)
    } finally {
      busyRef.current = false
    }
  }, [code, rejoin])

  const submitSignIn = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    try {
      const login = await localClient.joinLogin({
        name, pin, deviceSecretIdentifier: secretRef.current,
      })
      if (login.status === 'not_this_camp') {
        setStep(STEP.notThisCamp)
        return
      }
      if (login.status === 'tombstones_unverified') {
        setStep(STEP.erasureFailed)
        return
      }
      if (login.status !== 'ok') {
        setError(login.locked
          ? 'Too many tries. Wait a moment and try again.'
          : "That name and PIN didn't match. Try again.")
        return
      }

      sessionRef.current = { token: login.token, role: login.role }
      setStep(STEP.receiving)
      const data = await localClient.joinAwaitData()
      if (data.status !== 'ok') {
        // Signed in, but the camp's schedule never arrived. Under the old sync
        // this could not happen — identity and data came in one message — so
        // this state is new and must be named rather than spun on forever.
        setStep(STEP.noData)
        return
      }
      setCamp(data.camp)
      setStep(STEP.joined)
    } catch (err) {
      setError(err?.message || "Couldn't sign in. You can try again.")
    } finally {
      busyRef.current = false
    }
  }, [name, pin])

  return (
    <div style={{ ...S.authPage, position: 'relative', overflow: 'hidden' }}>
      <AuthWatermark />
      <div style={{ ...S.authCard, ...enter }}>
        {step !== STEP.joined && (
          <div style={S.authBackRow}>
            <button style={S.authBackBtn} onClick={goBack}>← Back</button>
          </div>
        )}

        {step === STEP.code && (
          <>
            <div style={S.authTitle}>{rejoin ? 'Pair again' : 'Camp code'}</div>
            <div style={S.authSubtitle}>
              {rejoin
                ? <>On a camp device that is on the camp's network: <strong>Device Manager</strong> → <strong>Add a device</strong>, then type its code here. Your changes on this device are kept.</>
                : <>On the device this camp was set up on: <strong>Device Manager</strong> → <strong>Add a device</strong>.</>}
            </div>
            <input
              style={codeInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitCode() }}
              placeholder="K4P7-2MRQ"
              aria-label="Camp code"
              autoFocus
            />
            {error && <div style={S.authErrorBox}>{error}</div>}
            <button style={S.authBtnPrimary} onClick={submitCode}>Continue</button>
          </>
        )}

        {step === STEP.searching && (
          <Waiting title="Looking for your camp…" />
        )}

        {step === STEP.notFound && (
          <Outcome
            title="No camp answered that code"
            body={<>Check the code, that <strong>Add a device</strong> is still open on the device this camp was set up on, and that both are on the same Wi-Fi.</>}
            actionLabel="Try again"
            onAction={startOver}
          />
        )}

        {step === STEP.wrongCamp && (
          <Outcome
            title="That computer couldn't confirm the code"
            body={<>A computer answered but couldn't prove it belongs to this camp. Check the code.</>}
            actionLabel="Start over"
            onAction={startOver}
          />
        )}

        {step === STEP.notThisCamp && (
          <Outcome
            title="That code is for a different camp"
            body={<>This device can only pair again with its own camp. Get the code from a device in that camp.</>}
            actionLabel="Start over"
            onAction={startOver}
          />
        )}

        {step === STEP.notKnownHere && (
          <Outcome
            title="That device doesn't know this one yet"
            body={<>This device can only pair again through a camp device that approved it before. Read the code off that device, or ask a director.</>}
            actionLabel="Start over"
            onAction={startOver}
          />
        )}

        {step === STEP.updateNeeded && (
          <Outcome
            title={versions?.hostSchemaVersion > versions?.localSchemaVersion ? 'Update Shoresh on this device first' : 'Update Shoresh on the camp device first'}
            body={<>The two devices run different versions of Shoresh and can't share changes until they match. Update, then pair again. Nothing was approved.</>}
            actionLabel="Start over"
            onAction={startOver}
          />
        )}

        {step === STEP.erasureFailed && (
          <Outcome
            title="Couldn't apply the camp's erasures"
            body={<>The camp erased records while this device was away, and this device couldn't confirm those erasures came from the camp. Nothing was merged. Ask a director to remove this device and add it as a new one.</>}
            actionLabel="Back to devices"
            onAction={goBack}
          />
        )}

        {step === STEP.denied && deniedReason === 'device_revoked' && (
          <Outcome
            title="This device was removed from the camp"
            body={<>A director removed it, so it can't pair again. To use it in this camp, a director adds it as a new device.</>}
            actionLabel="Back to devices"
            onAction={goBack}
          />
        )}

        {step === STEP.waitingForApproval && (
          <Waiting
            title="Waiting for approval"
            note="Approve it on the device that showed the code. This screen moves on by itself."
            onCancel={startOver}
          />
        )}

        {step === STEP.denied && deniedReason !== 'device_revoked' && (
          <Outcome
            title={deniedReason === 'pairing-requires-local-network' ? "Not on the camp's network" : "This device wasn't allowed in"}
            body={deniedReason === 'pairing-requires-local-network'
              ? <>Join the same Wi-Fi/LAN as the device that showed the code. VPN, Tailscale and mobile connections can't pair.</>
              : <>The request was turned down on the device that showed the code.</>}
            actionLabel="Try again"
            onAction={startOver}
          />
        )}

        {step === STEP.signIn && (
          <>
            <div style={S.authTitle}>Sign in</div>
            <div style={S.authSubtitle}>Use the same name and PIN you use on your other devices in this camp.</div>
            <label htmlFor="join-name" style={{ ...S.authLabel, marginTop: 0 }}>Name</label>
            <input
              id="join-name"
              style={S.authField}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              autoFocus
            />
            <label htmlFor="join-pin" style={S.authLabel}>PIN</label>
            <input
              id="join-pin"
              style={S.authField}
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSignIn() }}
              placeholder="PIN"
              aria-label="PIN"
            />
            {error && <div style={S.authErrorBox}>{error}</div>}
            <button style={S.authBtnPrimary} onClick={submitSignIn}>Sign in</button>
          </>
        )}

        {step === STEP.receiving && (
          <Waiting title="Getting your camp…" />
        )}

        {step === STEP.noData && (
          <Outcome
            title="Signed in, but nothing arrived"
            body={<>Allowed in, but no schedule came through. Check that a device already in this camp is on and on the same Wi-Fi.</>}
            actionLabel="Try again"
            onAction={startOver}
          />
        )}

        {step === STEP.joined && (
          <>
            {/* The point of the whole design: the camp's name, revealed at the
                first moment it can be, so recognition is something the director
                CONFIRMS rather than something they took on faith from an
                address. */}
            <div style={S.authTitle}>{rejoin ? `Back in ${camp?.name}` : `Joined ${camp?.name}`}</div>
            <div style={S.authSubtitle}>{rejoin ? 'Your changes from this device are merged in.' : "You won't need the code again."}</div>
            <button style={S.authBtnPrimary} onClick={() => onJoined?.(camp, sessionRef.current)}>Continue</button>
          </>
        )}
      </div>
    </div>
  )
}

function Waiting({ title, note, onCancel }) {
  return (
    <>
      <div style={S.authTitle}>{title}</div>
      {note && <div style={S.authSubtitle}>{note}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '22px 0', justifyContent: 'center' }}>
        <Spinner />
      </div>
      {onCancel && (
        <button style={S.authLinkBtn} onClick={onCancel}>Cancel</button>
      )}
    </>
  )
}

function Outcome({ title, body, actionLabel, onAction }) {
  return (
    <>
      <div style={S.authTitle}>{title}</div>
      <div style={{ ...S.authSubtitle, lineHeight: 1.7 }}>{body}</div>
      <button style={S.authBtnPrimary} onClick={onAction}>{actionLabel}</button>
    </>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: '50%',
      border: '2px solid var(--border)', borderTopColor: 'var(--primary)',
      animation: 'shoresh-spin 0.8s linear infinite',
    }}>
      <style>{'@keyframes shoresh-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  )
}

// Sized and tracked to be typed into from a code read across a room, and to
// make a transposed character visible before Continue is pressed.
const codeInput = {
  width: '100%',
  padding: '14px 16px',
  fontSize: 26,
  fontFamily: 'var(--font-mono)',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textAlign: 'center',
  textTransform: 'uppercase',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface)',
  color: 'var(--text)',
  marginBottom: 14,
  boxSizing: 'border-box',
}
