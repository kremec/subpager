# Subpager server

Receive Slovenian POCSAG pages with a Nooelec NESDR SMArt. This Bun/TypeScript process decodes radio pages, keeps unsent pages in a small filesystem outbox and forwards them to Convex. Convex owns message history, normalization, deduplication, anonymous authentication, device approval, notifications and location extraction. There is no receiver database or HTTP API. `rtl_fm` demodulates FM and pinned `multimon-ng 1.6.1` decodes POCSAG. There are zero runtime npm dependencies.

## Branches

Use `develop` for active changes and `main` for reviewed releases. The previous SQLite/Firebase receiver is preserved at commit `39829c3`; private data and configuration have separate backups outside Git. No deployment automation is configured.

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
bun run member:approve DEVICE_UID
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

Keep that terminal open. Startup shows `Subpager Convex`, followed by `Receiver PCM resumed`; the second line confirms that audio samples arrived. Received calls print their reception UUID and RIC. Stop with Ctrl+C before disconnecting the receiver/antenna or running doctor, record or calibrate. Reconnect and run the same start command when ready. Config changes require a restart. There is no local listener to probe; use the receiver's terminal output.

This MacBook currently has AC system sleep disabled, so `bun run start` is enough while plugged in with the lid open. If the power settings change, or you need to prevent idle sleep on battery, use temporary idle-sleep prevention:

```sh
caffeinate -i bun run start
```

macOS's built-in [caffeinate](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8) prevents idle system sleep only while that command runs. The display can turn off and lock. Keep the lid open; closing it or choosing Sleep can stop reception. Ctrl+C stops the server and its sleep-prevention wrapper. No service, login item, automatic startup or permanent power setting is installed.

The receiver watchdog restarts its native processes after 30 seconds without PCM while the server is running. Quiet traffic alone is not a failure: audio samples continue on an idle channel. Missed transmissions while stopped, asleep or disconnected cannot be recovered.

## Outbox and recordings

Each reception gets a UUID before it is written to `outbox`, default `./data/outbox`. The receiver writes one private JSON file per unsent page, syncs its contents, renames it atomically and syncs the directory on POSIX systems. Windows uses the file sync and atomic rename because Node cannot sync directories there. Complete temporary files left before a rename are recovered at startup. Incomplete temporary files are renamed with an `.incomplete` suffix and their paths are logged. Their bytes are retained without blocking reception or valid queued uploads. A storage failure stops reception with an error.

Uploads use batches of at most 100 pages, ordered by reception time with UUID ties. One upload runs at a time. Files are deleted only after a successful Convex response has been fully read. A connection failure, lost acknowledgement or restart retains the same UUID, so Convex can recognize retries without creating duplicate messages or notification jobs. Transient failures back off from 15 seconds to five minutes; malformed requests and authentication failures pause uploads for one hour. Shutdown waits for an upload already in flight. Unsent files are never removed by recording retention. Run only one receiver process against an outbox. When moving computers, copy pending outbox files before starting reception on the new computer.

Decoded-call audio stays in `clips.directory` as WAV files with adjacent JSON metadata. Defaults retain eight seconds before decoding and four seconds after. Nearby calls can share a clip. `clips.maxFiles`, default 500, and `clips.maxBytes`, default 256 MiB, bound those recordings by deleting older clips and their metadata. `clips.continuous` remains false. Manual captures outside this generated clip naming scheme need manual cleanup. Audio is not uploaded to Convex. Existing SQLite history and recordings are retained in the migration backup, but this receiver version does not read or change them.

Server output uses UTC timestamps and severity. Received-call logs include UUID, reception time, RIC, function, type and raw content. Known tuner startup diagnostics and continuous-clip success logs are suppressed. Repeated errors print at most once every five minutes; changed failures and recovery print immediately. Control characters are escaped and log lines are bounded.

## Convex configuration

Backend source lives in `subpager-app/convex`. Keep the `radio` and `clips` settings and configure the receiver's outbox and deployment HTTP actions URL:

```json
{
  "outbox": "./data/outbox",
  "convex": {
    "siteUrl": "https://your-deployment.convex.site",
    "secretPath": "/private/path/receiver-secret.txt"
  }
}
```

The private text file must contain the same secret as the deployment's `RECEIVER_SECRET` environment variable. Paths can be absolute or relative to `config.json`. Keep the secret out of the app and Git. Remove the former `database`, `api`, `firebase`, `dedupeSeconds`, `pushMaxAgeSeconds` and `location` options; old configurations fail clearly. The receiver requires outbound internet access only, with no domain, tunnel or inbound port.

The ingest request contains `sourceId`, reception timestamp, RIC, function, type and raw content. Convex stores the message and queues notification/location work independently. It owns the deduplication window and notification expiry. The receiver does not poll devices, send notifications, call OpenAI or retain uploaded history. Configure `OPENAI_API_KEY` and optional enhanced Expo push credentials on the Convex deployment.

The app silently creates a Convex anonymous identity. Approve the device ID shown in its settings:

```sh
bun run member:approve DEVICE_UID
bun run member:revoke DEVICE_UID
bun run member:list
```

Old Firebase IDs do not transfer approval to a new identity. Reinstalling or clearing app data can create an identity that needs approval again. Revocation stops cloud reads and future notifications. Notifications already submitted to Expo cannot be recalled; an offline phone can keep cached history until it reconnects and receives revocation. Firebase is used only for Expo's Android FCM transport.

### RIC unit mappings

Edit mappings directly in Convex, or publish a complete JSON array with `bun run ric:sync FILE`:

```json
[{ "ric": 90473, "unitName": "Unit name" }]
```

The file replaces the complete cloud mapping list. An empty array clears it. RICs must be unique integers from 0 to 2097151 and names must be nonempty. The command validates the file before calling Convex. Phones subscribe to mappings independently, so a renamed unit updates existing history without rewriting messages.

## Verified reception

On 2026-10-07 this Mac captured three live calls, IDs 1–3, with RICs `0790241`, `0705002` and `0790521`. Each SQLite recording reproduced its exact RIC, function, type and text through native replay. This establishes reception, not coverage or missed-call rate. Reference traffic and live Slovenian diacritics remain unverified. Hardware uses automatic gain, 0 PPM, librtlsdr 2.0.3 and multimon-ng 1.6.1.

A macOS 524288-byte stdout buffer previously delayed PCM by about 12 seconds. The receiver's macOS-only unbuffered environment removed that measured delay. A separate USB transfer error recovered automatically after about 33 seconds; its physical cause is unresolved. The old debug captures were removed; these findings remain here.

## Message fields

The receiver preserves decoded `content`, including rendered markers and raw line breaks. Convex removes trailing `<EOT>`/`<NUL>` padding and replaces rendered or raw LF/CR line breaks with spaces once, preserving Slovenian characters and other content. Each decoded recording's JSON metadata contains the raw calls; its WAV contains original audio for replay. A reception's `sourceId` UUID makes network retries idempotent. Convex assigns the message's native document ID.

`function` is the transmitted two-bit function value, 0–3, often called A–D. Its meaning depends on pager programming; it is not a known incident priority or unit label. All three verified calls used 3. `type` is `alpha` for text, `numeric` for numeric payload, or `tone` for an address-only alert with no content. The configured decoder forces alphanumeric interpretation for local paging, so `type` and function are not interchangeable. See the [pinned decoder implementation](https://github.com/EliasOenal/multimon-ng/blob/1.6.1/pocsag.c).

Numeric RIC remains the transmitted destination address and can filter history. Optional unit names come from the separately maintained Convex RIC mappings.

## Development checks

```sh
bun run check
bun run lint
bun run format:check
bun test
```

Tests use temporary directories, generated inputs, simulated native processes and mocked upload responses. They verify atomic outbox recovery, stable retry UUIDs, upload ordering, replay isolation, recording boundaries and process cleanup. They do not prove RF coverage or real phone delivery and do not install drivers or start host services.
