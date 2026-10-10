// T340 switch-on: the WAN ladder is ON by default in packaged builds only. Resolved once, in main.js,
// before sync starts, so syncStarter.js keeps reading SHORESH_PUNCH_ENABLED once with strict equality.
// Lives outside electron/sync/** because the Worker URL is a hard-coded URL the Tier-4 egress scan
// would flag there; rendezvousClient.js remains the only file that performs the egress.
export const DEFAULT_RENDEZVOUS_URL = 'https://shoresh-rendezvous.jays-lives-dev.workers.dev'

export function applyPackagedWanDefaults(env, isPackaged) {
  if (!isPackaged) return
  if (env.SHORESH_PUNCH_ENABLED === undefined) env.SHORESH_PUNCH_ENABLED = 'true'
  // An explicit empty string means "rungs 1-2 only"; only a truly unset value takes the default.
  if (env.SHORESH_PUNCH_ENABLED === 'true' && env.SHORESH_RENDEZVOUS_URL === undefined) {
    env.SHORESH_RENDEZVOUS_URL = DEFAULT_RENDEZVOUS_URL
  }
}
