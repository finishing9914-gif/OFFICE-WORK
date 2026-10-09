'use strict';
// Password -> key (scrypt) -> AES-256-GCM encryption.
// The same encrypted blob is stored locally AND in the cloud, so the cloud
// copy is unreadable without the app password.
const crypto = require('crypto');

const KDF = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KDF.keylen, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024,
  });
}

function encryptJSON(obj, password, salt = crypto.randomBytes(16)) {
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptJSON(box, password) {
  if (!box || box.v !== 1) throw new Error('UNSUPPORTED_FORMAT');
  try {
    const key = deriveKey(password, Buffer.from(box.salt, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(box.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch (e) {
    throw new Error('WRONG_PASSWORD_OR_CORRUPT');
  }
}

module.exports = { encryptJSON, decryptJSON, deriveKey };
