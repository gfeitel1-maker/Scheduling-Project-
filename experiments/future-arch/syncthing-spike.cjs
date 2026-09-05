'use strict';
/*
 * syncthing-spike.cjs — prove Shoresh can run + control Syncthing INVISIBLY.
 *
 * Pure Node (http + child_process), no npm install. It spawns a Syncthing binary
 * with its own config, waits for its local REST API, then drives it entirely over
 * that API: reads this device's id, creates the shared folder, adds the peer device.
 * No Syncthing window, tray, or browser is ever opened — exactly what the Electron
 * main process would do when Syncthing is bundled inside Shoresh.
 *
 *   node syncthing-spike.cjs run --bin <path-to-syncthing> --home ./st-a \
 *        --folder ./shoresh-sync-a [--peer <PEER DEVICE ID>] [--port 8384] [--folderid shoresh]
 *
 * See SYNCTHING_SPIKE.md for the two-machine flow. This driver is written from
 * Syncthing's documented REST API; treat the first live run as part of the spike.
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
if (process.argv[2] !== 'run') {
  console.log('usage: node syncthing-spike.cjs run --bin <syncthing> --home <dir> --folder <dir> [--peer <id>] [--port 8384] [--folderid shoresh]');
  process.exit(process.argv[2] ? 2 : 0);
}

const BIN = arg('bin', 'syncthing');           // path to the syncthing binary (or on PATH)
const HOME = path.resolve(arg('home', './st-home'));
const FOLDER = path.resolve(arg('folder', './shoresh-sync'));
const PEER = arg('peer', null);
const PORT = parseInt(arg('port', '8384'), 10);
const FOLDER_ID = arg('folderid', 'shoresh');  // MUST match on both machines
const APIKEY = arg('apikey', crypto.randomBytes(16).toString('hex'));
const GUI = `127.0.0.1:${PORT}`;

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(FOLDER, { recursive: true });

// --- tiny REST client for Syncthing's local API -----------------------------
function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path: apiPath,
        headers: { 'X-API-Key': APIKEY, 'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': data.length } : {}) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
          } else reject(new Error(`${method} ${apiPath} -> ${res.statusCode}: ${buf.slice(0, 200)}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForApi(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await api('GET', '/rest/system/ping'); return true; } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('Syncthing REST API did not come up in time');
}

// --- launch Syncthing (hidden: no browser, no default folder) ----------------
// Modern flag form. If your binary is older and this fails to start, try the
// legacy form:  <bin> --home <HOME> --no-browser --gui-address <GUI> --gui-apikey <KEY>
const stArgs = ['serve', '--home', HOME, '--no-browser', '--no-default-folder',
  '--gui-address', GUI, '--gui-apikey', APIKEY];
console.log(`Starting Syncthing (hidden): ${BIN} ${stArgs.join(' ')}`);
const child = spawn(BIN, stArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write('  [syncthing] ' + d));
child.stderr.on('data', (d) => process.stderr.write('  [syncthing!] ' + d));
child.on('exit', (code) => {
  console.log(`Syncthing exited (code ${code}). If it exited immediately, the CLI flags may`);
  console.log(`differ for your version — see the legacy form noted in this file.`);
  process.exit(code || 0);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  console.log('\nShutting down Syncthing…');
  try { await api('POST', '/rest/system/shutdown'); } catch { child.kill(); }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- orchestrate: read my id, create folder, add peer -----------------------
(async () => {
  await waitForApi();
  const status = await api('GET', '/rest/system/status');
  const myID = status.myID;
  console.log('\n========================================================');
  console.log('  MY DEVICE ID:  ' + myID);
  console.log('  (give this to the other machine as --peer)');
  console.log('========================================================\n');

  const folderDevices = [{ deviceID: myID }];
  if (PEER) {
    // Add the peer device BEFORE referencing it in the folder.
    await api('PUT', '/rest/config/devices/' + PEER, {
      deviceID: PEER, name: 'peer', addresses: ['dynamic'],
    });
    folderDevices.push({ deviceID: PEER });
    console.log('Added peer device ' + PEER.slice(0, 12) + '…');
  } else {
    console.log('No --peer given yet — folder created locally; relaunch with --peer once you have the other id.');
  }

  // Create/replace the shared folder (same FOLDER_ID on both machines is required).
  await api('PUT', '/rest/config/folders/' + FOLDER_ID, {
    id: FOLDER_ID, label: 'Shoresh project', path: FOLDER,
    type: 'sendreceive', fsWatcherEnabled: true, fsWatcherDelayS: 1,
    devices: folderDevices,
  });
  console.log(`Sharing folder "${FOLDER_ID}" at ${FOLDER}` + (PEER ? ' with the peer.' : ' (self only).'));

  // --- status loop: connected? via relay or direct? folder synced? ----------
  console.log('\nStatus (Ctrl-C to stop):');
  setInterval(async () => {
    try {
      const conns = await api('GET', '/rest/system/connections');
      let line;
      if (PEER && conns.connections && conns.connections[PEER]) {
        const c = conns.connections[PEER];
        const via = c.type ? (/relay/i.test(c.type) ? 'RELAY' : 'DIRECT') : '?';
        let completion = '?';
        try {
          const comp = await api('GET', `/rest/db/completion?folder=${FOLDER_ID}&device=${PEER}`);
          completion = (comp.completion != null ? Math.round(comp.completion) : '?') + '%';
        } catch { /* completion may 404 until first index exchange */ }
        line = c.connected ? `peer CONNECTED via ${via}, folder ${completion} synced` : 'peer not connected yet (still finding each other via discovery/relay)…';
      } else {
        line = PEER ? 'waiting for peer to connect…' : 'waiting for a --peer to be configured…';
      }
      process.stdout.write('\r  ' + line + '                    ');
    } catch (e) {
      process.stdout.write('\r  status error: ' + e.message + '        ');
    }
  }, 3000);
})().catch((e) => { console.error('spike error:', e.message); shutdown(); });
