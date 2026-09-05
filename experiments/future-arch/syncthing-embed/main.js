'use strict';
/*
 * main.js — Electron main process for the syncthing-embed prototype.
 *
 * On ready: spawns a bundled Syncthing binary headless via SyncthingManager,
 * waits for its REST API, configures the shared "shoresh" folder, and (if a
 * peer id is supplied via env) adds it. Never opens Syncthing's own UI — only
 * this prototype's window. Status is polled and pushed to the renderer over
 * IPC. On quit, shuts Syncthing down cleanly so no orphan process is left.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SyncthingManager } = require('./syncthingManager');
const project = require('../project.cjs');

const FOLDER_ID = 'shoresh';
const STATUS_POLL_MS = 2000;
const STATE_POLL_MS = 2000;

/** Stable per-install device id for the op-flow engine (distinct from the Syncthing device id). */
function resolveShoreshDeviceId(userData) {
  const idFile = path.join(userData, 'shoresh-device-id.txt');
  if (fs.existsSync(idFile)) return fs.readFileSync(idFile, 'utf8').trim();
  const id = require('os').hostname() + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(idFile, id);
  return id;
}

function resolveSyncthingBin() {
  if (process.env.SYNCTHING_BIN) return process.env.SYNCTHING_BIN;
  const local = path.join(
    __dirname,
    'bin',
    process.platform === 'win32' ? 'syncthing.exe' : 'syncthing'
  );
  if (fs.existsSync(local)) return local;
  return null;
}

const userData = app.getPath('userData');
const manager = new SyncthingManager({
  bin: resolveSyncthingBin() || 'syncthing',
  home: path.join(userData, 'syncthing-home'),
  folderPath: path.join(userData, 'shoresh-sync'),
  folderId: FOLDER_ID,
  port: parseInt(process.env.SYNCTHING_PORT || '8384', 10),
});

let mainWindow = null;
let statusTimer = null;
let stateTimer = null;
let peerId = process.env.SYNCTHING_PEER || null;
let shoreshInstance = null;

/** P3: open (or create, idempotently) the .shoresh package inside the synced folder. */
function ensureShoreshInstance() {
  const packageDir = path.join(manager.folderPath, 'test-project.shoresh');
  const proj = project.createProject(packageDir, { name: 'Syncthing-embed prototype' });
  const dbPath = path.join(userData, 'shoresh-local.sqlite');
  const deviceId = resolveShoreshDeviceId(userData);
  shoreshInstance = project.openInstance(proj, dbPath, deviceId);
}

function pushState() {
  if (!mainWindow || !shoreshInstance) return;
  project.sync(shoreshInstance);
  const snapshot = project.snapshotState(shoreshInstance.db);
  mainWindow.webContents.send('shoresh:state', {
    entities: snapshot.rows,
    hash: snapshot.hash,
    conflicts: project.pendingConflicts(shoreshInstance.db),
  });
}

function pushStatus() {
  if (!mainWindow) return;
  manager.getStatus(peerId).then((status) => {
    mainWindow.webContents.send('syncthing:status', status);
  });
}

async function startSyncthing() {
  const bin = resolveSyncthingBin();
  if (!bin) {
    if (mainWindow) {
      mainWindow.webContents.send('syncthing:status', {
        error: 'No Syncthing binary found. Set SYNCTHING_BIN or drop one in ./bin — see RUN.md.',
      });
    }
    return;
  }
  await manager.start();
  await manager.configureFolder(peerId);
  statusTimer = setInterval(pushStatus, STATUS_POLL_MS);
  pushStatus();

  ensureShoreshInstance();
  stateTimer = setInterval(pushState, STATE_POLL_MS);
  pushState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 420,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

ipcMain.handle('syncthing:getStatus', async () => manager.getStatus(peerId));

ipcMain.handle('syncthing:addPeer', async (_event, newPeerId) => {
  peerId = newPeerId;
  await manager.addPeer(peerId);
  const status = await manager.getStatus(peerId);
  return status;
});

ipcMain.handle('shoresh:edit', async (_event, { entityId, field, value }) => {
  if (!shoreshInstance) return { error: 'shoresh instance not ready yet' };
  project.edit(shoreshInstance, { entityId, field, value });
  pushState();
  return { ok: true };
});

ipcMain.handle('shoresh:state', async () => {
  if (!shoreshInstance) return { entities: [], hash: null, conflicts: [] };
  project.sync(shoreshInstance);
  const snapshot = project.snapshotState(shoreshInstance.db);
  return {
    entities: snapshot.rows,
    hash: snapshot.hash,
    conflicts: project.pendingConflicts(shoreshInstance.db),
  };
});

app.whenReady().then(() => {
  createWindow();
  startSyncthing();
});

async function shutdownAndQuit() {
  if (statusTimer) clearInterval(statusTimer);
  if (stateTimer) clearInterval(stateTimer);
  await manager.shutdown();
}

app.on('window-all-closed', async () => {
  await shutdownAndQuit();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!manager.shuttingDown) {
    event.preventDefault();
    await shutdownAndQuit();
    app.quit();
  }
});
