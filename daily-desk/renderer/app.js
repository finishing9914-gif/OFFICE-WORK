'use strict';
// Daily Desk UI. No data is stored here; everything goes through window.desk (main process).
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DEFAULT_LIST = 'Office Work';
const NO_LIST = 'General';
const NOTIFY_WINDOW_MS = 10 * 60 * 1000; // don't announce events older than 10 min (e.g. app opened late)

const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtLeft = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

let state = null;        // { checklist: [], notes: [] } while unlocked
let status = null;
let openNoteId = null;
let saveTimer = null;
let idleTimer = null;
let tickTimer = null;
let renderedDay = today();
const announced = new Set(); // in-memory only: "<id>:start" / "<id>:end"

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
  stopTicker();
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
  startTicker();
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
  if (!res.ok) return ($('lock-err').textContent = 'Wrong password. / ভুল পাসওয়ার্ড।');
  await enterApp(res);
}
$('lock-btn').onclick = unlock;
$('lock-pw').addEventListener('keydown', (e) => e.key === 'Enter' && unlock());
$('setup-pw2').addEventListener('keydown', (e) => e.key === 'Enter' && $('setup-btn').click());

async function lockNow() {
  if (!state) return;
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
  if (!startIdleWatch.bound) {
    ['mousemove', 'keydown', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, reset, { passive: true }));
    startIdleWatch.bound = true;
  }
  startIdleWatch.reset = reset;
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

// ---------- timing ----------
// A task with a start time (and minutes) gets a live countdown on the day it was added.
function windowOf(item) {
  if (!item.startTime || !item.date) return null;
  const [y, mo, da] = item.date.split('-').map(Number);
  const [h, m] = item.startTime.split(':').map(Number);
  const start = new Date(y, mo - 1, da, h, m, 0, 0).getTime();
  const dur = Number(item.duration) > 0 ? Number(item.duration) : 0;
  return { start, end: dur ? start + dur * 60000 : null };
}

function timerOf(item, now) {
  const w = windowOf(item);
  if (!w || item.done) return null;
  if (now < w.start) return { cls: 'waiting', text: `শুরু ${item.startTime}` };
  if (!w.end) return { cls: 'running', text: 'চলছে' };
  if (now < w.end) return { cls: 'running', text: `${fmtLeft(w.end - now)} baki` };
  return { cls: 'over', text: `+${fmtLeft(now - w.end)} beshi` };
}

function notify(title, body) {
  try {
    if ('Notification' in window) new Notification(title, { body, silent: false });
  } catch { /* notifications unavailable: ignore */ }
}

function checkNotifications(now) {
  if (!state) return;
  for (const it of state.checklist) {
    if (it.deleted || it.done || it.date !== today()) continue;
    const w = windowOf(it);
    if (!w) continue;
    if (!announced.has(it.id + ':start') && now >= w.start && now - w.start < NOTIFY_WINDOW_MS) {
      announced.add(it.id + ':start');
      notify(`▶ ${it.text}`, `কাজ শুরুর সময় হয়েছে (${it.startTime})`);
    }
    if (w.end && !announced.has(it.id + ':end') && now >= w.end && now - w.end < NOTIFY_WINDOW_MS) {
      announced.add(it.id + ':end');
      notify(`⏰ ${it.text}`, `${it.duration} মিনিট শেষ! কাজ শেষ হলে tick দিন।`);
    }
  }
}

function tick() {
  if (!state) return;
  if (today() !== renderedDay) { renderedDay = today(); renderTasks(); }
  const now = Date.now();
  checkNotifications(now);
  for (const el of document.querySelectorAll('[data-timer]')) {
    const it = state.checklist.find((x) => x.id === el.dataset.timer);
    const info = it && timerOf(it, now);
    if (!info) { el.textContent = ''; el.className = 'timer'; continue; }
    el.textContent = info.text;
    el.className = `timer ${info.cls}`;
  }
}

function startTicker() {
  stopTicker();
  tick();
  tickTimer = setInterval(tick, 1000);
}
function stopTicker() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// ---------- checklist ----------
function byTime(a, b) {
  return (a.startTime || '99:99').localeCompare(b.startTime || '99:99');
}

