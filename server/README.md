# Subpager server

Receive Slovenian POCSAG pages with a Nooelec NESDR SMArt. This Bun/TypeScript process decodes radio pages, keeps unsent pages in a small filesystem outbox and commits them to Firestore. Firebase Auth provides anonymous identities. Firestore owns message history, device approval and durable push/location jobs; this process uploads messages and handles those jobs independently. There is no receiver database or HTTP API. `rtl_fm` demodulates FM and pinned `multimon-ng 1.6.1` decodes POCSAG. Runtime dependencies are the Firebase Admin SDK and `fast-xml-parser` for validated RSS parsing.

## Branches

Use `develop` for active changes and `main` for reviewed releases. The previous SQLite/Firebase receiver is preserved at commit `39829c3`; the temporary migration archives were deleted after verifying Firestore.

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

## Deploy to the TV box

Edit and test on the Mac, then run from the repository root:

```sh
bun run server:deploy
ssh subpager-server
```

Deploy checks TypeScript, uploads the current working tree's server code over
SSH, and installs production dependencies from the root lockfile in a temporary
directory. It then stops the receiver, replaces the code and dependencies, and
starts the OpenRC service. Reception pauses briefly during the restart.
An upload or dependency-install failure leaves the running server unchanged.

The box keeps its `.env`, `config.json`, credentials, native tools and `data/`.
App source is not deployed. No build or Git push is required.
SSH uses the `subpager-server` entry in `~/setup/dotfiles/ssh_config`.
Press `q` for the shell, then use `logs -f` for live output.

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
bun run message:delete MESSAGE_ID              # remove a pager from synced history
```

Use `message:delete` instead of hard-deleting a Firestore message. It preserves the original message payload and envelope with `deleted: true` and a fresh `updatedAt`, clears location/SPIN annotations, and deletes location, SPIN and active push jobs in one transaction. Apps supporting deletion markers remove the cached row when they receive it, including after being offline; older app bundles still display the original message. Retain deletion markers so long-offline phones can catch up. Already sent notifications cannot be recalled.

Arguments are positional: `record [output] [seconds]`, `calibrate [seconds] [report]`, `replay FILE` and `ric:sync FILE`. Record defaults to `./data/manual.wav` for 60 seconds; calibrate defaults to 120 seconds per gain and `./data/gain-survey.json`. In PowerShell, select config with `$env:SUBPAGER_CONFIG = "C:/path/config.json"`, then run the same package script. Record and calibrate need exclusive USB access. Replay uses the installed native decoder without USB and prints raw decoded pages. It does not queue or upload pages and sends no alerts. WAV input must be PCM16 mono at 22050 Hz. Manual captures refuse to overwrite existing paths and need manual cleanup. Gain surveys cannot rank gains from silence or unequal traffic. Automated tests create their own temporary inputs.

## Running manually on this MacBook

Reconnect the receiver and antenna, then open Terminal:

```sh
cd ~/Projects/prod/subpager/server
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

Matching text calls within three minutes share one canonical Firestore message with distinct `rics` and all `sourceIds`. Later receptions update that message without creating another message, push, location job or SPIN job. Reception time and body stay anchored to the first stored call. Long alpha messages tolerate a few decoding errors, while changed numbers and short differing instructions stay separate. Tone and empty calls retain same-RIC repeat suppression within 30 seconds. The original scalar `ric` remains for older installed app bundles; the updated app uses `rics`. Source IDs remain on deleted canonicals so retries cannot recreate a deleted call. The initial push contains the first reception's RIC; later RICs appear in the feed.

For existing history, `bun scripts/group-history.ts` previews the migration. Stop the receiver and workers, then use `--apply --receiver-stopped --backup-dir /ABS/PATH/OUTSIDE/REPO`. The script saves a private backup, merges compatible history and enrichment, removes merged jobs, and retains deletion markers for offline phone caches. It creates no notification or inference jobs. Deploy the updated receiver before resuming reception.

