# VeriGate Scan App

The mobile app scanners/staff use to verify attendee QR codes offline against a locally synced access database.

## 🚀 Features

- **Offline QR verification**: strict, separate v2/v3 parsers verify authority
  and Pass-device P-256 signatures, time/event bounds, synchronized revocations,
  and current active area/access assignments against encrypted local state.
- **Bounded trust freshness**: a trust snapshot is current for 60 seconds,
  soft-stale until its 24-hour hard expiry, and unusable afterward. Current
  conclusive decisions stay local; cryptographically valid but inconclusive
  decisions use authenticated server authority when reachable and otherwise
  deny.
- **Complete decision evidence**: every camera attempt receives a durable
  `device_scan_id`, including malformed and unknown-subject denials. Queue and
  server fallback share idempotent acknowledgements and retain decision code,
  source, credential identity/nonce hash, trust generation, and snapshot time—
  never raw QR, nonce, signatures, or key material.
- **Area selection**: pick which area you're stationed at (from the areas synced for the event) before scanning.
- **Visual + audio feedback**: distinct green/red overlays plus a bright short "granted" tone and a lower sustained "denied" buzz (`expo-av`), tuned to be audible/visible in noisy, low-light entrances; the scan screen runs a dark theme throughout.
- **Manual entry fallback**: verify an attendee by email when their QR is damaged or unreadable.
- **Emergency / manual override**: security/admin-role scanners can grant or deny access outside the normal QR flow with a mandatory logged reason, synced to the backend and reviewable on the dashboard.
- **Incident reporting**: flag suspicious activity or technical issues from the scan screen; synced to the backend's incident queue.
- **Multi-user, role-aware UI**: multiple scanner accounts can log in/out on one device (quick-login list); security/admin roles see an extra "Emergency Override" action volunteers don't.
- **Foreground event sync**: account authority selects and persists the event
  before device-session exchange. Later synchronization uses only the signed
  registration event and does not call account-only `/events`. Complete QR
  trust, users, areas, and active-cycle metadata promote in one SQLite
  transaction, so authorization readers observe the whole previous or whole
  new cycle. Requests and refresh have bounded deadlines and preserve
  idempotency keys across safe retries. The foreground scheduler uses a nominal
  10-second cadence with bounded backoff/jitter; background execution is
  unsupported and manual feedback remains available. Blank-password local data
  is available only when `EXPO_PUBLIC_DEMO_MODE=true`.
- **Installation-bound sessions and revocation**: production login exchanges the account session for a Scan registration scoped to one event and installation. Connected launch, resume, scheduler, scanner, and upload paths enforce that registration and show a durable re-login notice after revocation. Blacklisting stops scanning and performs no final upload. Deregistration stops new records and may use a server-issued 15-minute audit credential only for acknowledged scan, incident, and override records whose occurrence time is at or before the authoritative deregistration cutoff; ineligible or unacknowledged rows remain inspectable locally.
- **Revocable logout**: manual logout attempts server-side family revocation,
  then clears local tokens, queues' active authority, and UI state even if the
  network request fails.

- **Durable queue acknowledgements**: scans, incidents, and overrides preserve
  client record IDs, originating events, bounded evidence, and occurrence
  times. Active scan selection is event- and retry-time-qualified. Every scan
  acknowledgement records attempts, next retry, terminal reason, server ID,
  and acknowledgement time as applicable; terminal poison rows remain locally
  inspectable without blocking later eligible rows. Incident/override uploads
  process at most two batches of ten per foreground cycle.
- **Event-transition recovery**: moving a Scan registration to a new event
  quarantines unauthorized old-event work and drains eligible prior-event rows
  only with a separately signed cutoff/deadline audit credential. Blacklisted,
  expired, or post-cutoff work receives no audit authority.
- **Installation-qualified legacy identities**: one SecureStore-backed installation identity is shared by heartbeat and migration of pending rows that never received a client identity. It remains stable across restarts; newly queued records continue to use random UUIDs. A build that finds an already-assigned weak `legacy-incident-<row>` or `legacy-override-<row>` identity stops before changing it because a lost upload acknowledgement cannot be distinguished locally from a never-uploaded row.
- **Sync-stale local warning**: a local notification (`expo-notifications`) fires if the device hasn't synced recently - there is no remote push in this app by design (scanners are expected to be actively at the device).

## 🛠️ Tech Stack (as actually built)

This is an **Expo (SDK 53) app**, not a bare React Native CLI project, and it uses `expo-camera`, not a separate "Vision Camera" native module:

- Expo Router (file-based navigation), TypeScript
- `expo-camera` for QR scanning
- `expo-sqlite`'s API surface, but backed by **`@op-engineering/op-sqlite` compiled with SQLCipher** for genuine at-rest database encryption (see below) - not plain `expo-sqlite`
- `expo-secure-store`, `expo-crypto`, `expo-av`, `expo-notifications`

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

Strict v2 verification remains a compatibility path. Do not remove it until
supported Scan adoption, synchronized trust freshness, Pass v3 adoption, the
maximum legacy credential/offline windows, physical camera coverage, and the
staged authority-key overlap exercise have all been recorded and approved.

Do not release the installation-identity migration until the deployed Scan
inventory and the lost-ack reconciliation policy are approved with compatible
backend behavior. Follow the aggregate repository's
`docs/database-operations.md` rollout gate.
