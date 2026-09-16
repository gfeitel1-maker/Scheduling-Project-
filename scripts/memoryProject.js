// The Node half of scripts/memoryProject.sh — same default, same override, so the
// two languages cannot drift about where the live memory store lives (T171 item 4).
//
// See memoryProject.sh for why this is a constant and not a computation: the slug
// names the directory a session was first started from, which is no longer where
// the repo is, and the store must not move.
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_MEMORY_PROJECT_SLUG =
  '-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project'

export function memoryProjectSlug(env = process.env) {
  return env.SHORESH_MEMORY_PROJECT || DEFAULT_MEMORY_PROJECT_SLUG
}

export function memoryProjectDir(env = process.env, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', memoryProjectSlug(env))
}
