# Google Client ID বানানোর ধাপে ধাপে গাইড (বাংলা)

Gmail backup চালু করতে একবারই এই কাজ করতে হবে। এটা সম্পূর্ণ বিনামূল্যে।

1. ব্রাউজারে যান: https://console.cloud.google.com — আপনার Gmail দিয়ে লগইন করুন।
2. উপরে **Select a project → New Project** চাপুন। নাম দিন `Daily Desk`, তারপর **Create**।
3. বাম মেনু থেকে **APIs & Services → Library** খুলুন। "Google Drive API" খুঁজে **Enable** করুন।
4. **APIs & Services → OAuth consent screen** খুলুন:
   - User Type: **External** → Create
   - App name: `Daily Desk`, User support email ও Developer email: আপনার Gmail
   - Scopes ধাপে কিছু যোগ করতে হবে না, **Save and Continue**
   - Test users ধাপে আপনার Gmail যোগ করুন
   - (ঐচ্ছিক কিন্তু সুপারিশকৃত) **Publish App** চাপুন, যাতে refresh token ৭ দিনে শেষ না হয়
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID** খুলুন:
   - Application type: **Desktop app**
   - Name: `Daily Desk PC`
   - **Create** চাপুন
6. একটি popup আসবে। **Client ID** কপি করুন (দেখতে `xxxx.apps.googleusercontent.com`-এর মতো)। যদি **Client secret** দেখায়, সেটাও কপি করুন।
7. `daily-desk` ফোল্ডারে `config.example.json`-এর কপি বানিয়ে নাম দিন `config.json`, তারপর লিখুন:

```json
{
  "googleClientId": "এখানে_আপনার_Client_ID",
  "googleClientSecret": "এখানে_Client_secret_(না থাকলে_খালি রাখুন)"
}
```

8. অ্যাপ চালু করুন (`npm start`), **⚙ Settings → Connect Gmail** চাপুন। ব্রাউজারে আপনার Gmail দিয়ে লগইন করে **Allow** দিন।

**মনে রাখবেন:** `config.json` কাউকে দেবেন না। এটি GitHub-এ যাবে না কারণ `.gitignore`-এ আছে।

**সমস্যা হলে:**
- "Access blocked" দেখালে: OAuth consent screen-এ আপনার Gmail-কে Test user হিসেবে যোগ করেছেন কিনা দেখুন।
- "Wrong password" বা "CLOUD_PASSWORD_MISMATCH": cloud backup আগে অন্য পাসওয়ার্ড দিয়ে বানানো হয়েছিল।
