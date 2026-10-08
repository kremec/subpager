# Subpager server

Receive Slovenian POCSAG pages with a Nooelec NESDR SMArt. Bun/TypeScript keeps durable SQLite reception history and recordings. The phone app uses Convex for private cloud history, anonymous authentication, manual approval and notification jobs. The receiver needs only outbound internet access in Convex mode and opens no HTTP listener. `rtl_fm` demodulates FM and pinned `multimon-ng 1.6.1` decodes POCSAG. There are zero runtime npm dependencies; the installed native tools handle the radio.

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
bun run start:api                              # disable radio; sync Convex if configured
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

Keep that terminal open. Startup should show `Subpager Convex` when configured, or `Subpager API` in local API mode, followed by `Receiver PCM resumed`; the second line confirms that audio samples arrived. New calls print their message ID and RIC. Stop with Ctrl+C before disconnecting the receiver/antenna or running doctor, record or calibrate. Reconnect and run the same start command when ready. Config changes require a restart.

In local API mode, check whether the API is listening from a second terminal:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

A Bun listener confirms the server process, not RF reception. No output means nothing is listening on the configured default port. Convex mode has no listener, so use the receiver's terminal output. In local API mode, the authenticated `/v1/status` endpoint also exposes audio freshness and receiver errors when a device key is available.

This MacBook currently has AC system sleep disabled, so `bun run start` is enough while plugged in with the lid open. If the power settings change, or you need to prevent idle sleep on battery, use temporary idle-sleep prevention:

```sh
caffeinate -i bun run start
```

macOS's built-in [caffeinate](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8) prevents idle system sleep only while that command runs. The display can turn off and lock. Keep the lid open; closing it or choosing Sleep can stop reception. Ctrl+C stops the server and its sleep-prevention wrapper. No service, login item, automatic startup or permanent power setting is installed.

The receiver watchdog restarts its native processes after 30 seconds without PCM while the server is running. Quiet traffic alone is not a failure: audio samples continue on an idle channel. Missed transmissions while stopped, asleep or disconnected cannot be recovered.

## Storage

`data/subpager.sqlite` stores messages, recordings, RIC unit mappings, deployment-specific cloud upload cursors and location jobs. Every reception is committed locally before network delivery. Convex messages use native document IDs; a separate ingestion mapping links them to numeric SQLite IDs for safe retries. Keep the receiver database when moving the receiver to another computer. A new database must not restart IDs against existing cloud history. Keep SQLite's `-wal` and `-shm` files while it runs. Never delete them manually. Keep private data out of Git.

Only decoded-call audio is archived. Defaults preserve eight seconds before decoding and four seconds after; nearby calls may have the same clip copied into each message row. `data/clips/` is temporary staging: files are removed after the SQLite commit. Startup retries complete WAV/metadata pairs left after a failure. `clips.maxFiles`/`maxBytes` bound staging files and may remove unarchived clips. They do not limit SQLite history. `clips.continuous` remains false, so idle noise is not archived.

Server output and errors go to the terminal with UTC timestamps and severity. Received-call logs include the message ID, reception time, RIC, function, type, repeat link and content. Known tuner startup diagnostics and continuous-clip success logs are suppressed. Unexpected diagnostics remain visible. Repeated identical errors print at most once every five minutes; changed failures and recovery print immediately. Control characters are escaped and log lines are bounded. No backup database is retained. The optional backup command creates a consistent snapshot only when explicitly run, requires an existing source database and refuses to overwrite its destination.

## Convex history, authentication and notifications

Backend source and deployment configuration live in `subpager-app/convex`. Configure the receiver with the deployment's HTTP actions URL and a private text file containing the same secret as its `RECEIVER_SECRET` environment variable:

```json
{
  "convex": {
    "siteUrl": "https://your-deployment.convex.site",
    "secretPath": "/private/path/convex-receiver-secret.txt"
  }
}
```

Paths can be absolute or relative to `config.json`. Store secret files outside the repositories with owner-only permissions. Do not put the receiver secret in the phone app. Replace the old `firebase` option before starting this version; an old configuration fails clearly instead of silently falling back to the local API.

The receiver uploads messages in batches of at most 100 using built-in `fetch`. The durable cursor is separate for each Convex deployment and advances only after a successful batch. Retries use the same IDs, so an ambiguous network failure does not create duplicate history or push jobs. Authentication and malformed-request failures retry after one hour; transient failures back off from 15 seconds to five minutes. Recordings stay in SQLite.

For initial migration, stop the receiver and run the explicit import before starting live reception. Do not run the import alongside live reception: imported messages intentionally do not queue alerts.

```sh
bun run history:import
```

