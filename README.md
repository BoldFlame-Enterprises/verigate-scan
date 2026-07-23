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
- **Foreground event sync**: production login authenticates against the backend, pulls complete user/area snapshots, retains complete per-area assignments and the trusted event QR authority, and uploads each queue under its immutable originating event. The foreground scheduler uses a nominal 10-second cadence with bounded backoff/jitter; background execution is unsupported and manual feedback remains available. Blank-password local data is available only when `EXPO_PUBLIC_DEMO_MODE=true`.

- **Durable queue acknowledgements**: scans, incidents, and overrides preserve client record IDs, originating events, payloads, and occurrence times. Incident/override uploads process at most two batches of ten per foreground cycle. Accepted/known-duplicate records become synced, structured terminal rejections remain retained with bounded error metadata, and authentication/transient failures remain pending and stop safely.
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
- `npm test` — run the committed service/contract tests without watch mode

Private local EAS/signing/provider files such as `credentials.json`, `*.jks`, `*.p8`, `*.p12`, and `*.mobileprovision` are ignored. Firebase client configuration is a separate public-configuration policy decision, not blanket-classified as a private credential.

## Validation boundary

Repository release evidence covers signed Android cloud build/publication for an exact source revision. It does not prove installation, physical camera/biometric/SQLCipher behavior, offline recovery after process kill, two-device replay handling, or any iOS behavior. Scan intentionally implements only local sync-stale notifications; logout cancels the session-local warning before authentication state is cleared.
