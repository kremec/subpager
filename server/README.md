# Subpager server

Receive Slovenian POCSAG pages with a Nooelec NESDR SMArt. This Bun/TypeScript process decodes radio pages, keeps unsent pages in a small filesystem outbox and commits them to Firestore. Firebase Auth provides anonymous identities. Firestore owns message history, device approval and durable push/location jobs; this process uploads messages and handles those jobs independently. There is no receiver database or HTTP API. `rtl_fm` demodulates FM and pinned `multimon-ng 1.6.1` decodes POCSAG. The official Firebase Admin SDK is the only direct runtime dependency.

## Branches

Use `develop` for active changes and `main` for reviewed releases. The previous SQLite/Firebase receiver is preserved at commit `39829c3`; the temporary migration archives were deleted after verifying Firestore. No deployment automation is configured.

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
bun run start:sync                             # upload pending pages with radio disabled
bun run record /tmp/page.wav 60
bun run replay /tmp/page.wav
bun run calibrate 120                          # manual gain comparison
bun run member:approve DEVICE_UID "Name"
bun run member:revoke DEVICE_UID
bun run member:list
bun run ric:sync /path/ric-units.json            # replace cloud RIC unit mappings
```

Arguments are positional: `record [output] [seconds]`, `calibrate [seconds] [report]`, `replay FILE` and `ric:sync FILE`. Record defaults to `./data/manual.wav` for 60 seconds; calibrate defaults to 120 seconds per gain and `./data/gain-survey.json`. In PowerShell, select config with `$env:SUBPAGER_CONFIG = "C:/path/config.json"`, then run the same package script. Record and calibrate need exclusive USB access. Replay uses the installed native decoder without USB and prints raw decoded pages. It does not queue or upload pages and sends no alerts. WAV input must be PCM16 mono at 22050 Hz. Manual captures refuse to overwrite existing paths and need manual cleanup. Gain surveys cannot rank gains from silence or unequal traffic. Automated tests create their own temporary inputs.

## Running manually on this MacBook

Reconnect the receiver and antenna, then open Terminal:

```sh
cd ~/Projects/prod/subpager-server
bun run start
```

Keep that terminal open. Startup shows `Subpager Firestore`, followed by `Receiver PCM resumed`; the second line confirms that audio samples arrived. Received calls print their message ID and RIC. Stop with Ctrl+C before disconnecting the receiver/antenna or running doctor, record or calibrate. Reconnect and run the same start command when ready. Config changes require a restart. There is no local listener to probe; use the receiver's terminal output.

This MacBook currently has AC system sleep disabled, so `bun run start` is enough while plugged in with the lid open. If the power settings change, or you need to prevent idle sleep on battery, use temporary idle-sleep prevention:

```sh
caffeinate -i bun run start
```

macOS's built-in [caffeinate](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8) prevents idle system sleep only while that command runs. The display can turn off and lock. Keep the lid open; closing it or choosing Sleep can stop reception. Ctrl+C stops the server and its sleep-prevention wrapper. No service, login item, automatic startup or permanent power setting is installed.

The receiver watchdog restarts its native processes after 30 seconds without PCM while the server is running. Quiet traffic alone is not a failure: audio samples continue on an idle channel. Missed transmissions while stopped, asleep or disconnected cannot be recovered.

## Outbox and recordings

Each reception gets a locally generated Firestore automatic document ID before it is written to `outbox`, default `./data/outbox`. The receiver writes one private JSON file per unsent page, syncs its contents, renames it atomically and syncs the directory on POSIX systems. Windows uses the file sync and atomic rename because Node cannot sync directories there. Complete temporary files left before a rename are recovered at startup. Incomplete temporary files are renamed with an `.incomplete` suffix and their paths are logged. Their bytes are retained without blocking reception or valid queued uploads. A storage failure stops reception with an error.

Uploads use batches of at most 100 pages, ordered by reception time with document ID ties. One upload runs at a time. Files are deleted only after all messages in the batch have committed to Firestore. A connection failure, lost acknowledgement or restart retains the same document ID, so Firestore transactions can recognize retries without creating duplicate messages or notification jobs. Transient failures back off from 15 seconds to five minutes; invalid data and authentication failures pause uploads for one hour. Shutdown waits for an upload already in flight. Run only one receiver process against an outbox. When moving computers, copy pending outbox files before starting reception on the new computer.

Decoded-message audio recording is enabled by default. Recordings stay on the server computer in `clips.directory`, default `./data/clips`, as WAV files with adjacent JSON metadata. Each clip includes eight seconds before decoding and four seconds after; nearby calls can share a clip. Recordings have no count or storage limit and are never deleted automatically. Continuous recording is not supported. Set `clips.enabled` to `false` to disable decoded-message recording. Audio is not uploaded to Firestore. The filesystem outbox remains separate from recordings.

Server output uses UTC timestamps and severity. Received-call logs include message ID, reception time, RIC, function, type and raw content. Known tuner startup diagnostics are suppressed. Repeated errors print at most once every five minutes; changed failures and recovery print immediately. Control characters are escaped and log lines are bounded.

## Firebase configuration

Keep the `radio` and `clips` settings and configure the receiver's outbox and Firebase project:

```json
{
  "outbox": "./data/outbox",
  "firebase": {
    "projectId": "your-firebase-project",
    "serviceAccountPath": "/private/path/receiver-service-account.json"
  }
}
```

Download a service account JSON from Firebase project settings, then store it outside Git with private file permissions. Its project must match `projectId`. Paths can be absolute or relative to `config.json`. Remove the former `database`, `api`, `convex`, `dedupeSeconds`, `pushMaxAgeSeconds` and `location` options. The receiver needs outbound internet access only, with no domain, tunnel or inbound port. Enable anonymous Firebase Auth and deploy the app's Firestore security rules separately.

Each page is normalized and stored in a Firestore transaction. Matching repeats within 30 seconds of the original canonical message are retained with `duplicateOf`, without creating another push or model job. Only canonical messages less than five minutes old queue notifications for approved members with a push token. Empty and tone pages skip location inference. Message writes commit independently of push and OpenAI calls, so model latency does not delay the live feed or notifications.

`pushJobs` and `locationJobs` are private Firestore collections. Each push job holds up to 100 recipients with independent tickets, receipt deadlines and retry state. One claim and one result commit process each batch; accepted recipients do not rejoin retries for failed recipients. The process listens for active jobs rather than repeatedly reading them on a timer. Persistent retry times and fenced leases allow unfinished jobs to resume after a restart. Successful push and location jobs are deleted after durable completion; failed jobs remain for diagnosis. Location results are saved before publication, then copied to the canonical message and its repeats. Expo tokens that are no longer valid are cleared only if the device still has the same token and update time. Run one receiver/job processor for this project.

One shared `users` listener supplies the ingest and push workers. It reads the roster once at startup, then receives changes instead of rereading every device for each page. Push delivery checks the latest cached approval and token immediately before sending and pauses when the roster listener fails. A recently changed approval can briefly lag in the listener; notifications already submitted to Expo cannot be recalled.

Messages receive a Firestore server `updatedAt` timestamp on creation and on location publication. The app keeps complete history in SQLite and, after one initial full load, downloads only records at or after its saved timestamp. It saves the changes and cursor together and pauses feed listeners while backgrounded. Legacy messages without timestamps are included in the initial load. History grows without increasing each open's steady-state read count. Hard-deleting a message while a phone is offline is not represented in this append-and-update protocol; a fresh cache is needed to reconcile such manual deletions.

Add `OPENAI_API_KEY` to the receiver's ignored `.env` file to enable location extraction. Bun loads `.env` automatically. Optional `EXPO_ACCESS_TOKEN` enables enhanced Expo push security. Keep both values out of Git and restart the receiver after changing them. Missing model credentials do not block reception, message upload or push processing.

The app silently creates a Firebase anonymous identity. Approve the device ID shown in its settings:

```sh
bun run member:approve DEVICE_UID "Name"
bun run member:revoke DEVICE_UID
bun run member:list
```

Approval, labels and push tokens are stored together in `users/{uid}` as `approved`, `label` and `expoPushToken`. Reinstalling or clearing app data can create an identity that needs approval again. Revocation stops cloud reads and future notifications. Notifications already submitted to Expo cannot be recalled; an offline phone can keep cached history until it reconnects and receives revocation. Firebase Cloud Messaging remains Expo's Android transport.

### RIC unit mappings

Publish a complete JSON array with `bun run ric:sync FILE`:

```json
[{ "ric": 90473, "unitName": "Unit name" }]
```

The command atomically writes two documents: `config/ricUnits` contains the complete array and its revision; `config/ricUnitsRevision` contains only the revision. Phones watch the small revision document and download the catalog only when it changes, saving the units and revision together in SQLite. An unchanged catalog costs one document read per connection, even with 1,000 mappings, without downloading the names again. An empty array clears it. RICs must be unique integers from 0 to 2097151 and names must be nonempty. The catalog has a 900 KB JSON safety budget for Firestore's 1 MiB document limit. Renaming a unit updates existing local history without rewriting messages. Legacy `ricUnits` documents are left untouched; new clients use the catalog.

### Activating the optimized protocol

These source changes do not update running processes, installed apps or Firestore rules. Deploy the app repository's `firestore.rules` and `firestore.indexes.json` together, stop the old receiver after its active push jobs finish, then run the updated receiver and update the phones. Old per-device push jobs and new batched jobs have different schemas; do not run mixed worker versions. Publish the RIC JSON once with the updated `ric:sync` command. Existing phone caches perform one full bootstrap, then use deltas. No message backfill or history deletion is needed. Keep indexes enabled for `receivedAt`, `updatedAt`, `duplicateOf` and active-job queries; the checked-in exemptions remove unused catalog, recipient, text and location indexes.

## Verified reception

On 2026-10-07 this Mac captured three live calls, IDs 1–3, with RICs `0790241`, `0705002` and `0790521`. Each SQLite recording reproduced its exact RIC, function, type and text through native replay. This establishes reception, not coverage or missed-call rate. Reference traffic and live Slovenian diacritics remain unverified. Hardware uses automatic gain, 0 PPM, librtlsdr 2.0.3 and multimon-ng 1.6.1.

A macOS 524288-byte stdout buffer previously delayed PCM by about 12 seconds. The receiver's macOS-only unbuffered environment removed that measured delay. A separate USB transfer error recovered automatically after about 33 seconds; its physical cause is unresolved. The old debug captures were removed; these findings remain here.

## Message fields

The receiver preserves decoded `content`, including rendered markers and raw line breaks. The receiver removes trailing `<EOT>`/`<NUL>` padding and replaces rendered or raw LF/CR line breaks with spaces once, preserving Slovenian characters and other content. Each decoded recording's JSON metadata contains the raw calls; its WAV contains original audio for replay. New messages and push jobs use Firestore automatic document IDs. Each message ID is generated once before saving the reception to the outbox; retries reuse that ID and read its document directly. The message and its jobs commit in one transaction, with location jobs reusing the message ID. No counters are needed. Existing history retains its original IDs `1–22`. Firebase user UIDs and numeric RIC values retain their original format.

`function` is the transmitted two-bit function value, 0–3, often called A–D. Its meaning depends on pager programming; it is not a known incident priority or unit label. All three verified calls used 3. `type` is `alpha` for text, `numeric` for numeric payload, or `tone` for an address-only alert with no content. The configured decoder forces alphanumeric interpretation for local paging, so `type` and function are not interchangeable. See the [pinned decoder implementation](https://github.com/EliasOenal/multimon-ng/blob/1.6.1/pocsag.c).

Numeric RIC remains the transmitted destination address and can filter history. Optional unit names come from the separately maintained Firestore RIC mappings.

## Development checks

```sh
bun run check
bun run lint
bun run format:check
bun test
```

Tests use temporary directories, generated inputs, simulated native processes and mocked SDK operations. They verify atomic outbox recovery, stable retry IDs, upload ordering, replay isolation, recording boundaries and process cleanup. They do not prove RF coverage or real phone delivery and do not install drivers or start host services.
