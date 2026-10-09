# Daily Desk

Personal PC app: daily **checklist** + **notebook**.

- Always-on-top small window (📌 toggle)
- App password lock; auto-lock after inactivity (default 10 min)
- All data encrypted (AES-256-GCM, key from your password via scrypt)
- Optional **Gmail/Google Drive** backup: the encrypted file is stored in the app's private
  Drive folder (only this app can see it). Google never sees plain text.
- Works offline; syncs when connected.

## 1. Setup (one time)

Requires Node.js 18+ (https://nodejs.org).

```bash
cd daily-desk
npm install
npm start
```

## 2. Google (Gmail) backup setup — one time

1. Go to https://console.cloud.google.com → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → fill app name + your Gmail as test user.
   Scope: `.../auth/drive.appdata` (only that).
4. **Credentials → Create credentials → OAuth client ID → Desktop app**.
5. Copy the Client ID (and Client secret if shown).
6. `cp config.example.json config.json` and paste the values. (`config.json` is git-ignored.)

Then open **⚙ Settings → Connect Gmail**. Login in browser, click Allow.

Note: while the consent screen is in "Testing" mode, Google refresh tokens expire
after 7 days. Set the publishing status to "In production" (no verification needed for
personal use with just your own account, you may still see a warning screen) to avoid this.

## 3. Build a Windows .exe (optional)

On a Windows PC:
```bash
npm install
npm run dist
```
The portable exe appears in `dist/`. Copy it anywhere and run it.

## Important

- If you **forget the app password, data cannot be recovered**. Keep it safe.
- Local data file: `%APPDATA%/daily-desk/vault.json` (encrypted).
- Cloud sync merges by item, so edits from two PCs are kept (newest edit per item wins).
- Disconnecting Gmail keeps local data on the PC.
