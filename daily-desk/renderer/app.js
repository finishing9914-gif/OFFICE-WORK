'use strict';
// Daily Desk UI. No data is stored here; everything goes through window.desk (main process).
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let state = null;        // { checklist: [], notes: [] } while unlocked
let status = null;
let openNoteId = null;
let saveTimer = null;
let idleTimer = null;

// ---------- screens ----------
function show(name) {
  for (const s of ['setup', 'lock', 'app']) $(s).classList.toggle('hidden', s !== name);
}

async function boot() {
  status = await window.desk.status();
  if (!status.hasVault) return show('setup');
  // Window reload while unlocked: ask the user to unlock again so data is reloaded cleanly.
  return showLock();
}

function showLock() {
  state = null;
  openNoteId = null;
  $('lock-pw').value = '';
  $('lock-err').textContent = '';
  $('settings').classList.add('hidden');
  show('lock');
  $('lock-pw').focus();
}

async function enterApp(res) {
  state = normalize(res.data);
  show('app');
  $('today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  renderTasks();
  renderNotes();
  startIdleWatch();
}

function normalize(d) {
  return {
    checklist: Array.isArray(d && d.checklist) ? d.checklist : [],
    notes: Array.isArray(d && d.notes) ? d.notes : [],
  };
}

// ---------- setup / unlock ----------
$('setup-btn').onclick = async () => {
  const a = $('setup-pw').value, b = $('setup-pw2').value;
  $('setup-err').textContent = '';
  if (a.length < 8) return ($('setup-err').textContent = 'Password must be at least 8 characters.');
  if (a !== b) return ($('setup-err').textContent = 'Passwords do not match.');
  const res = await window.desk.init(a);
  if (!res.ok) return ($('setup-err').textContent = res.reason);
  $('setup-pw').value = $('setup-pw2').value = '';
  await enterApp(res);
};

async function unlock() {
  $('lock-err').textContent = '';
  const res = await window.desk.unlock($('lock-pw').value);
  $('lock-pw').value = '';
  if (!res.ok) return ($('lock-err').textContent = 'Wrong password.');
  await enterApp(res);
}
$('lock-btn').onclick = unlock;
$('lock-pw').addEventListener('keydown', (e) => e.key === 'Enter' && unlock());
$('setup-pw2').addEventListener('keydown', (e) => e.key === 'Enter' && $('setup-btn').click());

async function lockNow() {
  await flushSave();
  await window.desk.lock();
  showLock();
}
$('lock-now-btn').onclick = lockNow;
window.desk.onLocked(() => showLock());

// Auto-lock after inactivity.
function startIdleWatch() {
  const reset = () => {
    clearTimeout(idleTimer);
    const mins = status ? status.autoLockMinutes : 10;
    idleTimer = setTimeout(lockNow, mins * 60 * 1000);
  };
  ['mousemove', 'keydown', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, reset, { passive: true }));
  reset();
}

// ---------- saving ----------
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state) return;
  await window.desk.save(state);
}

window.desk.onDataUpdated((d) => {
  // Cloud sync brought in changes from another device.
  const keepNote = openNoteId;
  state = normalize(d);
  renderTasks();
  renderNotes(keepNote);
});

// ---------- checklist ----------
function visibleTasks() {
  const t = today();
  const live = state.checklist.filter((x) => !x.deleted);
  return {
    todays: live.filter((x) => x.date === t),
    carry: live.filter((x) => x.date < t && !x.done),
  };
}

