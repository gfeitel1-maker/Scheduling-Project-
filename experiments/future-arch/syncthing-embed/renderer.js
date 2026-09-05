'use strict';

const myIdEl = document.getElementById('myId');
const statusEl = document.getElementById('status');
const completionEl = document.getElementById('completion');
const errorEl = document.getElementById('error');
const peerInput = document.getElementById('peerInput');
const addPeerBtn = document.getElementById('addPeerBtn');

function render(status) {
  if (!status) return;
  if (status.error) {
    errorEl.textContent = status.error;
    return;
  }
  errorEl.textContent = '';

  if (status.myID) {
    myIdEl.textContent = status.myID;
  }

  if (status.peerConnected) {
    statusEl.textContent = `Connected via ${status.peerVia === 'relay' ? 'Relay' : 'Direct'}`;
    statusEl.className = 'connected';
  } else {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'disconnected';
  }

  completionEl.textContent =
    status.folderCompletion != null ? `${status.folderCompletion}%` : '—';
}

myIdEl.addEventListener('click', () => {
  if (myIdEl.textContent && myIdEl.textContent !== 'loading…') {
    navigator.clipboard.writeText(myIdEl.textContent);
  }
});

addPeerBtn.addEventListener('click', async () => {
  const peerId = peerInput.value.trim();
  if (!peerId) return;
  const status = await window.syncthingBridge.addPeer(peerId);
  render(status);
});

window.syncthingBridge.onStatus(render);
window.syncthingBridge.getStatus().then(render);

// --- P3: operation flow -----------------------------------------------------

const entityIdInput = document.getElementById('entityIdInput');
const fieldSelect = document.getElementById('fieldSelect');
const valueInput = document.getElementById('valueInput');
const applyEditBtn = document.getElementById('applyEditBtn');
const entitiesBody = document.getElementById('entitiesBody');
const hashEl = document.getElementById('hash');

function renderState(state) {
  if (!state) return;
  entitiesBody.innerHTML = '';
  for (const row of state.entities || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.id}</td><td>${row.name ?? ''}</td><td>${row.location ?? ''}</td>`;
    entitiesBody.appendChild(tr);
  }
  hashEl.textContent = state.hash || '—';
}

applyEditBtn.addEventListener('click', async () => {
  const entityId = entityIdInput.value.trim();
  const field = fieldSelect.value;
  const value = valueInput.value;
  if (!entityId) return;
  await window.shoreshBridge.edit(entityId, field, value);
  const state = await window.shoreshBridge.getState();
  renderState(state);
});

window.shoreshBridge.onState(renderState);
window.shoreshBridge.getState().then(renderState);
