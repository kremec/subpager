# subpager app

Private pager history and Expo push notifications with Firebase anonymous Auth and Firestore. Firestore is the only backend database. The receiver uploads decoded calls from a small filesystem outbox and handles durable push and location jobs independently. The app keeps a SQLite cache for offline reading.

## Install and check

```sh
bun install # from the repository root
bun run check
bun run lint
bun run format:check
bun run test
```

Use Bun. Do not start another Metro server if one is running. Native dependency and permission changes require a new native build. Subpager blocks external storage read/write permissions. Firebase Auth persists the anonymous account in AsyncStorage.

Bun applies the checked-in MaskedView manifest patch during installation. EAS uses the uploaded `google-services.json` when present so local and cloud builds use the same Firebase client file for fingerprinting.

Bun also patches LegendList 3.6.0 to update Fabric content dimensions through React alongside row positions and the scroll anchor. Separate animated dimension updates caused a brief Android feed jump when filters changed. Keep this patch until an upstream release fixes that transition; check scrolled filter toggles frame by frame before removing it.

## Firebase setup

The project is `subpager-subbyte`, with the default Firestore database in `europe-west3`. Enable anonymous Firebase Auth. The public client options come from the matching Android package in `google-services.json`, provided locally or through the EAS `GOOGLE_SERVICES_JSON` file variable. Keep service account credentials outside source control and mobile builds.

Deploy rules and indexes from the repository root after signing into the Firebase CLI:

```sh
bunx firebase-tools deploy --only firestore --project subpager-subbyte
```

`firestore.rules` permits a device to read its own approval. Only approved devices can read messages and RIC mappings or register their own Expo token. Clients can update their own push token and the boolean `showTestMessages` and `showVajaMessages` preferences; they cannot change approval or labels, write messages or access private jobs. Both preferences default to enabled. Disabling one hides events whose message content contains `test` or `vaja`, respectively, without regard to case, and excludes the device from matching push notifications, including queued sends. Confirmed preferences are cached for offline history. The receiver uses the official Firebase Admin SDK with a private service account. See the receiver README for configuration.

The app creates an anonymous account and displays its ID in onboarding and settings. Run these commands from `../server/`:

```sh
bun run member:approve FIREBASE_DEVICE_ID
bun run member:list
bun run member:revoke FIREBASE_DEVICE_ID
```

User approval, labels and push tokens share `users/{uid}` as `approved`, `label` and `expoPushToken`. Existing Firebase identities retain their ID. Convex identities do not grant Firebase access. Reinstalling or clearing app data can require a new approval.

Online, the app waits for server-confirmed approval before syncing history. Offline, it permits saved history only for the same previously approved Firebase UID. A server-confirmed revocation clears saved history and dismisses notifications. An offline phone retains its cache until it reconnects and observes revocation.

## History and locations

The app saves complete history in separate SQLite `messages` and `ric_units` tables with columns for each field and a JSON `receptions` array; `approval` identifies the cache owner. Existing caches migrate automatically, retaining each original known RIC/time pair and SPIN links offline. The first launch of the reception-history schema reloads complete event history once. The first connection loads full message history, including legacy documents. Later connections query `updatedAt` at or after the saved Firestore timestamp, then save changed rows and the cursor in one transaction. Later location updates use the same server timestamp field, so they reach cached older messages. History stays unlimited without a full archive download at every open. Listeners pause in the background and resume from the saved cursor. New messages and location updates require internet and arrive automatically without manual refresh. Search matches text, RIC and unit names without case or accent differences. The receiver stores one event for matching content, including minor decoding differences, with a `receptions` array of `{ric, time}` entries. Matching content groups within one Europe/Ljubljana calendar day. Same-RIC repeats within 30 seconds of a retained paging are ignored as echoes; later repeats keep their separate times. Monthly tests appear as daily events and follow the existing test-message preferences. Tone-only calls are discarded by the receiver. The app renders each reception oldest to newest above one message body, with its RIC/unit label on the left and date/time on the right. Events are ordered newest first by their latest reception. Search includes every reception RIC and mapped unit. Legacy Firestore documents remain readable through their original RIC/time pair during rollout. New messages use Firestore automatic document IDs; historical groups retain one original ID. Firebase identities keep their UIDs. Manual deletions use the receiver's `message:delete` command, which publishes a permanent deletion marker with a fresh `updatedAt`. The app saves cached row removals and their cursor atomically, so offline phones catch up on their next connection. The first launch supporting deletion markers reloads history once to remove any markers saved by an older bundle. Hard-deleting documents directly bypasses this protocol. Later receptions update the stored event directly.

