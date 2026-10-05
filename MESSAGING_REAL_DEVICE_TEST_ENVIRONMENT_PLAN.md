# TARIM360+1 — MESSAGING REAL-DEVICE TEST ENVIRONMENT PREPARATION

Backend repo: `C:\projeler\tarim360-strapi` — branch `fix/release-messaging-reliability`
Flutter repo: `C:\projeler\tarim360` — branch `fix/release-messaging-reliability`

**No code was changed, nothing was committed, nothing was pushed, nothing was deployed.** A local Strapi instance was started and stopped purely to verify the findings below (health check, §7) — the repo's tracked files are untouched.

---

## 1. Backend URL configuration (Flutter side)

Single source of truth: `lib/services/strapi_service.dart:7-29`, `StrapiConfig`.

```dart
static const String _envBaseUrl = String.fromEnvironment('STRAPI_BASE_URL', defaultValue: '');
static const String _envDefaultCloudBaseUrl = String.fromEnvironment(
  'DEFAULT_STRAPI_BASE_URL',
  defaultValue: 'https://safe-thrill-63a14bbf24.strapiapp.com',
);
static String get baseUrl {
  final raw = _envBaseUrl.isNotEmpty ? _envBaseUrl : _envDefaultCloudBaseUrl;
  return raw.endsWith('/') ? raw.substring(0, raw.length - 1) : raw;
}
```

- The production URL (`https://safe-thrill-63a14bbf24.strapiapp.com`) is **not hard-coded** in the sense of being unoverridable — it's a `String.fromEnvironment` *default value*, only used when `STRAPI_BASE_URL` is not supplied at compile time.
- **Override mechanism: `--dart-define=STRAPI_BASE_URL=<url>`** at build/run time. Confirmed by grep: this is the *only* file in `lib/` that references the production URL string — every other Strapi endpoint in the app (`apiUrl`, `conversationsMineEndpoint`, etc.) derives from `StrapiConfig.baseUrl`, so overriding this one value redirects the entire app, messaging included.
- All other backend-selection flags (`lib/main.dart:921-988`, `BackendRuntimeConfig.useStrapi*`, including `useStrapiMessages`) default to `true` and don't need to be touched — only `STRAPI_BASE_URL` needs setting for this test.
- No `--dart-define-from-file` config or launch.json convention exists in this repo; a plain command-line `--dart-define` is the established (only) mechanism.

---

## 2. Local Strapi network binding

`config/server.ts`:
```ts
host: env('HOST', '0.0.0.0'),
port: env.int('PORT', 1337),
```

The local `.env` (gitignored, not committed) already sets `HOST=0.0.0.0` and `PORT=1337` explicitly. **No config change is needed** — Strapi already binds to all network interfaces by default in this repo, not just `127.0.0.1`. Verified live (§7): the server was reachable from the machine's own LAN IP, not just `localhost`.

**Your machine's current LAN IP:** `172.20.10.11` (Wi-Fi adapter) — re-check at test time with `ipconfig` (Windows) since it can change between networks/reconnects; look for the IPv4 address under your active Wi-Fi adapter.

---

## 3. Database

