// The Node half of scripts/memoryProject.sh — same default, same override, so the
// two languages cannot drift about where the live memory store lives (T171 item 4).
//
// See memoryProject.sh for why this is a constant and not a computation: the slug
// names the directory a session was first started from, which is no longer where
// the repo is, and the store must not move.
import path from 'node:path'
import os from 'node:os'

// Claude Code names a project directory after the path a session was started from, by
// replacing every '/' with '-'. Shared with memoryProject.sh and observeRun.js (T263) so
// nothing else needs to hardcode a developer's home path to reproduce that transform.
export function homeDerivedSlugPrefix(home = os.homedir()) {
  return home.replace(/\//g, '-')
}

// Fixed, non-identifying — the directory name this store was first created under.
export const MEMORY_PROJECT_SUFFIX = '-Desktop-Camp-App-System--Applications-Schedule-Project'

export function defaultMemoryProjectSlug(home = os.homedir()) {
  return homeDerivedSlugPrefix(home) + MEMORY_PROJECT_SUFFIX
}

// Value-preserving: this evaluates to exactly the prior hardcoded literal on this machine,
// since it is this machine's own $HOME driving the derivation.
export const DEFAULT_MEMORY_PROJECT_SLUG = defaultMemoryProjectSlug()

export function memoryProjectSlug(env = process.env) {
  return env.SHORESH_MEMORY_PROJECT || DEFAULT_MEMORY_PROJECT_SLUG
}

export function memoryProjectDir(env = process.env, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', memoryProjectSlug(env))
}
