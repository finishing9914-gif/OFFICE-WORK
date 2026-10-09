'use strict';
// Google sign-in (OAuth 2.0 with PKCE, loopback redirect) + Google Drive
// hidden app-data folder. The app only sees its own private file there.
const http = require('http');
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'daily-desk-data.json';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Opens Google login in the default browser, waits for the redirect,
// and returns { refreshToken, email }.
function signIn({ clientId, clientSecret, openExternal, timeoutMs = 5 * 60 * 1000 }) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const done = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">${msg}<br>You can close this tab.</body></html>`);
      };
      try {
        if (url.searchParams.get('state') !== state) throw new Error('STATE_MISMATCH');
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
        const code = url.searchParams.get('code');
        const body = new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        });
        if (clientSecret) body.set('client_secret', clientSecret);
        const tok = await postForm(TOKEN_URL, body);
        if (!tok.refresh_token) throw new Error('NO_REFRESH_TOKEN');
        const email = emailFromIdToken(tok.id_token);
        done('Google account connected. Back to Daily Desk.');
        cleanup();
        resolve({ refreshToken: tok.refresh_token, email });
      } catch (e) {
        done('Sign-in failed. Please try again in Daily Desk.');
        cleanup();
        reject(e);
      }
    });

    let redirectUri = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('SIGNIN_TIMEOUT')); }, timeoutMs);
    function cleanup() { clearTimeout(timer); server.close(); }

    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      openExternal(`${AUTH_URL}?${params}`);
    });
  });
}

function emailFromIdToken(idToken) {
  if (!idToken) return '';
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || '';
  } catch { return ''; }
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `HTTP_${res.status}`);
  return json;
}

class DriveClient {
  constructor({ clientId, clientSecret, refreshToken }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async _token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const tok = await postForm(TOKEN_URL, body);
    this.accessToken = tok.access_token;
    this.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async _fetch(url, opts = {}) {
    const token = await this._token();
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`DRIVE_HTTP_${res.status}`);
    return res;
  }

  async _findId() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await this._fetch(
      `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`
    );
    const json = await res.json();
    return json.files && json.files[0] ? json.files[0].id : null;
  }

  // Returns the encrypted blob stored in the cloud, or null if none yet.
  async download() {
    const id = await this._findId();
    if (!id) return null;
    const res = await this._fetch(`${DRIVE}/files/${id}?alt=media`);
    return res.json();
  }

  async upload(box) {
    const id = await this._findId();
    const content = JSON.stringify(box);
    if (id) {
      await this._fetch(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      });
      return id;
    }
    // Create new file inside the hidden appDataFolder (multipart upload).
    const boundary = 'dd' + crypto.randomBytes(8).toString('hex');
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await this._fetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()).id;
  }
}

module.exports = { signIn, DriveClient };