function taskRow(item, carry) {
  const li = document.createElement('li');
  li.className = 'task' + (item.done ? ' done' : '') + (carry ? ' carry' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!item.done;
  cb.onchange = () => updateItem(item.id, { done: cb.checked });
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = item.text;
  span.title = 'Click to edit';
  span.onclick = () => {
    const v = prompt('Edit task', item.text);
    if (v !== null && v.trim()) updateItem(item.id, { text: v.trim() });
  };
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '✕';
  x.title = 'Delete';
  x.onclick = () => removeItem(item.id);
  li.append(cb, span, x);
  return li;
}

function renderTasks() {
  const { todays, carry } = visibleTasks();
  $('task-list').replaceChildren(...todays.map((t) => taskRow(t, false)));
  $('carry-list').replaceChildren(...carry.map((t) => taskRow(t, true)));
  $('carry-title').classList.toggle('hidden', carry.length === 0);
  $('task-empty').classList.toggle('hidden', todays.length + carry.length > 0);
  const done = todays.filter((t) => t.done).length;
  $('task-progress').textContent = todays.length ? `${done} / ${todays.length} done today` : '';
}

function updateItem(id, patch) {
  const it = state.checklist.find((x) => x.id === id);
  if (!it) return;
  Object.assign(it, patch, { updatedAt: Date.now() });
  renderTasks();
  scheduleSave();
}

function removeItem(id) {
  const it = state.checklist.find((x) => x.id === id);
  if (!it) return;
  // Mark as deleted (tombstone) so the delete also syncs to other devices.
  Object.assign(it, { deleted: true, updatedAt: Date.now() });
  renderTasks();
  scheduleSave();
}

$('add-task').onsubmit = (e) => {
  e.preventDefault();
  const text = $('task-input').value.trim();
  if (!text) return;
  state.checklist.push({ id: uid(), text, done: false, date: today(), updatedAt: Date.now() });
  $('task-input').value = '';
  renderTasks();
  scheduleSave();
};

// ---------- notes ----------
function renderNotes(keepOpenId) {
  const q = $('note-search').value.trim().toLowerCase();
  const list = state.notes
    .filter((n) => !n.deleted)
    .filter((n) => !q || (n.title + ' ' + n.body).toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('note-list').replaceChildren(...list.map((n) => {
    const li = document.createElement('li');
    li.className = 'note';
    const b = document.createElement('b');
    b.textContent = n.title || 'Untitled';
    const s = document.createElement('small');
    s.textContent = (n.body || '').split('\n')[0] || ' ';
    li.append(b, s);
    li.onclick = () => openNote(n.id);
    return li;
  }));
  $('note-empty').classList.toggle('hidden', list.length > 0);
  if (keepOpenId && openNoteId === keepOpenId) {
    const exists = state.notes.some((n) => n.id === keepOpenId && !n.deleted);
    if (!exists) showNotesList();
  }
}

function showNotesList() {
  openNoteId = null;
  $('notes-edit-view').classList.add('hidden');
  $('notes-list-view').classList.remove('hidden');
  renderNotes();
}

function openNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  openNoteId = id;
  $('note-title').value = n.title || '';
  $('note-body').value = n.body || '';
  $('note-saved').textContent = '';
  $('notes-list-view').classList.add('hidden');
  $('notes-edit-view').classList.remove('hidden');
}

function touchNote() {
  const n = state.notes.find((x) => x.id === openNoteId);
  if (!n) return;
  n.title = $('note-title').value;
  n.body = $('note-body').value;
  n.updatedAt = Date.now();
  $('note-saved').textContent = 'Saved';
  scheduleSave();
}
$('note-title').addEventListener('input', touchNote);
$('note-body').addEventListener('input', touchNote);

$('new-note').onclick = () => {
  const n = { id: uid(), title: '', body: '', updatedAt: Date.now() };
  state.notes.push(n);
  openNote(n.id);
  scheduleSave();
  $('note-title').focus();
};
$('note-back').onclick = () => { flushSave(); showNotesList(); };
$('note-delete').onclick = () => {
  const n = state.notes.find((x) => x.id === openNoteId);
  if (!n) return;
  if ((n.title || n.body) && !confirm('Delete this note?')) return;
  Object.assign(n, { deleted: true, updatedAt: Date.now() });
  scheduleSave();
  showNotesList();
};
$('note-search').addEventListener('input', () => renderNotes());

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('tab-today').classList.toggle('hidden', btn.dataset.tab !== 'today');
    $('tab-notes').classList.toggle('hidden', btn.dataset.tab !== 'notes');
    if (btn.dataset.tab === 'notes') showNotesList();
  };
});