This uploads pending history and all RIC mappings with notifications disabled. Rerunning it is safe. Normal receiver uploads request notification delivery. Convex atomically records the new message and schedules its notifications; old messages and deduplicated repetitions do not produce alerts. The receiver no longer mirrors cloud devices or polls membership. Convex owns device approvals, push tokens, tickets and delayed receipts.

The app creates a Convex anonymous identity and shows its device ID. Approve that new ID once:

```sh
bun run member:approve DEVICE_UID
bun run member:revoke DEVICE_UID
bun run member:list
```

Old Firebase IDs cannot prove ownership of a new Convex identity and do not transfer approval. Reinstalling or clearing app data can create another identity that needs approval. Revocation prevents cloud reads and future notifications. A notification already submitted to Expo cannot be recalled. An offline phone can retain its cache until it reconnects and receives the revocation.

Firebase remains necessary only for the Android FCM transport configured in Expo. Receiver database access and app authentication do not use Firebase.

### Location extraction

Optional extraction runs as a separate background worker and never delays message publication or notifications:

```json
{
  "location": {
    "model": "gpt-6-luna"
  }
}
```

Set `OPENAI_API_KEY` in the receiver repository's `.env` file. Bun loads it automatically when the receiver starts. `.env` and its variants are ignored by Git. Keep the file private and restart the receiver after changing the key. `"location": {}` enables extraction with the default model; leave out `location` to disable it. A missing key pauses extraction without stopping reception or cloud publication.

The worker uses the Responses API with no reasoning, standard service, a strict `{ "location": string|null }` schema and a 40-second timeout. The prompt treats pager content as data and asks for one exact contiguous location substring. A supplied postal address takes precedence over preceding incident details, rooms and approach directions; without an address, named schools and landmarks remain valid destinations. Code rejects inferred, reformatted or malformed output. A link is an extracted search destination, not a verified address or coordinate.

Each new text reception queues extraction in the same SQLite transaction. The extracted result is committed before its independent cloud update, so a cloud retry does not repeat paid inference. Existing history is queued only when explicitly requested:

```sh
bun run location:backfill
```

Start the receiver to process that queue. Authorization or quota failures pause the affected worker stage for one hour while message publication continues. An OpenAI failure pauses new extraction; already-extracted locations still upload. Other failures back off from 15 seconds to five minutes. Extraction stops retrying a message after five ordinary failures; cloud updates remain retryable. Failed jobs retain their error in `location_jobs`. There is no automatic paid API fallback or subscription credential reuse. A ChatGPT subscription does not pay for API usage.

### RIC unit mappings

Edit the local `ric_units` table, then run `bun run ric:sync`. The complete local snapshot replaces cloud mappings, so an empty table clears the cloud list. A missing source database aborts instead of creating an empty database. RICs are integers from 0 to 2097151 and names must be nonempty:

```sql
INSERT INTO ric_units (ric, unit_name) VALUES (90473, 'Unit name')
ON CONFLICT(ric) DO UPDATE SET unit_name = excluded.unit_name;
```

Phones subscribe to messages and mappings independently, so renaming a unit applies to existing history without rewriting messages. Later location updates patch the same message and do not send another notification.

## Local API mode

Without `convex`, the receiver retains its private local HTTP API for local tools. The Convex phone app does not use it.

The API defaults to `127.0.0.1:8787`. Every endpoint requires `Authorization: Bearer <device key>`. `device:add` prints a key once; only its hash is stored. Each key can read all history and receives alerts for all RICs.

- `GET /v1/messages?limit=50&before=123&ric=123456&q=test&includeRepeats=true`: newest-first history and `nextCursor`; limit 1–100. Repeats are hidden by default.
- `GET /v1/messages/:id`: message detail with numeric `ric`, reception timestamp, function, type, `content` and repeat link. Audio is fetched separately.
- `GET /v1/messages/:id/audio`: WAV from SQLite; 404 while pending or absent.
- `PUT /v1/devices/me`: register `{ "expoPushToken": "ExpoPushToken[...]" }`; legacy `rics` fields are ignored.
- `DELETE /v1/devices/me`: disable push while retaining history access.
- `GET /v1/status`: receiver state, audio freshness, errors, restarts and pending pushes.

In local API mode, identical live calls within `dedupeSeconds`, default 30, remain in history but alert once. Push jobs are durable and expire after `pushMaxAgeSeconds`, default 300. Token changes cancel pending work for the old subscription. Expo receipts show provider acceptance, not phone display. Receipt retries expire 24 hours after submission; legacy tickets without a stored submission time retain the reception-time cutoff. Completed push jobs are limited to the newest 1000; pending jobs and unexpired receipts are retained. If Expo accepts a push but its ticket response is lost, retrying can duplicate the notification. To enable enhanced Expo push security, set `EXPO_ACCESS_TOKEN` in the server's `.env`. Never put this token in the phone app. No real phone delivery has been verified.

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
