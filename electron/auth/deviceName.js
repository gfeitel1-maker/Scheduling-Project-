export const DEFAULT_DEVICE_NAME = 'This computer'
export const DEVICE_NAME_MAX = 40

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

export function normalizeDeviceName(raw) {
  if (typeof raw !== 'string') throw new Error('A device name is required.')
  const name = raw.replace(CONTROL_CHARS, '').trim()
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