Decoded-message audio recording is enabled by default. Recordings stay on the server computer in `clips.directory`, default `./data/clips`, as WAV files with adjacent JSON metadata. Each clip includes eight seconds before decoding and four seconds after; nearby calls can share a clip. Recordings have no count or storage limit and are never deleted automatically. Continuous recording is not supported. Set `clips.enabled` to `false` to disable decoded-message recording. Audio is not uploaded to Firestore. The filesystem outbox remains separate from recordings.

Server output uses UTC timestamps and severity. Received-call logs include message ID, reception time, RIC, function, type and raw content. OpenAI location-result logs include the message ID, model, request duration in milliseconds and returned JSON, before validation and Firestore persistence. Known tuner startup diagnostics are suppressed. Repeated errors print at most once every five minutes; changed failures and recovery print immediately. Control characters are escaped and log lines are bounded.

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

Download a service account JSON from Firebase project settings, then store it outside Git with private file permissions. Its project must match `projectId`. Paths can be absolute or relative to `config.json`. Remove the former `database`, `api`, `convex`, `dedupeSeconds`, `pushMaxAgeSeconds` and `location` options. The receiver needs outbound internet access only, with no domain, tunnel or inbound port. Enable anonymous Firebase Auth and deploy the repository root Firestore security rules separately.

Each page is normalized and stored in a Firestore transaction. Matching repeats within 30 seconds of the original canonical message retain their content and reception fields with `duplicateOf` and `deleted: true`. The app removes these archive records through its deletion-marker sync. Repeats do not receive enrichment or create push or model jobs. Only canonical messages less than five minutes old queue notifications for approved members with a push token. Empty and tone pages skip location inference. Message writes commit independently of push and OpenAI calls, so model latency does not delay the live feed or notifications.

`pushJobs` and `locationJobs` are private Firestore collections. Each push job holds up to 100 recipients with independent tickets, receipt deadlines and retry state. One claim and one result commit process each batch; accepted recipients do not rejoin retries for failed recipients. The process listens for active jobs rather than repeatedly reading them on a timer. Persistent retry times and fenced leases allow unfinished jobs to resume after a restart. Successful push and location jobs are deleted after durable completion; failed jobs remain for diagnosis. Location results are saved before publication, then copied to the canonical message. Expo tokens that are no longer valid are cleared only if the device still has the same token and update time. Run one receiver/job processor for this project.

One shared `users` listener supplies the ingest and push workers. It reads the roster once at startup, then receives changes instead of rereading every device for each page. Push delivery checks the latest cached approval and token immediately before sending and pauses when the roster listener fails. A recently changed approval can briefly lag in the listener; notifications already submitted to Expo cannot be recalled.

Set `notifyDowntime: true` on an approved user's Firestore document to opt that device into reception outage alerts. The receiver checks audio every 30 seconds and queues one alert after two minutes without healthy audio. Quiet pager traffic does not trigger alerts. Private `receiverHealth/main` state prevents repeat alerts across process restarts. Recovery expires unsent alerts and enables an alert for the next outage. Push delivery rechecks the opt-in before sending. No app update or OpenAI call is needed. This runs on the receiver, so it cannot alert if the whole host is off or cannot reach Firebase; that requires an independent monitor.

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

The command replaces `ricUnits` with one document per RIC: `ricUnits/{RIC}` contains `{ ric, unitName }` with an unpadded document ID. Omitted mappings are deleted, and an empty array clears the collection. Phones listen directly to this collection and cache the names in SQLite. Each foreground connection reads all mappings; subsequent snapshots read changed documents. RICs must be unique integers from 0 to 2097151 and names must be nonempty. Renaming a unit updates existing local history without rewriting messages. The importer uses Firestore BulkWriter, so a large import is not atomic; rerunning a failed import finishes synchronization.

### SPIN incident reports

