'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Vault } = require('./src/vault');
const { mergeData, emptyData } = require('./src/merge');
const { signIn, DriveClient } = require('./src/google');

const vault = new Vault(app.getPath('userData'));
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const CLOUD_FILE = path.join(app.getPath('userData'), 'cloud.bin');
const CONFIG_FILE = path.join(__dirname, 'config.json');

let win = null;
let data = null;            // decrypted app data (only while unlocked)
let syncTimer = null;
let saveTimer = null;
let syncing = false;

// ---------- settings ----------
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function patchSettings(patch) {
  const s = { ...readSettings(), ...patch };
  writeSettings(s);
  return s;
}

// ---------- Google config ----------
function googleConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || cfg.googleClientId || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || cfg.googleClientSecret || '',
  };
}

// ---------- cloud token (encrypted by the OS keychain via safeStorage) ----------
function saveCloudToken(refreshToken, email) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS_ENCRYPTION_UNAVAILABLE');
  fs.writeFileSync(CLOUD_FILE, safeStorage.encryptString(refreshToken));
  patchSettings({ cloudEmail: email });
}
function loadCloudToken() {
  if (!fs.existsSync(CLOUD_FILE)) return null;
  return safeStorage.decryptString(fs.readFileSync(CLOUD_FILE));
}
function clearCloud() {
  try { fs.unlinkSync(CLOUD_FILE); } catch {}
  patchSettings({ cloudEmail: '' });
}

// ---------- window ----------
function createWindow() {
  const s = readSettings();
  const b = s.bounds || {};
  win = new BrowserWindow({
    width: b.width || 380,
    height: b.height || 620,
    x: b.x,
    y: b.y,
    minWidth: 320,
    minHeight: 420,
    title: 'Daily Desk',
    autoHideMenuBar: true,
    alwaysOnTop: s.alwaysOnTop !== false,   // default: always on top
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (win.setAlwaysOnTop) win.setAlwaysOnTop(s.alwaysOnTop !== false, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const saveBounds = () => {
    if (win.isMinimized() || win.isMaximized()) return;
    patchSettings({ bounds: win.getBounds() });
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => { win = null; });
}

// ---------- data + sync ----------
function persistLocal() {
  if (data && vault.isUnlocked()) vault.save(data);
}

function scheduleCloudSync() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => syncNow().catch(() => {}), 3000);
}

async function syncNow() {
  if (!vault.isUnlocked() || !data || syncing) return { ok: false, reason: 'LOCKED' };
  const token = loadCloudToken();
  if (!token) return { ok: false, reason: 'NOT_CONNECTED' };
  const { clientId, clientSecret } = googleConfig();
  syncing = true;
  try {
    const drive = new DriveClient({ clientId, clientSecret, refreshToken: token });
    const remoteBox = await drive.download();
    if (remoteBox) {
      let remote;
      try { remote = vault.decryptBlob(remoteBox); }
      catch { return { ok: false, reason: 'CLOUD_PASSWORD_MISMATCH' }; }
      data = mergeData(data, remote);
      persistLocal();
      send('data:updated', data);
    }
    await drive.upload(vault.encryptedBlob(data));
    patchSettings({ lastSync: Date.now() });
    return { ok: true, lastSync: Date.now() };
  } catch (e) {
    return { ok: false, reason: e.message || 'SYNC_FAILED' };
  } finally {
    syncing = false;
  }
}

function startAutoSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => syncNow().catch(() => {}), 5 * 60 * 1000);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function lockNow() {
  if (data) persistLocal();
  data = null;
  vault.lock();
  clearInterval(syncTimer);
  clearTimeout(saveTimer);
  send('vault:locked');
  return { ok: true };
}

// ---------- IPC ----------
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (reason) => ({ ok: false, reason });

ipcMain.handle('app:status', () => {
  const s = readSettings();
  return {
    hasVault: vault.exists(),
    unlocked: vault.isUnlocked(),
    alwaysOnTop: s.alwaysOnTop !== false,
    autoLockMinutes: s.autoLockMinutes ?? 10,
    cloudEmail: s.cloudEmail || '',
    cloudConfigured: !!googleConfig().clientId,
    lastSync: s.lastSync || 0,
  };
});

ipcMain.handle('vault:init', (_e, password) => {
  if (typeof password !== 'string' || password.length < 8) return fail('PASSWORD_TOO_SHORT');
  if (vault.exists()) return fail('VAULT_EXISTS');
  data = vault.init(password);
  return ok({ data });
});

ipcMain.handle('vault:unlock', async (_e, password) => {
  if (typeof password !== 'string' || !password) return fail('EMPTY');
  try {
    data = vault.unlock(password);
  } catch {
    return fail('WRONG_PASSWORD');
  }
  startAutoSync();
  syncNow().catch(() => {});
  return ok({ data });
});

ipcMain.handle('vault:lock', () => lockNow());

ipcMain.handle('data:save', (_e, incoming) => {
  if (!vault.isUnlocked() || !incoming || !Array.isArray(incoming.checklist) || !Array.isArray(incoming.notes)) {
    return fail('INVALID');
  }
  data = { version: 1, updatedAt: Date.now(), checklist: incoming.checklist, notes: incoming.notes };
  persistLocal();
  if (loadCloudToken()) scheduleCloudSync();
  return ok();
});

ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = {};
  if (typeof patch.alwaysOnTop === 'boolean') allowed.alwaysOnTop = patch.alwaysOnTop;
  if (Number.isFinite(patch.autoLockMinutes)) allowed.autoLockMinutes = Math.max(1, Math.min(120, patch.autoLockMinutes));
  patchSettings(allowed);
  if (win && typeof allowed.alwaysOnTop === 'boolean') win.setAlwaysOnTop(allowed.alwaysOnTop, 'floating');
  return ok();
});

ipcMain.handle('cloud:connect', async () => {
  if (!vault.isUnlocked()) return fail('LOCKED');
  const { clientId, clientSecret } = googleConfig();
  if (!clientId) return fail('NO_GOOGLE_CLIENT_ID');
  try {
    const { refreshToken, email } = await signIn({
      clientId, clientSecret, openExternal: (url) => shell.openExternal(url),
    });
    saveCloudToken(refreshToken, email);
    const result = await syncNow();
    return result.ok ? ok({ email }) : fail(result.reason);
  } catch (e) {
    return fail(e.message);
  }
});

ipcMain.handle('cloud:disconnect', () => {
  clearCloud();
  return ok();
});

ipcMain.handle('cloud:sync', async () => {
  const r = await syncNow();
  return r.ok ? ok({ lastSync: r.lastSync }) : fail(r.reason);
});

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  lockNow();
  app.quit();
});

app.on('before-quit', () => {
  if (data) persistLocal();
});
