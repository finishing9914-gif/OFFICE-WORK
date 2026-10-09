'use strict';
// Run: npm test   (pure Node tests: no Electron window needed)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptJSON, decryptJSON } = require('../src/crypto');
const { mergeData, mergeLists, emptyData } = require('../src/merge');
const { Vault } = require('../src/vault');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { console.error('  FAIL-', name, '\n', e); process.exitCode = 1; }
}

test('encrypt/decrypt roundtrip', () => {
  const obj = { checklist: [{ id: 'a', text: 'মিটিং' }], notes: [] };
  const box = encryptJSON(obj, 'correct horse');
  assert.deepStrictEqual(decryptJSON(box, 'correct horse'), obj);
});

test('ciphertext does not contain plain text', () => {
  const box = encryptJSON({ secret: 'my-very-private-note' }, 'pw12345678');
  assert.ok(!JSON.stringify(box).includes('my-very-private-note'));
});

test('wrong password is rejected', () => {
  const box = encryptJSON({ a: 1 }, 'right-password');
  assert.throws(() => decryptJSON(box, 'wrong-password'), /WRONG_PASSWORD_OR_CORRUPT/);
});

test('tampered data is rejected (GCM auth)', () => {
  const box = encryptJSON({ a: 1 }, 'right-password');
  const buf = Buffer.from(box.data, 'base64');
  buf[0] ^= 0xff;
  box.data = buf.toString('base64');
  assert.throws(() => decryptJSON(box, 'right-password'));
});

test('each encryption uses a fresh salt and iv', () => {
  const a = encryptJSON({ a: 1 }, 'pw12345678');
  const b = encryptJSON({ a: 1 }, 'pw12345678');
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.iv, b.iv);
});

test('merge: newer item wins per id', () => {
  const out = mergeLists(
    [{ id: 'x', text: 'old', updatedAt: 100 }],
    [{ id: 'x', text: 'new', updatedAt: 200 }, { id: 'y', text: 'y', updatedAt: 50 }],
    1000
  );
  const x = out.find((i) => i.id === 'x');
  assert.strictEqual(x.text, 'new');
  assert.strictEqual(out.length, 2);
});

test('merge: delete (tombstone) syncs across devices', () => {
  const now = Date.now();
  const local = { checklist: [{ id: 't', text: 'a', updatedAt: now - 10, deleted: true }], notes: [] };
  const remote = { checklist: [{ id: 't', text: 'a', updatedAt: now - 20 }], notes: [] };
  const m = mergeData(local, remote, now);
  assert.strictEqual(m.checklist[0].deleted, true);
});

test('merge: old tombstones are purged after 30 days', () => {
  const now = Date.now();
  const old = now - 31 * 24 * 3600 * 1000;
  const m = mergeLists([{ id: 'z', deleted: true, updatedAt: old }], [], now);
  assert.strictEqual(m.length, 0);
});

test('merge: empty + remote gives remote', () => {
  const remote = { version: 1, updatedAt: 5, checklist: [{ id: 'q', text: 'q', updatedAt: 5 }], notes: [] };
  const m = mergeData(emptyData(), remote);
  assert.strictEqual(m.checklist.length, 1);
});

test('vault: init, lock, wrong password, unlock, save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-'));
  const v = new Vault(dir);
  assert.strictEqual(v.exists(), false);
  v.init('my-password-1');
  assert.strictEqual(v.exists(), true);
  const raw = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');
  assert.ok(!raw.includes('checklist'), 'file must be encrypted');
  v.lock();
  assert.throws(() => v.unlock('nope'), /WRONG_PASSWORD/);
  const d = v.unlock('my-password-1');
  assert.deepStrictEqual(d.checklist, []);
  v.save({ version: 1, updatedAt: 1, checklist: [{ id: '1', text: 'hi', done: false, date: '2026-10-09', updatedAt: 1 }], notes: [] });
  v.lock();
  assert.strictEqual(v.unlock('my-password-1').checklist[0].text, 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vault: cloud blob with other salt is decrypted by password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-'));
  const v = new Vault(dir);
  v.init('shared-pass-99');
  const remoteBox = encryptJSON({ version: 1, updatedAt: 9, checklist: [], notes: [{ id: 'n', title: 'remote', updatedAt: 9 }] }, 'shared-pass-99');
  const remote = v.decryptBlob(remoteBox);
  assert.strictEqual(remote.notes[0].title, 'remote');
  fs.rmSync(dir, { recursive: true, force: true });
});


// ---- Today timer logic (extracted from renderer/app.js, no browser needed) ----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const chunk = src.slice(src.indexOf('function windowOf'), src.indexOf('function notify'));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtLeft = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = t % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`; };
  const { windowOf, timerOf } = new Function('pad', 'fmtLeft', chunk + '; return { windowOf, timerOf };')(pad, fmtLeft);
  const item = { date: '2026-10-09', startTime: '08:20', duration: 10, done: false };
  const at = (hh, mm, ss = 0) => new Date(2026, 9, 9, hh, mm, ss).getTime();

  test('timer: waiting before start time', () => {
    assert.strictEqual(timerOf(item, at(8, 19)).cls, 'waiting');
  });
  test('timer: running countdown 10 min from 08:20', () => {
    const t = timerOf(item, at(8, 25, 30));
    assert.strictEqual(t.cls, 'running');
    assert.strictEqual(t.text, '04:30 baki');
  });
  test('timer: over after 08:30 shows overtime', () => {
    const t = timerOf(item, at(8, 31, 15));
    assert.strictEqual(t.cls, 'over');
    assert.strictEqual(t.text, '+01:15 beshi');
  });
  test('timer: done task has no timer', () => {
    assert.strictEqual(timerOf({ ...item, done: true }, at(8, 25)), null);
  });
  test('timer: task without duration just runs', () => {
    assert.strictEqual(timerOf({ ...item, duration: null }, at(9, 0)).text, 'চলছে');
  });
  test('window: end = start + duration', () => {
    const w = windowOf(item);
    assert.strictEqual(w.end - w.start, 10 * 60000);
  });
}

console.log(`\n${passed} tests passed` + (process.exitCode ? ' (with failures)' : ''));
