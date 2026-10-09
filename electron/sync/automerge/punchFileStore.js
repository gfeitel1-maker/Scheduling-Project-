// Shared persistence for the two rung-2 file stores (punchGossip's highWater, punchSignaling's
// replay memory). Both hold [string, finite number] pairs. A missing file is a normal first run;
// anything else that stops the file loading is returned to the caller, which must fail closed.
import fs from 'node:fs'

export function loadPairs(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    return err?.code === 'ENOENT' ? { pairs: [], error: null } : { pairs: [], error: err }
  }
  try {
    const pairs = JSON.parse(text)
    const ok = Array.isArray(pairs) && pairs.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && Number.isFinite(p[1]))
    if (!ok) throw new Error('store file is not a list of [string, number] pairs')
    return { pairs, error: null }
  } catch (err) {
    return { pairs: [], error: err }
  }
}

// Temp file, fsync, rename: a crash leaves the old file or the new one, never a torn one.
// Returns the Error on failure (and warns) so the caller can surface it; never throws.
export function savePairs(filePath, pairs) {
  const tmp = `${filePath}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, JSON.stringify(pairs))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filePath)
    return null
  } catch (err) {
    console.warn(`punch store: failed to write ${filePath}: ${err?.message ?? err}`)
    return err
  }
}

export function warnLoadFailure(filePath, error) {
  console.warn(`punch store: ${filePath} is unreadable or corrupt (${error?.message ?? error}); refusing entries until it is repaired`)
}