RIC names come directly from `ricUnits/{RIC}` documents containing `ric` and `unitName`. The app queries mappings with `ric >= 0`. It watches the collection while foregrounded and replaces its SQLite mappings from each server snapshot, including empty snapshots. Initial attachment downloads every mapping; later changes update the listener automatically. Publish a complete JSON array through the receiver's `bun run ric:sync FILE`.

The receiver transaction saves each message and queues private `pushJobs` and `locationJobs`. Push jobs contain up to 100 recipients with separate ticket and retry state. A shared users listener avoids rereading the device roster per message. Separate listeners process jobs without repeated polling reads. The receiver must be running to finish background work. Durable retry times and leases allow recovery after restart. The receiver has no SQLite database, HTTP API, domain or tunnel.

Activate the protocol together with the updated server: deploy the checked-in rules and index exemptions, finish the old server's active push jobs, restart with the new server and update phones, then publish the RIC catalog once. A phone performs one full bootstrap before using deltas. Run the receiver reception-history migration when activating the new schema. These source edits do not deploy rules, restart the receiver or update installed apps. Unchanged push tokens are compared with the server-confirmed user record and do not need a write at each cold start.

Location extraction uses OpenAI Responses with `gpt-6-luna`, no reasoning and structured output containing an exact message substring or null. Set `OPENAI_API_KEY` in the receiver ignored `.env`. API billing is separate from ChatGPT subscriptions. Extraction does not delay the initial feed or push. Completed results update canonical messages without sending another alert.

Underlined location text opens Google Maps with Slovenia as context. Extraction does not verify coordinates or guarantee a correct Maps result. Message rows do not open a detail screen. Times use the phone timezone, day/month/year and a 24-hour clock. Connection errors appear as toasts.

## Push delivery

The receiver sends through Expo, stores tickets, checks delayed receipts and conditionally clears invalid tokens. It retries transient errors and expires stale sends. Importing history creates no push or model jobs. A process crash between provider acceptance and the first database acknowledgement can repeat a request. Provider receipts do not prove that a phone displayed or sounded an alert.

Firebase Cloud Messaging remains the Android push transport. Keep `google-services.json` and the EAS FCM v1 credential. Android packages remain `com.subbyte.subpager` and `com.subbyte.subpager.dev`. iOS needs Apple signing and APNs credentials. Notification taps open the feed.

## Migration and rollback

The original Firebase checkpoints are app `1cac205` and receiver `39829c3`. The final Convex checkpoints are app `def4ee6` and receiver `6462a62`, also tagged `firebase-return-checkpoint-*`. The temporary migration archives were removed after verifying Firestore.

On 2026-10-09, all 22 messages, 14 completed locations, original Firebase approvals and device tokens were imported into Firestore and checked against the migration archive. No notification or model jobs were created. Server SQLite remains removed. The receiver outbox holds only unacknowledged receptions and removes them after Firestore confirms ingestion.

A subsequent atomic migration restored the original message IDs `1–22` and remapped duplicate references while preserving all message fields and locations. New messages and push jobs now use Firestore automatic document IDs without counters; location jobs reuse message IDs. The Convex project and temporary migration archives have been deleted. The two original device labels were recovered from thread history and restored. Approval and token records were then merged into `users/{uid}`, and the deployed rules now use that collection. Older app bundles that read `members` and `devices` require an update.

## Google Play internal releases

