// Owns "the current sync starter" across a db swap. A starter closes over one db and one deviceId,
// so a project switch / backup restore must stop the old node and build a fresh starter for the
// new db; every makeHandlers call site reads its sync options from handlerOptions() so the
// starter callbacks cannot be wired differently at different sites.
export function createSyncStarterHolder(makeStarter) {
  let starter = makeStarter()

  async function shutdown() {
    const punch = starter.shutdownPunch().catch(() => {})
    const node = starter.getNode()
    if (node) {
      try { await node.stop() } catch { /* the old db is being closed anyway */ }
    }
    await punch
  }

  return {
    getNode: () => starter.getNode(),
    start: () => starter.start(),
    shutdown,
    async replace() {
      await shutdown()
      starter = makeStarter()
    },
    handlerOptions: () => ({
      getAutomergeSyncNode: () => starter.getNode(),
      getAutomergeStartupAttempted: () => starter.getStartupAttempted(),
      getRelayReservationRefused: () => starter.getRelayReservationRefused(),
      onCampBootstrapped: () => starter.start(),
      onCampJoined: () => starter.start(),
      retrySync: () => starter.start(),
    }),
  }
}