`.env`: `DATABASE_CLIENT=sqlite`, `DATABASE_FILENAME=.tmp/data.db`. This is a **local file** (`C:\projeler\tarim360-strapi\.tmp\data.db`), already gitignored, already exists on this machine (pre-existing local dev data from earlier phases' work, ~2.5MB). Running the backend locally with the repo's own `.env` **cannot** reach production — there is no network path to Strapi Cloud's database from a local `sqlite` client; it's a different database engine entirely, not just a different connection string. Confirmed no `DATABASE_HOST`/production connection string is set anywhere that would override this.

**Zero risk of touching production data** as long as you run the backend from this repo with its own `.env` (don't set `DATABASE_CLIENT`/`DATABASE_HOST` env vars yourself before starting it).

---

## 4. Test accounts

No special tooling needed. Bootstrap config (`src/index.ts:386-388`) already has `allow_register: true`, `email_confirmation: false`, `default_role: 'authenticated'` — the app's own normal sign-up screen works immediately against the local instance. **Just register two new accounts through the app itself** once each phone is pointed at the test backend (e.g. `test-a@example.com` / `test-b@example.com`), same as any real user would. No admin panel, no seed script, no production account needed.

(A prior health-check run of mine already registered and used two throwaway accounts, `healthcheck-a2@test.local` / `healthcheck-b2@test.local`, to prove the flow end-to-end — see §7. They're harmless rows in your local `.tmp/data.db`; ignore or ignore-and-forget them, no cleanup needed unless you want a pristine DB.)

---

## 5. Flutter build/run command

Confirmed against the actual `StrapiConfig` source (§1) — this is the exact, real flag name, not guessed:

**Fastest for iterative testing (phone connected via USB, USB debugging on):**
```
flutter run --release --dart-define=STRAPI_BASE_URL=<your-https-tunnel-url>
```
Run once per connected device (`flutter devices` to list, add `-d <device_id>` if more than one is attached to this machine at once). `--release` is recommended over the debug default so the test reflects real performance/behavior; plain `flutter run` (debug mode) also works if you want hot-reload during the test.

**For a shareable APK (Android; install without a permanent USB tether):**
```
flutter build apk --release --dart-define=STRAPI_BASE_URL=<your-https-tunnel-url>
```
Output: `build/app/outputs/flutter-apk/app-release.apk` — copy/AirDrop/USB-transfer to each Android phone and install directly (enable "install unknown apps" for the transferring app first).

**iOS constraint:** this machine is Windows (win32). `flutter build ios` / `flutter run` targeting an iPhone requires a Mac with Xcode for code signing — not possible directly from this machine. If either test phone is an iPhone, you'll need your existing Mac/TestFlight pipeline (with the same `--dart-define=STRAPI_BASE_URL=...` flag added to whatever build command that pipeline uses) — flag this back to me if that's the case and we'll work out the exact command for that environment.

---

## 6. Android / iOS network restrictions — **found, and this blocks plain LAN HTTP**

Checked, not assumed:

- **Android:** `android/app/src/main/AndroidManifest.xml` has no `android:usesCleartextTraffic` attribute, and no `network_security_config.xml` exists anywhere in the project. The debug manifest (`android/app/src/debug/AndroidManifest.xml`) only adds the `INTERNET` permission, nothing about cleartext. `compileSdk`/`targetSdk` come from the Flutter tool's own defaults (modern, well above API 28). **Result: Android blocks plaintext `http://` to any host by default, including your LAN IP.** A build pointed at `http://172.20.10.11:1337` will fail every request with a network security exception.
- **iOS:** `ios/Runner/Info.plist` has no `NSAppTransportSecurity` key at all — no `NSAllowsArbitraryLoads`, no `NSAllowsLocalNetworking`, no per-domain exception. **Result: iOS's default App Transport Security blocks plain HTTP the same way.**

**Neither platform currently permits the LAN-HTTP setup your own plan described (phones → `http://<LAN-IP>:1337`). This is a real blocker, not a hypothetical one.**

Two ways forward:
1. **HTTPS tunnel (recommended — zero code change, works today):** run a tunnel that exposes your local Strapi over real TLS, and point `STRAPI_BASE_URL` at the tunnel's `https://` URL instead of the raw LAN IP. Both phones then just need internet (Wi-Fi or mobile data both work — no longer LAN-restricted at all, which also removes "same Wi-Fi" as a requirement). Neither the Android manifest nor the iOS Info.plist need to change, because it's genuine TLS, not an exception being carved out.
   - `cloudflared tunnel --url http://localhost:1337` — no account/signup needed, gives an ephemeral `https://*.trycloudflare.com` URL. Not installed on this machine yet (checked); would need `winget install --id Cloudflare.cloudflared` or a direct download from Cloudflare.
   - `ngrok http 1337` — needs a free account + authtoken the first time. Also not installed.
2. **Code change to allow LAN cleartext for local testing** (Android `network_security_config.xml` scoped to your LAN IP range or debug-only `usesCleartextTraffic`, iOS `NSAllowsLocalNetworking` or a scoped `NSExceptionDomains` entry) — **not done**, per this phase's read-only instruction ("Sırf test için güvenlik ayarlarını gevşetmeden önce dur"). If you'd rather do this than run a tunnel, say so explicitly and I'll scope it as its own small, disclosed change (and it would need its own build/commit, since it touches tracked platform config files).

**My recommendation: option 1 (tunnel).** It's zero code risk, works for both platforms uniformly, and is arguably a *better* test than raw LAN anyway (it's the same network path shape — real TLS, real internet hop — the app will use in production, just pointed at your local backend instead of Strapi Cloud).

---

## 7. Health check — performed now, backend confirmed working

Ran `npm start` (see note below on `npm run develop`) from `fix/release-messaging-reliability`, then verified and shut it back down:

| Check | Result |
|---|---|
| Boots successfully | Yes — "Strapi started successfully", Database: sqlite, `.tmp\data.db` |
| Bound to `0.0.0.0`, LAN-reachable | Yes — `http://172.20.10.11:1337/api/conversations/mine` responded (not connection-refused) |
| Messaging routes registered | Yes — `mine`, `PATCH .../read` (markRead), `POST .../message` (sendMessage) all returned `403` (auth-enforced), not `404` (would mean unregistered) |
| Uses test DB, not production | Yes — sqlite `.tmp/data.db`, confirmed in boot log; no path to Strapi Cloud's DB exists from this config |
| Full end-to-end smoke test | **Passed** — registered two throwaway accounts, A sent a message to B with a real `operationId`, B's `unreadCount` showed `1`, `PATCH .../read` returned `200`, B's `unreadCount` then showed `0`. M1 (identity)/M2 (read/unread)/M4 (idempotent send) all exercised successfully in one pass. |

**Caveat found (unrelated to messaging, pre-existing):** `npm run develop` (hot-reload dev mode) currently crashes while rebuilding the admin panel — an esbuild target-transform error in `@radix-ui`/`@tanstack` dependencies, unrelated to any messaging change. **Use `npm start` instead** (serves from the already-built `dist/`, which exists on this machine from earlier verification passes in this sprint) — confirmed working above. If you want hot-reload for some other reason later, that esbuild issue would need its own separate investigation; it does not block the real-device test.

---

## 8. Answers to A–G

**A) Command to start the backend:**
```
cd C:\projeler\tarim360-strapi
npm start
```
(Not `npm run develop` — see §7 caveat. `npm start` requires the existing `dist/` build, already present.)

**B) URL the phones will use:**
Not a raw LAN IP — per §6, plain `http://172.20.10.11:1337` will be blocked by both Android and iOS by default. Use an HTTPS tunnel URL instead, e.g.:
```
cloudflared tunnel --url http://localhost:1337
```
→ gives you an `https://<random>.trycloudflare.com` URL. Use that as the base URL in step C.

