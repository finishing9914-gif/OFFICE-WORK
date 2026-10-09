'use strict';
// Local encrypted vault file. Nothing is stored in plain text on disk.
const fs = require('fs');
const path = require('path');
const { encryptJSON, decryptJSON } = require('./crypto');
const { emptyData } = require('./merge');

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'vault.json');
    this.password = null; // kept in memory only while unlocked
    this.salt = null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  isUnlocked() {
    return this.password !== null;
  }

  // First-time setup: create an empty encrypted vault with this password.
  init(password) {
    if (this.exists()) throw new Error('VAULT_EXISTS');
    this._writeBox(encryptJSON(emptyData(), password));
    this.password = password;
    this.salt = Buffer.from(this._readBox().salt, 'base64');
    return emptyData();
  }

  unlock(password) {
    const box = this._readBox();
    const data = decryptJSON(box, password); // throws on wrong password
    this.password = password;
    this.salt = Buffer.from(box.salt, 'base64');
    return data;
  }

  lock() {
    this.password = null;
    this.salt = null;
  }

  // Encrypt with the current password, reusing the vault salt.
  save(data) {
    this._requireUnlocked();
    this._writeBox(encryptJSON(data, this.password, this.salt));
  }

  // Encrypted blob for cloud upload (same format as local file).
  encryptedBlob(data) {
    this._requireUnlocked();
    return encryptJSON(data, this.password, this.salt);
  }

  // Decrypt a blob from the cloud using the app password (its own salt).
  decryptBlob(box) {
    this._requireUnlocked();
    return decryptJSON(box, this.password);
  }

  _requireUnlocked() {
    if (!this.password) throw new Error('LOCKED');
  }

  _readBox() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  _writeBox(box) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic replace, avoids half-written files
  }
}

module.exports = { Vault };
