export const DEFAULT_DEVICE_NAME = 'This computer'
export const DEVICE_NAME_MAX = 40

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
// Bidi overrides/isolates and zero-width characters: invisible, and able to make one name read
// as another (an RTL override can disguise a peer as "Director's iPad").
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

function stripUnsafe(raw) {
  return raw.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim()
}

export function normalizeDeviceName(raw) {
  if (typeof raw !== 'string') throw new Error('A device name is required.')
  const name = stripUnsafe(raw)
  if (name === '') throw new Error('A device name cannot be empty.')
  if (name.length > DEVICE_NAME_MAX) throw new Error(`A device name can be at most ${DEVICE_NAME_MAX} characters.`)
  return name
}

// A device still on the seeded default introduces itself as "Device ab12" so the approver never
// sees two rows both called "This computer". A name the director chose is sent as chosen.
export function pairingDeviceName(storedName, deviceId) {
  if (!storedName || storedName === DEFAULT_DEVICE_NAME) return `Device ${deviceId.slice(0, 4)}`
  return storedName
}

// A name arriving in a peer's pairing request is untrusted: strip it the same way, cap it, and
// never reject the request over it (an unusable name falls back to Device <first 4 of id>).
export function sanitizePeerDeviceName(raw, deviceId) {
  const name = typeof raw === 'string' ? stripUnsafe(raw).slice(0, DEVICE_NAME_MAX).trim() : ''
  return name || `Device ${String(deviceId).slice(0, 4)}`
}