// ---------- settings ----------
async function openSettings() {
  status = await window.desk.status();
  $('set-pin').checked = status.alwaysOnTop;
  $('set-lock').value = status.autoLockMinutes;
  $('pin-btn').classList.toggle('active', status.alwaysOnTop);
  renderCloud();
  $('settings').classList.remove('hidden');
}

function renderCloud() {
  const parts = [];
  if (status.cloudEmail) parts.push(`Connected: ${status.cloudEmail}`);
  else parts.push('Not connected');
  if (status.lastSync) parts.push(`Last sync: ${new Date(status.lastSync).toLocaleString()}`);
  $('cloud-state').textContent = parts.join(' · ');
  $('cloud-connect').classList.toggle('hidden', !!status.cloudEmail);
  $('cloud-sync').classList.toggle('hidden', !status.cloudEmail);
  $('cloud-disconnect').classList.toggle('hidden', !status.cloudEmail);
  $('sync-dot').className = 'dot ' + (status.cloudEmail ? 'ok' : '');
  $('sync-dot').title = status.cloudEmail ? 'Cloud backup on' : 'Cloud not connected';
}

$('settings-btn').onclick = openSettings;
$('settings-close').onclick = () => $('settings').classList.add('hidden');
$('settings').addEventListener('mousedown', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });

async function setPin(on) {
  await window.desk.setSettings({ alwaysOnTop: on });
  status.alwaysOnTop = on;
  $('set-pin').checked = on;
  $('pin-btn').classList.toggle('active', on);
}
$('pin-btn').onclick = () => setPin(!status.alwaysOnTop);
$('set-pin').onchange = (e) => setPin(e.target.checked);
$('set-lock').onchange = async (e) => {
  const n = Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 10));
  e.target.value = n;
  status.autoLockMinutes = n;
  await window.desk.setSettings({ autoLockMinutes: n });
  startIdleWatch();
};

$('cloud-connect').onclick = async () => {
  $('cloud-err').textContent = 'Browser e Google login page khulbe. Login kore Allow din…';
  $('sync-dot').className = 'dot busy';
  await flushSave();
  const res = await window.desk.connectCloud();
  if (!res.ok) {
    $('cloud-err').textContent = errorText(res.reason);
    $('sync-dot').className = 'dot bad';
    return;
  }
  $('cloud-err').textContent = '';
  status = await window.desk.status();
  renderCloud();
  state = normalize(state);
  renderTasks();
  renderNotes();
};

$('cloud-sync').onclick = async () => {
  $('cloud-err').textContent = 'Syncing…';
  await flushSave();
  const res = await window.desk.syncCloud();
  $('cloud-err').textContent = res.ok ? 'Synced.' : errorText(res.reason);
  status = await window.desk.status();
  renderCloud();
};

$('cloud-disconnect').onclick = async () => {
  if (!confirm('Disconnect Gmail backup? Local data stays on this PC.')) return;
  await window.desk.disconnectCloud();
  status = await window.desk.status();
  renderCloud();
};

function errorText(reason) {
  const map = {
    NO_GOOGLE_CLIENT_ID: 'Google Client ID missing. See README (config.json).',
    CLOUD_PASSWORD_MISMATCH: 'Cloud backup ar password diye banano. Ager password diye unlock korun.',
    SIGNIN_TIMEOUT: 'Login timed out. Please try again.',
    OS_ENCRYPTION_UNAVAILABLE: 'This PC has no secure storage available for the login token.',
    LOCKED: 'App is locked. Unlock first.',
  };
  return map[reason] || ('Error: ' + reason);
}

boot();