The release flow is `main` push with app or root build-configuration changes → production Android AAB build → submission to Google Play's `internal` track. Server-only and documentation-only changes do not trigger releases. The build profile's name and EAS Update channel are `production`; the Play destination is still internal testing. The `preview` profile creates an APK for direct installation and must not be used for Play submission. Remote versioning and `autoIncrement` give each production build a new Android version code. [Expo Android submission](https://docs.expo.dev/submit/android/).

Configured and checked on 2026-10-08:

- EAS has the default `Subpager Android` upload keystore for `com.subbyte.subpager`.
- The Google Play Android Developer API is enabled in GCP project `subpager`.
- `play-console-service-account@subpager.iam.gserviceaccount.com` is active in Play Console with access to Subpager and the submission permissions. Its key is assigned to EAS's Play Store Submissions slot. The local file is `./subpager-873873498300.json`, excluded by both `.gitignore` and `.easignore`. It is separate from the Firebase client config and FCM key. [Expo's service-account guide](https://github.com/expo/fyi/blob/main/creating-google-service-account.md).
- [Subpager's EAS GitHub settings](https://expo.dev/accounts/subbyte/projects/subpager/github) uses `kremec/subpager`, with `app` as its base directory. The Expo GitHub App installation must also include this repository so push events reach EAS. The release workflow passes EAS validation.

Before the first release:

1. Commit changes on `develop`, then merge the reviewed release to `main` and push. This runs the release workflow. [GitHub workflow setup](https://docs.expo.dev/eas/workflows/get-started/).
2. If version codes already exist in Play, initialize the remote version with `eas build:version:set --platform android --profile production` before building. If Play already has an uploaded binary, confirm that its upload certificate matches the EAS keystore.
3. In Play Console → Testing → Internal testing, add your testers and share the opt-in link. Complete any Play setup tasks required for the release. EAS submits the bundle; check the Play release status and installation separately. Current Expo documentation supports the first internal submission through EAS; a manual first upload is optional.

To build and submit manually from this checkout after credentials are ready:

```sh
bun run eas:deploy
```

To build first and inspect the result before submitting:

```sh
bun run eas:build
bun run eas:submit
```

The submit command lets you select the intended build. For the exact GitHub build, the workflow passes its `build_id` to the submit job. No extra GitHub Actions workflow or `EXPO_TOKEN` is required for EAS's own GitHub integration.

The existing Android signing, Play submission, FCM credentials and Firebase client file variable remain attached to the same EAS project. The sync optimizations were published as Android version code 5 to Play internal testing before the monorepo migration. Repository checks are separate from phone acceptance checks.

## End-to-end acceptance checks

These require an explicitly approved cloud setup and an installed phone build. They have not been performed by the code checks. Use neutral test content for transport checks; do not insert test messages into live pager history.

- Open an unapproved installation. Confirm its UID is stable after restarting and history stays blocked. Approve the UID and confirm history and notification registration become available without signing in.
- Receive a real call while the app is open, locked and closed. Compare message content, time and RIC with the receiver. Tap an alert and confirm the feed loads.
- Confirm alerts arrive for all RICs and that their title is the seven-digit RIC and reception time, with received content in the body.
- Disable notification permission and resume. Confirm the device token becomes null while history keeps syncing. Enable permission, resume and confirm new alerts resume without replaying old ones.
- Open a previously approved app without internet. Confirm its last synced feed remains readable. Restore internet and confirm the feed updates.
- Disconnect the receiver from the internet. Confirm receptions remain in its disk outbox, then upload after reconnecting without a burst of delayed notifications.
- Revoke the UID. Confirm cloud reads and new sends stop, and the app removes displayed history and notifications.
- Clear app data or install on another phone. Confirm the new UID has no access before manual approval.

Type, lint and dependency checks do not prove deployed rules, cloud permissions, signing, store submission, physical-device behavior or push delivery.

## SPIN report preview

The history feed shows a collapsible SPIN report when a message has a `spinEventId` link to `spinEvents/{ID}` in Firestore. Reports show the source narrative, municipality and incident time. The header toggles the report. Expanded reports have a footer with a SPIN link on the left to the official incident map and a map pin on the right to the approximate map position. Reports are stored separately in SQLite and shared by messages that reference the same incident. Foreground listeners fetch only linked documents; saved reports remain readable offline. Search includes report prose and metadata.

Early SPIN links have `spinMatchStatus: "provisional"` on the pager message. Match status is cached with the pager message and updates when the server confirms or unlinks it. Reports without a narrative show a static municipality and incident time header with the same link footer below. Once a narrative arrives, the header becomes collapsible and the footer appears when expanded.

For a local preview without writing incident data to Firestore, run `bun run start:staging -- --dev-client --localhost` from `app/`. Open the normal feed at `/?spinPreview=1`, or use `subpager-dev:///?spinPreview=1` in the connected development client. The preview adds six confirmed incident reports to seven real message rows only when their IDs, received times and original content match the benchmark fixtures. Search keeps the preview enabled and includes the report text. This display overlay does not change saved messages or write reports to SQLite or Firestore, and it is disabled in release builds.

The separate `/spin-preview` route displays the same fixtures without requiring those messages in the feed. With Android USB forwarding (`adb reverse tcp:8081 tcp:8081`), its development URL is `subpager-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2Fspin-preview`.