The background worker subscribes to SPIN's public ReCO Ljubljana location hub, group `10015`. Incident notices trigger public detail reads, with repeated notices grouped before matching. The regional [SPIN RSS feed](https://spin3.sos112.si/javno/ODApi/184) is still checked hourly for recovery. Startup and reconnect also refresh retained incidents. Set `SPIN_GROUP_ID=0` for polling only. If changing geography, configure both the public group ID and `SPIN_RSS_URL` to cover the required region; the national RSS URL is `https://spin3.sos112.si/javno/ODApi/true`. An empty `SPIN_RSS_URL` disables the worker. No SPIN account is used.

Only incidents linked to a pager are saved in `spinEvents/{SPIN_ID}`. `messages.spinMatchStatus` records whether the link is `confirmed` by a narrative or `provisional` from early evidence. The app shows municipality, map pin and date for an incident without a narrative; a narrative adds an expandable report. The report and `messages.spinEventId` links are published together in one transaction. Multiple canonical pager messages may link to one incident; archived repeats are excluded from enrichment. Original pager text and extracted locations remain unchanged. Approved phones read only linked reports, cache them in SQLite, and show municipality, event time, narrative and an approximate map action. Responders, actions and outcomes appear only where SPIN includes them in the narrative. SPIN does not provide a reliable resolved status or precise address.

Public candidates from the hub and RSS are kept only on the receiver in `spin-candidates.json` beside the outbox directory, with a three-day retention window. `rssRevision` and `nextDetailAt` belong to this local cache. The cache survives process restarts and records reports that leave RSS before matching. Failed live reads retain numeric incident IDs in `spin-candidates.json.pending`, retry after five minutes following two brief retries, and expire after three days. Successful reads without public details receive only two brief retries and preserve any previous public snapshot. Both files are written atomically and excluded from Git and deployments. Hub-only candidates use the public report creation time until RSS supplies the incident timestamp. Existing linked Firestore reports receive later public updates and match reviews; unmatched candidates never create Firestore incident documents.

Each canonical text pager gets a private `spinJobs/{messageId}` job containing only its retry, lease, expiry and matching state. The job ID identifies the pager; content, received time and extracted location are read from `messages` when claiming work. On startup, recent unmatched messages from the last three days are seeded once, allowing retained reports to augment recent history. The worker uses the same OpenAI Responses API and `gpt-6-luna` pattern as location extraction, with a strict candidate ID, verified address index and current-link review response. Early entries with municipality and approximate coordinates can match provisionally within 300 metres and 30 minutes of an independently verified house address. Exact address candidates come from the government Geohub locator. The model uses pager text, unit context and incident evidence to select the fitting town when an address exists in several towns. If more than one early report falls within those limits of the selected address, provisional matching waits for a narrative. This check uses coordinates and time rather than category wording. Full narratives can match without a geocoded address. All full reports in the recent three-day archive are candidates; code does not guess matches from words or impose an unvalidated narrow time cutoff. An unmatched job is checked again only when the report catalog changes, then expires after three days. Linked report changes queue revalidation. Provisional links retain their review job; a full narrative confirms them, or contradictory evidence removes the link and allows a supported replacement. Rejected incident IDs are saved on the pager so matching does not immediately reattach them. Publishing an extracted location wakes an earlier waiting match. Positive paid results include the selected report snapshot in the ready job, so publication can finish even after that candidate leaves the cache. Paid results are persisted before publishing links and retained in memory if Firestore temporarily rejects the write.

SPIN detail data adds municipality, category and approximate coordinates. Known sparse records are checked hourly for up to 48 hours; full reports are checked again at 24 and 48 hours. The RSS uses stable IDs and incident timestamps for updates, so every recovery poll compares all items. Candidates remain in the local cache after leaving the feed or moving to another region; confirmed reports stay in Firestore for history. SPIN does not document replay or a retention guarantee. An incident created and removed entirely while disconnected can still be missed; hourly recovery and the three-day matching horizon do not guarantee complete capture. Public detail unavailability does not establish deletion or cancellation. No ingestion or matching path sends push notifications.