function taskRow(item, carry) {
  const li = document.createElement('li');
  li.className = 'task' + (item.done ? ' done' : '') + (carry ? ' carry' : '');

  const top = document.createElement('div');
  top.className = 'task-top';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!item.done;
  cb.onchange = () => updateItem(item.id, { done: cb.checked });
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = item.text;
  span.title = 'Click to edit';
  span.onclick = () => startInlineEdit(span, item);
  const timer = document.createElement('span');
  timer.className = 'timer';
  timer.dataset.timer = item.id;
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '✕';
  x.title = 'Delete';
  x.onclick = () => removeItem(item.id);
  top.append(cb, span, timer, x);
  li.append(top);

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  if (carry) {
    const d = document.createElement('small');
    d.className = 'muted';
    d.textContent = `${item.date} · ${item.list || NO_LIST}`;
    meta.append(d);
  } else {
    const start = document.createElement('input');
    start.type = 'time';
    start.value = item.startTime || '';
    start.title = 'শুরুর সময় / Start time';
    start.onchange = () => updateItem(item.id, { startTime: start.value });
    const dur = document.createElement('input');
    dur.type = 'number';
    dur.min = '1';
    dur.max = '600';
    dur.className = 'num';
    dur.placeholder = 'min';
    dur.value = item.duration || '';
    dur.title = 'কত মিনিট / Minutes';
    dur.onchange = () => {
      const v = parseInt(dur.value, 10);
      updateItem(item.id, { duration: v > 0 ? v : null });
    };
    const label = document.createElement('small');
    label.className = 'muted';
    const w = windowOf(item);
    label.textContent = w && w.end ? `শেষ ${hm(w.end)}` : '';
    meta.append(start, dur, label);
  }
  li.append(meta);
  return li;
}

// Electron does not support window.prompt(), so edit the text inline instead.
function startInlineEdit(span, item) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.text;
  input.className = 'inline-edit';
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (save && v && v !== item.text) updateItem(item.id, { text: v });
    else renderTasks();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  span.replaceWith(input);
  input.focus();
  input.select();
}

function renderTasks() {
  if (!state) return;
  const t = today();
  renderedDay = t;
  const live = state.checklist.filter((x) => !x.deleted);
  const todays = live.filter((x) => x.date === t);
  const carry = live.filter((x) => x.date < t && !x.done);

  // Group today's tasks by list (e.g. "Office Work").
  const groups = new Map();
  for (const it of todays) {
    const key = it.list || NO_LIST;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const container = $('today-groups');
  container.replaceChildren();
  const names = [...groups.keys()].sort((a, b) => (a === DEFAULT_LIST ? -1 : b === DEFAULT_LIST ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const items = groups.get(name).sort(byTime);
    const h = document.createElement('h3');
    h.className = 'group-title';
    const done = items.filter((i) => i.done).length;
    h.textContent = `${name}  (${done}/${items.length})`;
    const ul = document.createElement('ul');
    ul.className = 'list';
    items.forEach((it) => ul.append(taskRow(it, false)));
    container.append(h, ul);
  }

  $('carry-list').replaceChildren(...carry.map((it) => taskRow(it, true)));
  $('carry-title').classList.toggle('hidden', carry.length === 0);
  $('task-empty').classList.toggle('hidden', todays.length + carry.length > 0);
  const doneToday = todays.filter((x) => x.done).length;
  $('task-progress').textContent = todays.length ? `${doneToday} / ${todays.length} done today` : '';

  // Suggest existing list names.
  const listNames = new Set([DEFAULT_LIST, ...live.map((x) => x.list).filter(Boolean)]);
  $('list-options').replaceChildren(...[...listNames].map((n) => {
    const o = document.createElement('option');
    o.value = n;
    return o;
  }));
  tick();
}

function updateItem(id, patch) {
  const it = state.checklist.find((x) => x.id === id);
  if (!it) return;
  Object.assign(it, patch, { updatedAt: Date.now() });
  // Changing the time means a fresh reminder is allowed.
  if ('startTime' in patch || 'duration' in patch) {
    announced.delete(id + ':start');
    announced.delete(id + ':end');
  }
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
  const list = $('task-list').value.trim() || DEFAULT_LIST;
  const startTime = $('task-start').value || '';
  const dur = parseInt($('task-dur').value, 10);
  state.checklist.push({
    id: uid(),
    text,
    done: false,
    date: today(),
    list,
    startTime,
    duration: dur > 0 ? dur : null,
    updatedAt: Date.now(),
  });
  $('task-input').value = '';
  $('task-start').value = '';
  $('task-dur').value = '';
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
  if (startIdleWatch.reset) startIdleWatch.reset();
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
    NO_GOOGLE_CLIENT_ID: 'Google Client ID missing. See GOOGLE_SETUP_BN.md (config.json).',
    CLOUD_PASSWORD_MISMATCH: 'Cloud backup ar password diye banano. Ager password diye unlock korun.',
    SIGNIN_TIMEOUT: 'Login timed out. Please try again.',
    OS_ENCRYPTION_UNAVAILABLE: 'This PC has no secure storage available for the login token.',
    LOCKED: 'App is locked. Unlock first.',
  };
  return map[reason] || ('Error: ' + reason);
}

boot();
