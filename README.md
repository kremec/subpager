# Subpager server

Receive Slovenian POCSAG pages with a Nooelec NESDR SMArt. Bun/TypeScript manages SQLite history, recordings and notifications. The phone app uses Firebase for private cloud history and manual device approval. Firebase mode needs only outbound internet access and opens no HTTP listener. `rtl_fm` demodulates FM and pinned `multimon-ng 1.6.1` decodes POCSAG. There are zero runtime npm dependencies; the installed native tools handle the radio.

## Branches

Use `develop` for active changes and `main` for reviewed releases and deployments. Both local branches exist. Their initial commit is empty; current source files remain uncommitted on `develop`. No remote or deployment automation is configured.

## Physical setup

Connect the antenna cable's SMA connector to the receiver, finger-tight, then plug the receiver into USB. Use the telescopic whip upright near a window, with its entire length above the bottom frame. Put the magnetic base on a metal tray or similar surface and keep it away from computer, power and network cables.

Start with approximately 43 cm of whip above the base. This is a quarter wavelength at 173.250 MHz, a starting point rather than a proven optimum. Use the telescopic antenna rather than the bundled fixed 433 MHz/UHF rods. Automatic gain and 0 PPM are the baseline. Change gain, placement or filtering only using comparable real transmissions.

The [University of Ljubljana receiver study](https://www.lait.fe.uni-lj.si/gradiva/dk/lab/ZARE-rupnik-2020.pdf) documents ZA-RE paging at 173.250 MHz using POCSAG1200. One receiver captures reachable transmitters, not every national call.

## Install and run

Install [Bun](https://bun.sh/docs/installation), then run from this directory:

```sh
bun install
bun run setup
bun run doctor
bun run start
```

`bun run setup` selects `scripts/setup.sh` on macOS/Linux or `scripts/setup.ps1` on Windows. Setup installs the native tools and creates ignored `config.json` if absent. It preserves an existing config. Doctor checks dependencies and a finite USB I/Q capture; it cannot prove pager coverage. Stop the listener before any other command uses the dongle.

On macOS, install Homebrew and Apple command line tools first. Setup installs Homebrew `librtlsdr` and builds the pinned decoder as `bin/multimon-ng-1.6.1`. On Debian/Ubuntu, setup installs the receiver and build packages with apt. For non-root USB permissions, run `bun run setup:usb`, then unplug/replug the receiver. If Linux's DVB driver owns the dongle, follow the [Nooelec Ubuntu guide](https://www.nooelec.com/store/downloads/dl/file/id/72/product/0/nesdr_installation_manual_for_ubuntu.pdf). Do not run the server as root.

On Windows x64, setup downloads and checks the official decoder archive. Install RTL-SDR separately with `pacman -S --needed mingw-w64-ucrt-x86_64-rtl-sdr` in MSYS2 UCRT64. Use [Zadig through Nooelec's guide](https://www.nooelec.com/store/qs) to bind only the NESDR interface to WinUSB. Set `radio.rtlFmPath` to `C:/msys64/ucrt64/bin/rtl_fm.exe` and `radio.multimonPath` to the absolute `bin/multimon-ng-1.6.1.exe` path. Keep native DLLs with their executables. The `bin/` directory holds only the decoder executable and required DLLs, without a version marker. Windows reception has not been tested here.

## Configuration and commands

`bun run init` creates config without installing anything. Set `SUBPAGER_CONFIG` to select a config file; it defaults to `./config.json`. Paths are relative to the config file; executable names without a slash use PATH. `radio.frequencyHz` defaults to `173250000`, `gain` to `"auto"`, and `ppm` to `0`. There is no squelch or de-emphasis. The frequency offset printed by rtl_fm is its internal center-spike avoidance, not a reason to change the configured channel.

```sh
SUBPAGER_CONFIG=/path/config.json bun run start # macOS/Linux
bun run start:api                              # disable radio; sync Firebase if configured
bun run record /tmp/page.wav 60
bun run replay /tmp/page.wav
bun run calibrate 120                          # manual gain comparison
bun run backup /path/new-backup.sqlite
bun run device:add "My phone"
bun run device:revoke DEVICE_ID
bun run ric:sync                              # publish local RIC unit mappings
```

Arguments are positional: `record [output] [seconds]`, `calibrate [seconds] [report]`, `replay FILE`, `backup FILE`, `device:add NAME`, and `device:revoke ID`. Record defaults to `./data/manual.wav` for 60 seconds; calibrate defaults to 120 seconds per gain and `./data/gain-survey.json`. In PowerShell, select config with `$env:SUBPAGER_CONFIG = "C:/path/config.json"`, then run the same package script. Record and calibrate need exclusive USB access. Replay uses the installed native decoder without USB, cannot write to received-message history and sends no alerts. WAV input must be PCM16 mono at 22050 Hz. Manual captures refuse to overwrite existing paths and need manual cleanup. Gain surveys cannot rank gains from silence or unequal traffic. No standalone fixtures are needed; automated tests create their own temporary inputs.

## Running manually on this MacBook

Reconnect the receiver and antenna, then open Terminal:

```sh
cd ~/Projects/prod/subpager-server
bun run start
```

Keep that terminal open. Startup should show `Subpager Firebase` when configured, or `Subpager API` in local API mode, followed by `Receiver PCM resumed`; the second line confirms that audio samples arrived. New calls print their message ID and RIC. Stop with Ctrl+C before disconnecting the receiver/antenna or running doctor, record or calibrate. Reconnect and run the same start command when ready. Config changes require a restart.

In local API mode, check whether the API is listening from a second terminal:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

A Bun listener confirms the server process, not RF reception. No output means nothing is listening on the configured default port. Firebase mode has no listener, so use the receiver's terminal output. In local API mode, the authenticated `/v1/status` endpoint also exposes audio freshness and receiver errors when a device key is available.

This MacBook currently has AC system sleep disabled, so `bun run start` is enough while plugged in with the lid open. If the power settings change, or you need to prevent idle sleep on battery, use temporary idle-sleep prevention:

```sh
caffeinate -i bun run start
```

macOS's built-in [caffeinate](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8) prevents idle system sleep only while that command runs. The display can turn off and lock. Keep the lid open; closing it or choosing Sleep can stop reception. Ctrl+C stops the server and its sleep-prevention wrapper. No service, login item, automatic startup or permanent power setting is installed.

The receiver watchdog restarts its native processes after 30 seconds without PCM while the server is running. Quiet traffic alone is not a failure: audio samples continue on an idle channel. Missed transmissions while stopped, asleep or disconnected cannot be recovered.

## Storage

`data/subpager.sqlite` stores `messages`, `ric_units`, `devices` and `push_jobs`. Each received message holds its reception time, RIC, function, type, content, repeat link and WAV audio. Message fields are immutable after reception; WAV audio can be attached later. Notification titles show the seven-digit RIC and reception time in Ljubljana local time, using `DD/MM/YYYY, HH:mm`; their body is the normalized received content. Device rows hold API key hashes and phone tokens; push jobs track each phone's delivery separately. Device rows also retain pending cleanup when Expo reports a Firebase token as unregistered. Keep SQLite's `-wal` and `-shm` files while it runs; never delete them manually. Keep the database on local storage and all private data out of Git. Preserve this receiver database: cloud document IDs use its numeric message IDs, so a replacement database must not restart those IDs against existing cloud history.

Only decoded-call audio is archived. Defaults preserve eight seconds before decoding and four seconds after; nearby calls may have the same clip copied into each message row. `data/clips/` is temporary staging: files are removed after the SQLite commit. Startup retries complete WAV/metadata pairs left after a failure. `clips.maxFiles`/`maxBytes` bound staging files and may remove unarchived clips. They do not limit SQLite history. `clips.continuous` remains false, so idle noise is not archived.

Server output and errors go to the terminal with UTC timestamps and severity. Received-call logs include the message ID, reception time, RIC, function, type, repeat link and content. Known tuner startup diagnostics and continuous-clip success logs are suppressed. Unexpected diagnostics remain visible. Repeated identical errors print at most once every five minutes; changed failures and recovery print immediately. Control characters are escaped and log lines are bounded. No backup database is retained. The optional backup command creates a consistent snapshot only when explicitly run, requires an existing source database and refuses to overwrite its destination.

## Private Firebase history and notifications

The app silently creates a Firebase anonymous identity and shows its UID. There is no sign-in screen. A UID is an identifier, not a password; Firebase authentication proves ownership. Google Play's internal tester list controls downloads separately from Firebase's data whitelist. Add a friend's email in Play first, then approve the installed app's UID once. Reinstalling, clearing app data or changing phones can create a new UID that needs approval.

Configured on 2026-10-08 in `subpager-subbyte`: Anonymous Authentication with cleanup disabled, the default Standard Firestore database in `europe-west3` (Frankfurt), and the included whitelist rules. The project remains on the free Spark plan. The dedicated `subpager-receiver@subpager-subbyte.iam.gserviceaccount.com` account has only `roles/datastore.user`; temporary rules-deployment access was removed after setup. Its key is stored at `~/.config/subpager/receiver-service-account.json` with owner-only permissions, outside both repositories. The local ignored `config.json` points to this key.

The following steps describe setup or replacement:

1. In the app's Firebase project `subpager-subbyte`, enable Anonymous Authentication. Leave automatic anonymous-account cleanup disabled, because it can delete device identities after 30 days. See [Firebase anonymous authentication](https://firebase.google.com/docs/auth/android/anonymous-auth).
2. Create the default Firestore database in production mode. Deploy the included `firestore.rules` before configuring receiver uploads. These rules allow only approved identities to read messages and RIC unit mappings, only owners to read their own approval, and only approved owners to register their own device. All other client access is denied. Clients cannot write history, mappings or approvals. See [Firebase rule conditions](https://firebase.google.com/docs/rules/basics).
3. Use a private receiver service-account JSON key with Firestore read/write permissions, such as `roles/datastore.user`. Privileged service accounts bypass client security rules; never include this key in the app or Git. Prefer a dedicated receiver account rather than expanding the app's push credential permissions. See [Firestore IAM](https://firebase.google.com/docs/firestore/security/iam).
4. Add `firebase` to the receiver's existing config. The key path is relative to that config file, or absolute:

```json
{
  "firebase": {
    "projectId": "subpager-subbyte",
    "serviceAccountPath": "/private/path/receiver-service-account.json"
  }
}
```

With this option, the receiver opens no HTTP listener and ignores legacy API-key devices for new alerts. Phones connect directly to Firebase's authenticated, whitelist-protected endpoints. No domain, tunnel or public Mac API is needed. The receiver uses built-in APIs for Firestore REST requests and service-account OAuth.

Manage one approval for both history and notifications:

```sh
bun run member:approve FIREBASE_UID "Friend's name"
bun run member:revoke FIREBASE_UID
bun run member:list
```

These commands change or inspect `members/{uid}`. Approval is strictly `approved: true`; false or a missing document denies access. Members cannot approve themselves. The receiver checks current membership and token before each send and sends nothing if the check fails. All approved phones with registered tokens receive alerts for all RICs. Revocation stops future sends and cloud reads. Content already copied or dispatched cannot be recalled; an offline phone can retain cached history until it reconnects and observes revocation.

The receiver refreshes its local approved subscriptions every 60 seconds. A new approval or token can take up to 60 seconds to affect which future calls are queued; send authorization still reads the current remote membership and subscription. With two member documents and two device documents, this polling uses about 5760 document reads per day, down from 23040 at the previous 15-second interval. These counts exclude send authorization, app reads and manual commands.

When Expo reports `DeviceNotRegistered`, the receiver disables that token locally and clears only `expoPushToken` in Firestore, retaining other document fields. Cleanup uses the device document version captured during authorization, so a newer registration is preserved. Failed cleanup remains on the device row and follows Firebase retry backoff; polling cannot reactivate it while cleanup is pending. Accepted tickets retain that version for delayed receipts. After cleanup, the app can register again with the same token. Existing rejection rows migrate into device rows, and the obsolete `firebase_rejected_tokens` table is removed.

History is append-only and has one uploader. At startup, the receiver queries Firestore for the highest numeric message `id`, then uploads local messages after that ID, oldest first in batches of 100. The cursor stays in memory and advances only after a successful upload. Each restart reads the remote cursor again; no local upload checkpoint table is needed. A failed startup query pauses cloud uploads and push authorization until it succeeds. Failed uploads retry the same document IDs, with retry delays increasing from 15 seconds to a maximum of five minutes and resetting after recovery. Concurrent Firestore requests share an OAuth refresh. Existing and offline receptions are backfilled without creating old alerts. A pending alert waits until its history document has uploaded, and still expires after `pushMaxAgeSeconds`. Cloud documents contain message fields and repeat links; WAV audio stays in local SQLite. Uploaded messages are not scanned for edits or uploaded again. On opening an existing database, the server removes obsolete checkpoint and revision tables and triggers while preserving history, recordings and push jobs. There is no migration reupload. This assumes remote history is written only by this uploader in increasing ID order.

On 2026-10-08, the project's Spark write quota was exhausted. The confirmed cause was repeated phone token registration; the app source has been corrected. Server failures preserve the in-memory upload cursor and report the Firestore HTTP operation and error. The expected quota reset is around 09:00 Ljubljana time on 2026-10-09. Restart the receiver with the updated source when ready. Local checks use temporary databases, fake radio processes and mocked transports; they cannot establish that quota has recovered, cloud writes succeed, RF reception works or a phone displays a notification. No live restart, upload, push or rules deployment is part of those checks.

### RIC unit mappings

Edit `ric_units` in the configured receiver database. RICs are unique integers from 0 to 2097151; `unit_name` must be nonempty. The schema is created when the updated `Store` first opens the database. To initialize it without starting the receiver or connecting to Firebase:

```sh
bun -e 'import { loadConfig } from "./src/config"; import { Store } from "./src/store"; using db = new Store((await loadConfig()).database).db'
```

For example, run this SQL in your SQLite editor, replacing the address and name:

```sql
INSERT INTO ric_units (ric, unit_name) VALUES (90473, 'Unit name')
ON CONFLICT(ric) DO UPDATE SET unit_name = excluded.unit_name;
```

Then run `bun run ric:sync`. It validates the complete local snapshot, writes only new or changed mappings, and removes cloud mappings absent locally. An empty local table clears the cloud mappings. A missing database aborts instead of creating an empty database. Firestore stores `ricUnits/{numericRic}` with `ric` and `unitName`; writes use batches of at most 500. Interrupted syncs can be rerun. Apps cache mappings separately from messages, so renaming a unit updates both old and new messages without rewriting message history. Publish the updated `firestore.rules` to allow approved phones to read this collection; the source change does not deploy rules.

An approved phone writes `devices/{uid}` with its Expo token. The app still includes `rics: []` for compatibility with the deployed rules; the receiver ignores that obsolete field. Removing it from app writes requires updating the deployed rules first. Disabled OS notifications produce a null token when the app next resumes, while history still works. Re-enabling notifications registers the current token for future calls. The phone synchronizes immutable message history and RIC mappings on reconnect; existing mapping changes are applied. Install a new native app build for Firebase persistence and clipboard support; an OTA update alone is insufficient.

The original cloud setup passed 80 Rules API tests and 18 live client-access checks, including unapproved/revoked history denial, self-approval denial, approved device registration with a null notification token, and isolation from other devices. The RIC mapping rule was deployed on 2026-10-08, and the active rules source matches this file. The deployment credential does not permit Rules API tests; the expanded mocked access tests were not executed. Live mapping reads have not been verified. The temporary verification account and documents from the original setup were deleted. Initial backfill uploaded the eight existing messages without enqueueing or sending notifications.

## Local API mode

Without `firebase`, the receiver retains its private local HTTP API. The Firebase phone app does not use this API.

The API defaults to `127.0.0.1:8787`. Every endpoint requires `Authorization: Bearer <device key>`. `device:add` prints a key once; only its hash is stored. Each key can read all history and receives alerts for all RICs.

- `GET /v1/messages?limit=50&before=123&ric=123456&q=test&includeRepeats=true`: newest-first history and `nextCursor`; limit 1–100. Repeats are hidden by default.
- `GET /v1/messages/:id`: message detail with numeric `ric`, reception timestamp, function, type, `content` and repeat link. Audio is fetched separately.
- `GET /v1/messages/:id/audio`: WAV from SQLite; 404 while pending or absent.
- `PUT /v1/devices/me`: register `{ "expoPushToken": "ExpoPushToken[...]" }`; legacy `rics` fields are ignored.
- `DELETE /v1/devices/me`: disable push while retaining history access.
- `GET /v1/status`: receiver state, audio freshness, errors, restarts and pending pushes.

In both modes, identical live calls within `dedupeSeconds`, default 30, remain in history but alert once. Push jobs are durable and expire after `pushMaxAgeSeconds`, default 300. Token changes cancel pending work for the old subscription. Expo receipts show provider acceptance, not phone display. Receipt retries expire 24 hours after submission; legacy tickets without a stored submission time retain the reception-time cutoff. Completed push jobs are limited to the newest 1000; pending jobs and unexpired receipts are retained. If Expo accepts a push but its ticket response is lost, retrying can duplicate the notification. To enable enhanced Expo push security, set `EXPO_ACCESS_TOKEN` in the server's `.env`. Never put this token in the phone app. No real phone delivery has been verified.

## Verified reception

On 2026-10-07 this Mac captured three live calls, IDs 1–3, with RICs `0790241`, `0705002` and `0790521`. Each SQLite recording reproduced its exact RIC, function, type and text through native replay. This establishes reception, not coverage or missed-call rate. Reference traffic and live Slovenian diacritics remain unverified. Hardware uses automatic gain, 0 PPM, librtlsdr 2.0.3 and multimon-ng 1.6.1.

A macOS 524288-byte stdout buffer previously delayed PCM by about 12 seconds. The receiver's macOS-only unbuffered environment removed that measured delay. A separate USB transfer error recovered automatically after about 33 seconds; its physical cause is unresolved. The old debug captures were removed; these findings remain here.

## Message fields

`content` is the decoded message with trailing `<EOT>`/`<NUL>` padding removed and rendered or raw LF/CR line breaks converted to spaces. CRLF pairs become one space. Other internal markers, existing spaces and Slovenian characters are preserved. Raw decoder JSON is not stored. `wav` holds the original recorded audio, so the decoder can reproduce the page later. History JSON omits the BLOB. `source` is unnecessary because replay and test messages cannot be saved into this history.

`function` is the transmitted two-bit function value, 0–3, often called A–D. Its meaning depends on pager programming; it is not a known incident priority or unit label. All three verified calls used 3. `type` is `alpha` for text, `numeric` for numeric payload, or `tone` for an address-only alert with no content. The configured decoder forces alphanumeric interpretation for local paging, so `type` and function are not interchangeable. See the [pinned decoder implementation](https://github.com/EliasOenal/multimon-ng/blob/1.6.1/pocsag.c).

Numeric RIC remains the transmitted destination address and can filter history. Optional unit names come from the separately synchronized `ric_units` table.

## Development checks

```sh
bun run check
bun run lint
bun run format:check
bun test
```

Tests use temporary databases, generated inputs, simulated native processes and mocked delivery responses. They verify storage, replay isolation, authentication, dedupe, retries, recording boundaries and process cleanup. They do not prove RF coverage or real phone delivery and do not install drivers or start host services.
