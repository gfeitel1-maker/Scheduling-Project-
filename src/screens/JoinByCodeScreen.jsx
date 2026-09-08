import { useCallback, useRef, useState } from 'react'
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
  waitingForApproval: 'waitingForApproval',
  denied: 'denied',
  signIn: 'signIn',
  receiving: 'receiving',
  noData: 'noData',
  joined: 'joined',
}

export default function JoinByCodeScreen({ onBack, onJoined }) {
  const enter = useEnterTransition('liftFade')
  const [step, setStep] = useState(STEP.code)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [camp, setCamp] = useState(null)
  const busyRef = useRef(false)
  // Held from the approval so login can present it; never rendered.
  const secretRef = useRef(null)

  const cancel = useCallback(async () => {
    busyRef.current = false
    try {
      await localClient.joinCancel()
    } catch {
      // Cancelling is best-effort: the director is leaving this screen either
      // way, and a failure to tear down a session they are abandoning is not
      // something to put in front of them.
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
      const started = await localClient.joinStart({ code })
      if (started.status === 'invalid_code') {
        // A typo, reported as a typo. Deriving a search from nonsense would
        // surface as "no camps found" and send them to check their network.
        setError("That code doesn't look right — it's 8 characters, like K4P7-2MRQ.")
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
      if (pairing.status === 'denied') {
        setStep(STEP.denied)
        return
      }

      setStep(STEP.waitingForApproval)
      const decision = await localClient.joinAwaitPairingDecision()
      if (decision.status !== 'approved') {
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
  }, [code])

  const submitSignIn = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    try {
      const login = await localClient.joinLogin({
        name, pin, deviceSecretIdentifier: secretRef.current,
      })
      if (login.status !== 'ok') {
        setError(login.locked
          ? 'Too many tries. Wait a moment and try again.'
          : "That name and PIN didn't match. Try again.")
        return
      }

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
    <div style={S.authPage}>
      <div style={{ ...S.authCard, ...enter }}>
        {step !== STEP.joined && (
          <div style={S.authBackRow}>
            <button style={S.authBackBtn} onClick={goBack}>← Back</button>
          </div>
        )}

        {step === STEP.code && (
          <>
            <div style={S.authEyebrow}>Join a camp</div>
            <div style={S.authTitle}>Enter the code from your camp's computer</div>
            <div style={S.authSubtitle}>
              On the main computer, open <strong>Device Manager</strong> and choose <strong>Add a device</strong>. It will show you a code.
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
          <Waiting title="Looking for your camp…" note="Make sure this device is on the same Wi-Fi as the main computer." />
        )}

        {step === STEP.notFound && (
          <Outcome
            title="No camp answered that code"
            body={<>Check that:<br />• the code matches what the main computer is showing<br />• someone chose <strong>Add a device</strong> there, and that screen is still open<br />• both devices are on the same Wi-Fi</>}
            actionLabel="Try again"
            onAction={startOver}
          />
        )}

        {step === STEP.wrongCamp && (
          <Outcome
            title="That computer couldn't confirm the code"
            body={<>A computer answered, but it couldn't prove it belongs to this camp. Double-check the code on the main computer before trying again.</>}
            actionLabel="Start over"
            onAction={startOver}
          />
        )}

        {step === STEP.waitingForApproval && (
          <Waiting
            title="Waiting for approval"
            note="Someone at the main computer needs to allow this device in. This screen will move on by itself."
            onCancel={startOver}
          />
        )}

        {step === STEP.denied && (
          <Outcome
            title="This device wasn't allowed in"
            body={<>Whoever is at the main computer turned down the request. You can ask them and try again.</>}
            actionLabel="Try again"
            onAction={startOver}
          />
        )}

        {step === STEP.signIn && (
          <>
            <div style={S.authEyebrow}>Almost there</div>
            <div style={S.authTitle}>Sign in</div>
            <div style={S.authSubtitle}>Use the same name and PIN you use on the main computer.</div>
            <label style={{ ...S.authLabel, marginTop: 0 }}>Name</label>
            <input
              style={S.authField}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              autoFocus
            />
            <label style={S.authLabel}>PIN</label>
            <input
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
          <Waiting title="Getting your camp's schedule…" note="This usually takes a few seconds." />
        )}

        {step === STEP.noData && (
          <Outcome
            title="Signed in, but nothing arrived"
            body={<>This device was allowed in, but the camp's schedule didn't come through. Check that the main computer is still on and on the same Wi-Fi, then try again.</>}
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
            <div style={S.authEyebrow}>Done</div>
            <div style={S.authTitle}>You've joined {camp?.name}</div>
            <div style={S.authSubtitle}>
              This device is now part of {camp?.name}. It will find the camp on its own from now on — you won't need the code again.
            </div>
            <button style={S.authBtnPrimary} onClick={() => onJoined?.(camp)}>Continue</button>
          </>
        )}
      </div>
    </div>
  )
}

function Waiting({ title, note, onCancel }) {
  return (
    <>
      <div style={S.authEyebrow}>Join a camp</div>
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
      <div style={S.authEyebrow}>Join a camp</div>
      <div style={S.authTitle}>{title}</div>
      <div style={{ ...S.authSubtitle, lineHeight: 1.7 }}>{body}</div>
      <button style={S.authBtnPrimary} onClick={onAction}>{actionLabel}</button>
    </>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%',
      border: '2.5px solid var(--border)', borderTopColor: 'var(--primary)',
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