Benchmark estimates at [Luna Standard prices](https://developers.openai.com/api/docs/models/gpt-6-luna) were $0.10 per 1,000 matching evaluations for the five-item feed and $0.337 for the 23-report historical catalog, without cache savings. At 10 new messages/day and five evaluations/message, this is about $0.15–$0.51/month. With all messages unmatched for three days and eight catalog changes/day, the 23-report case is about $2.42/month in steady state. If every hourly poll changes matching evidence, the same case is about $7.27/month. A larger retained catalog increases these costs. Runtime logs include SPIN request token usage to measure the actual workload. These estimates exclude existing location parsing, Firestore, hosting and taxes.

To correct a link manually, run `bun run spin:unlink MESSAGE_ID` from `server/` with its admin configuration. This removes the canonical pager's link, preserves reports still linked to other canonical pagers, and queues recent messages for rematching. Passing an archived repeat's ID corrects its original pager.

Deploy the root rules and indexes before enabling the worker on the receiver. `spinEvents` permits approved reads only; `spinJobs` remains private. No report ingestion or matching sends notifications. Existing `OPENAI_API_KEY` credentials are used at runtime; benchmark credentials are separate and never saved in the project.

### Activating the optimized protocol

These source changes do not update running processes, installed apps or Firestore rules. Deploy the repository root `firestore.rules` and `firestore.indexes.json` together, stop the old receiver after its active push jobs finish, then run the updated receiver and update the phones. Old per-device push jobs and new batched jobs have different schemas; do not run mixed worker versions. Publish the RIC JSON once with the updated `ric:sync` command. Existing phone caches perform one full bootstrap, then use deltas. No message backfill or history deletion is needed. Keep indexes enabled for `receivedAt`, `updatedAt`, `duplicateOf` and active-job queries; the checked-in exemptions remove unused catalog, recipient, text and location indexes.

### USB enumeration failures on the box

On 2026-10-10, the H616 box lost its Nooelec receiver after about 12 hours of service uptime. Kernel logs showed repeated USB descriptor/address failures (`-71`, later `-110`) and fallback from EHCI high speed to OHCI at 12 Mbps. User-space `-4` means device unavailable; `-7` means timeout. The receiver was authorised, accessible to the `plugdev` user, active with power management set to `on`, and owned by only one `rtl_fm` process. These failures occurred before pager decoding.

A standalone low-rate `rtl_test` failed too and blocked inside a kernel USB reset until descriptor timeouts completed. A command timeout cannot interrupt that kernel wait immediately. Always stop the receiver before a standalone hardware probe and restore it afterwards. The normal `rtl_fm -s 22050` internally captures about 1.014 million complex samples/second, more than a 12 Mbps USB connection can carry; device detection at that fallback speed does not establish working reception.

Restarting the process, resetting the affected EHCI/OHCI pair, holding its GPIO-backed `usb1-vbus` regulator logically disabled for 10 seconds, and resetting the shared USB PHY/controllers did not recover this failure. No permanent driver, kernel, boot or recovery configuration was changed. The service was restored after each test. A logical regulator state is not a voltage measurement. Do not install an automatic controller-reset loop on the basis of these unsuccessful tests.

The same receiver then failed on two Mac USB ports, with accessory access already allowed. macOS initially detected 480 Mbps but repeatedly logged hardware connection loss and configuration-descriptor transaction errors. A finite `rtl_sdr` capture configured the tuner but timed out after 15 seconds without samples. The receiver later fell back to 12 Mbps on the Mac too. Disconnecting the antenna and leaving the dongle unpowered for five minutes did not recover it. These observations point to an unstable receiver or physical connection; they do not identify the exact hardware defect.

Recovery succeeded on the box by temporarily unbinding only the affected EHCI controller, `5200000.usb`, while retaining its OHCI companion, `5200400.usb`. A standalone Bun FFI probe initialized librtlsdr at 250,000 samples/second, then used a second unclaimed libusb handle to set the volatile EPA maximum packet size to 64 bytes. The vendor transfer wrote `[0x40, 0x00]` to address `0x2158`, index `0x0110`, and verified the bytes with read index `0x0100`. Ten synchronous reads transferred 163,840 I/Q bytes successfully at 12 Mbps. Rebinding EHCI and restoring the service then recovered normal 480 Mbps operation; the original `rtl_fm` logged `Receiver PCM resumed` at 19:13:38 UTC. No custom receiver binary or permanent controller setting was installed. Temporary build dependencies were removed.

This was one successful recovery, not proof of a permanent hardware repair. Stop the service before any probe, bound blocking native reads with an external forced-kill timeout, and restore the controller and service with an exit trap. A process timeout may still wait for a kernel USB reset to finish. Do not substitute the standard 1.014 million-sample capture at 12 Mbps: this diagnostic explicitly reduced both the sample rate and the USB packet size. The initialization warning about an unlocked tuner PLL occurred while sample-rate setup retuned the initial zero frequency, before the explicit pager-frequency tune; it does not establish a failure at 173.250 MHz.

The tested probe and restoration scripts are archived on the Mac in `~/Downloads/subpager-radio-usb-recovery-scripts-2026-10-10/`. The shell script targets the controller used in this incident; verify the receiver's physical controller before reusing it. Normal capture continued for more than five minutes and resumed again after the backend logging deployment. Firestore job listeners now log successful connections and include the SDK error message on disconnect, so an index build failure can be distinguished from a current radio failure.

## Verified reception

On 2026-10-07 this Mac captured three live calls, IDs 1–3, with RICs `0790241`, `0705002` and `0790521`. Each SQLite recording reproduced its exact RIC, function, type and text through native replay. This establishes reception, not coverage or missed-call rate. Reference traffic and live Slovenian diacritics remain unverified. Hardware uses automatic gain, 0 PPM, librtlsdr 2.0.3 and multimon-ng 1.6.1.

A macOS 524288-byte stdout buffer previously delayed PCM by about 12 seconds. The receiver's macOS-only unbuffered environment removed that measured delay. A separate USB transfer error recovered automatically after about 33 seconds; its physical cause is unresolved. The old debug captures were removed; these findings remain here.

## Message fields

The receiver preserves decoded `content`, including rendered markers and raw line breaks. The receiver removes trailing `<EOT>`/`<NUL>` padding and replaces rendered or raw LF/CR line breaks with spaces once, preserving Slovenian characters and other content. Each decoded recording's JSON metadata contains the raw calls; its WAV contains the exact PCM audio supplied to the decoder for replay. New messages and push jobs use Firestore automatic document IDs. Each message ID is generated once before saving the reception to the outbox; retries reuse that ID and read its document directly. The message and its jobs commit in one transaction, with location jobs reusing the message ID. No counters are needed. Existing history retains its original IDs `1–22`. Firebase user UIDs and numeric RIC values retain their original format.

Incoming 22050-Hz PCM passes through a causal fourth-order Butterworth low-pass at 1200 Hz before both recording and decoding. The filter retains its state across native chunks and resets when the receiver relaunches. Node streams preserve backpressure, and byte framing handles split samples. WAV sidecars identify the filter; replay does not filter saved audio again. Receiver gain, frequency and native decoder error correction are unchanged.

On 2026-10-12, offline tests recovered all 26 expected calls from 20 saved valid clips, including cancellations. The three noise-only `SF`, ` #` and address-only events were reproduced exactly from their original captured PCM by prepending noise to establish the decoder's clock phase. Prefix-only controls emitted nothing; output occurred around 7.9 seconds into the original clips, matching their original receipt position. The installed server decoder reproduced all three without the app, Firestore or SPIN. Its synchronization search can mistake noise for valid error-corrected codewords. The filter suppressed these three reproductions and reduced 81 false calls to zero in one constructed 2.99-hour noise stream. In added-noise tests with three seeds per valid clip, the filter recovered 78 of 78 expected calls versus zero of 78 without it at added RMS 2500. These are bounded offline results, not a real-world false-positive rate or a guarantee against missed or false calls. Filtering cannot repair USB disconnects or recover information absent from the RF signal.

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