**C) Flutter build/run command:**
```
flutter run --release --dart-define=STRAPI_BASE_URL=https://<your-tunnel-subdomain>.trycloudflare.com
```
or, for an installable APK:
```
flutter build apk --release --dart-define=STRAPI_BASE_URL=https://<your-tunnel-subdomain>.trycloudflare.com
```

**D) Test accounts:**
Register two new accounts directly through the app's own sign-up screen once it's pointed at the tunnel URL (§4) — no special setup, no admin panel needed.

**E) Android/iOS network restrictions:**
Yes, both platforms block plain HTTP by default in this project's current config (§6) — this is why B/C above use a tunnel rather than the raw LAN IP.

**F) Risk of accidentally hitting production:**
None, as long as `STRAPI_BASE_URL` is explicitly set to the tunnel URL for every build/run command. If a build is ever made *without* the `--dart-define` flag, it silently falls back to the real production URL (`DEFAULT_STRAPI_BASE_URL`) — so double-check the flag is present on both phones' builds before testing. The backend side has zero production-DB exposure regardless (§3) — it's a structurally different database, not just a guarded connection.

**G) READY / BLOCKED:**
**READY — conditional on using an HTTPS tunnel URL, not the raw LAN IP.** Backend is fully verified working (§7, full E2E smoke test passed). The only gap versus your original LAN-only plan is §6 (cleartext blocked by default on both platforms) — resolved with zero code changes by using a tunnel instead of `http://<LAN-IP>`. If you specifically want raw LAN HTTP (e.g. to avoid any tunnel dependency), that requires a small, disclosed platform-config code change (§6, option 2) — tell me and I'll scope it separately; not done here per this phase's read-only instruction.

---

Next step, once you've picked tunnel-vs-LAN-config and have both phones ready: tell me and we can go step by step — "run this → install this on phone A → do this on phone B" — through the 10-item test scenario.
