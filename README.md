# VeriGate Scan App

The mobile app scanners/staff use to verify attendee QR codes offline against a locally synced access database.

## 🚀 Features

- **Offline QR verification**: signature + expiry + area-access checks run entirely against the local encrypted SQLite store, no network required.
- **Area selection**: pick which area you're stationed at (from the areas synced for the event) before scanning.
- **Visual + audio feedback**: distinct green/red overlays plus a bright short "granted" tone and a lower sustained "denied" buzz (`expo-av`), tuned to be audible/visible in noisy, low-light entrances; the scan screen runs a dark theme throughout.
- **Manual entry fallback**: verify an attendee by email when their QR is damaged or unreadable.
- **Emergency / manual override**: security/admin-role scanners can grant or deny access outside the normal QR flow with a mandatory logged reason, synced to the backend and reviewable on the dashboard.
- **Incident reporting**: flag suspicious activity or technical issues from the scan screen; synced to the backend's incident queue.
- **Multi-user, role-aware UI**: multiple scanner accounts can log in/out on one device (quick-login list); security/admin roles see an extra "Emergency Override" action volunteers don't.
- **Live event sync**: logging in with a password authenticates against the backend and pulls this event's real users + areas down, uploads queued scan logs/incidents/overrides with retry + backoff, and reports a sync heartbeat the dashboard's real-time monitor reads. Leaving the password blank keeps the app fully offline on local demo data.
- **Sync-stale local warning**: a local notification (`expo-notifications`) fires if the device hasn't synced recently - there is no remote push in this app by design (scanners are expected to be actively at the device).

## 🛠️ Tech Stack (as actually built)

This is an **Expo (SDK 53) app**, not a bare React Native CLI project, and it uses `expo-camera`, not a separate "Vision Camera" native module:

- Expo Router (file-based navigation), TypeScript
- `expo-camera` for QR scanning
- `expo-sqlite`'s API surface, but backed by **`@op-engineering/op-sqlite` compiled with SQLCipher** for genuine at-rest database encryption (see below) - not plain `expo-sqlite`
- `expo-secure-store`, `expo-crypto`, `expo-av`, `expo-notifications`, `expo-application`

## 🔒 Local database encryption

Same mechanism as the pass app: the local database is a real SQLCipher-encrypted file (`@op-engineering/op-sqlite`), enabled via a `"op-sqlite": { "sqlcipher": true }` key in `package.json` (op-sqlite has no Expo config plugin - this is read directly by its own build scripts), keyed by a random 256-bit value generated on first run and held only in the platform secure keystore via `expo-secure-store`. Every app start verifies a SHA-256 checksum of the database contents; on corruption or tampering the database is genuinely deleted and recreated with a fresh key rather than reopening the same broken file. Synced event data is purged automatically once an event ends (plus a 24h grace period).

Because `op-sqlite` is a native module, **this app cannot run in Expo Go** - it requires a custom dev client or a full prebuild:

```bash
npm ci
npx expo prebuild        # generates ios/ and android/ native projects
npx expo run:android     # or: npx expo run:ios
```

## ⚙️ Configuration

Set `EXPO_PUBLIC_API_URL` (or `expo.extra.apiBaseUrl` in `app.json`) to your backend's `/api` URL.

## 📦 Scripts

- `npm start` — start the Expo dev server (use a dev client for the full feature set, including encryption)
- `npm run android` / `npm run ios` — run on device/emulator
- `npm run prebuild` — generate native projects
- `npm run build:android` / `npm run build:ios` — EAS cloud builds
- `npm run type-check` / `npm run lint` / `npm run doctor` — static validation
- `npm test` — non-watch Jest runner (no test files are committed yet)

## Future work

- Remote push to the scanner app (e.g. broadcasting a shift-change announcement) was left out of scope - only local sync-stale warnings are implemented per the spec. Wiring it up would reuse the same `device_tokens`/`push.ts` backend path already built for the pass app.
