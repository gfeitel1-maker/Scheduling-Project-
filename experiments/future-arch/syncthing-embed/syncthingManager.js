'use strict';
/*
 * syncthingManager.js — main-process module that spawns a Syncthing binary
 * headless and controls it entirely over its local REST API.
 *
 * This is the spike's proven logic (experiments/future-arch/syncthing-spike.cjs)
 * adapted into a reusable class: same flags, same fsWatcherDelayS=1 tuning, same
 * shutdown sequence. No Syncthing window/tray/browser is ever opened — headless,
 * REST-only control, exactly what the spike proved works.
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SyncthingManager {
  /**
   * @param {object} opts
   * @param {string} opts.bin - path to the syncthing binary
   * @param {string} opts.home - Syncthing config/data home dir
   * @param {string} opts.folderPath - the shared folder's path on disk
   * @param {string} [opts.folderId] - folder id, MUST match on both machines
   * @param {number} [opts.port] - GUI/API port
   * @param {string} [opts.apiKey] - REST API key (random if omitted)
   */
  constructor(opts) {
    this.bin = opts.bin;
    this.home = path.resolve(opts.home);
    this.folderPath = path.resolve(opts.folderPath);
    this.folderId = opts.folderId || 'shoresh';
    this.port = opts.port || 8384;
    this.apiKey = opts.apiKey || crypto.randomBytes(16).toString('hex');
    this.child = null;
    this.myID = null;
    this.shuttingDown = false;
  }

  _api(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path: apiPath,
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
            ...(data ? { 'Content-Length': data.length } : {}),
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(buf ? JSON.parse(buf) : {});
              } catch {
                resolve({});
              }
            } else {
              reject(new Error(`${method} ${apiPath} -> ${res.statusCode}: ${buf.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async _waitForApi(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this._api('GET', '/rest/system/ping');
        return true;
      } catch {
        // not up yet
      }
      await sleep(400);
    }
    throw new Error('Syncthing REST API did not come up in time');
  }

  /** Spawn Syncthing headless (no window/tray/browser) and wait for its API. */
  async start() {
    fs.mkdirSync(this.home, { recursive: true });
    fs.mkdirSync(this.folderPath, { recursive: true });

    const gui = `127.0.0.1:${this.port}`;
    const stArgs = [
      'serve',
      '--home', this.home,
      '--no-browser',
      '--no-default-folder',
      '--gui-address', gui,
      '--gui-apikey', this.apiKey,
    ];
    this.child = spawn(this.bin, stArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => {
      if (this.onLog) this.onLog('stdout', d.toString());
    });
    this.child.stderr.on('data', (d) => {
      if (this.onLog) this.onLog('stderr', d.toString());
    });
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.onExit) this.onExit(code);
    });

    await this._waitForApi();
    const status = await this._api('GET', '/rest/system/status');
    this.myID = status.myID;
    return this.myID;
  }

  /** Create/replace the shared folder, optionally including a peer device. */
  async configureFolder(peerId) {
    const devices = [{ deviceID: this.myID }];
    if (peerId) {
      await this._api('PUT', '/rest/config/devices/' + peerId, {
        deviceID: peerId,
        name: 'peer',
        addresses: ['dynamic'],
      });
      devices.push({ deviceID: peerId });
    }
    await this._api('PUT', '/rest/config/folders/' + this.folderId, {
      id: this.folderId,
      label: 'Shoresh prototype',
      path: this.folderPath,
      type: 'sendreceive',
      fsWatcherEnabled: true,
      fsWatcherDelayS: 1,
      devices,
    });
  }

  /** Add a peer device after startup (e.g. pasted in from the UI). */
  async addPeer(peerId) {
    await this._api('PUT', '/rest/config/devices/' + peerId, {
      deviceID: peerId,
      name: 'peer',
      addresses: ['dynamic'],
    });
    const folder = await this._api('GET', '/rest/config/folders/' + this.folderId);
    const devices = folder.devices || [{ deviceID: this.myID }];
    if (!devices.some((d) => d.deviceID === peerId)) {
      devices.push({ deviceID: peerId });
    }
    await this._api('PUT', '/rest/config/folders/' + this.folderId, {
      ...folder,
      devices,
    });
  }

  /** Read connection + folder-completion status for a given peer id. */
  async getStatus(peerId) {
    const result = {
      myID: this.myID,
      running: !!this.child,
      peerConnected: false,
      peerVia: null,
      folderCompletion: null,
    };
    if (!peerId || !this.child) return result;
    try {
      const conns = await this._api('GET', '/rest/system/connections');
      const c = conns.connections && conns.connections[peerId];
      if (c) {
        result.peerConnected = !!c.connected;
        result.peerVia = c.type ? (/relay/i.test(c.type) ? 'relay' : 'direct') : null;
      }
      if (result.peerConnected) {
        try {
          const comp = await this._api(
            'GET',
            `/rest/db/completion?folder=${this.folderId}&device=${peerId}`
          );
          result.folderCompletion = comp.completion != null ? Math.round(comp.completion) : null;
        } catch {
          // completion may 404 until first index exchange
        }
      }
    } catch {
      // API not reachable right now
    }
    return result;
  }

  /** Ask Syncthing to shut down cleanly; kill the process if it doesn't. */
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.child) return;
    try {
      await this._api('POST', '/rest/system/shutdown');
    } catch {
      this.child.kill();
      return;
    }
    await sleep(1500);
    if (this.child) this.child.kill();
  }
}

module.exports = { SyncthingManager };
