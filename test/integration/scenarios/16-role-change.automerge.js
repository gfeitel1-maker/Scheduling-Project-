/**
 * Scenario 16 (libp2p): a role change takes effect immediately, with no token
 * re-issue and no restart.
 *
 * WHAT SURVIVED THE PORT, AND WHAT DID NOT — read this before adding to it.
 *
 * The WS original asserted TWO things at once: that `authorize()` re-reads the
 * database on every call (so a role change is felt immediately), and that the
 * HOST re-checked each incoming operation, so a demoted device could not push
 * an over-privileged write across the wire.
 *
 * The first is unchanged and is what this scenario asserts.
 *
 * The second **no longer exists**, and that is a recorded, owner-accepted
 * tradeoff rather than a gap to test around: under CRDT sync a device does not
 * submit operations for the Host to judge — it writes into its own document and
 * the documents merge. See SECURITY.md, "Role enforcement is device-side under
 * CRDT sync", and docs/work/evidence/2026-09-08-crdt-removes-host-side-authorization.md.
 *
 * Asserting the second here would be asserting something the system no longer
 * claims. Asserting only the first, without saying why, would quietly look like
 * the port had lost coverage. Hence this comment.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs } from '../harnessAutomerge.js'
import { authorize } from '../../../electron/auth/authorize.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap({ adminName: 'alice', adminPin: '1234' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host, { name: 'alice', pin: '1234' })

    // The device holds a token minted while alice was an admin. Nothing below
    // re-issues it — that is the point.
    const token = client.token
    const adminOnly = { db: host.db, token, action: 'devices.approve' }

    if (!authorize(adminOnly).allowed) {
      throw new Error('an admin should be allowed an admin-only action')
    }

    // Demote, with the token untouched.
    host.db.prepare("UPDATE users SET role = 'staff' WHERE name = 'alice'").run()

    const afterDemotion = authorize(adminOnly)
    if (afterDemotion.allowed) {
      throw new Error('a demoted user was still allowed an admin-only action on the same token')
    }

    // And back again, still the same token — the check is a fresh read, not a
    // one-way latch.
    host.db.prepare("UPDATE users SET role = 'admin' WHERE name = 'alice'").run()
    if (!authorize(adminOnly).allowed) {
      throw new Error('re-promoting did not restore the admin-only action')
    }

    // A staff-permitted action stays allowed throughout — the demotion narrows
    // what the token can do, it does not invalidate it.
    host.db.prepare("UPDATE users SET role = 'staff' WHERE name = 'alice'").run()
    if (!authorize({ db: host.db, token, action: 'activities.write' }).allowed) {
      throw new Error('a demoted user lost an action their new role still permits')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
