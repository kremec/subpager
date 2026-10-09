# subpager app

Private pager history and Expo push notifications with Firebase anonymous Auth and Firestore. Firestore is the only backend database. The receiver uploads decoded calls from a small filesystem outbox and handles durable push and location jobs independently. The app keeps one SQLite row for offline reading.

## Install and check

```sh
bun install
bun run check
bun run lint
bun run format:check
bun run test
```

Use Bun. Do not start another Metro server if one is running. Native dependency and permission changes require a new native build. Subpager blocks external storage read/write permissions. Firebase Auth persists the anonymous account in AsyncStorage.

## Firebase setup

The project is `subpager-subbyte`, with the default Firestore database in `europe-west3`. Enable anonymous Firebase Auth. The public client options come from the matching Android package in `google-services.json`, provided locally or through the EAS `GOOGLE_SERVICES_JSON` file variable. Keep service account credentials outside source control and mobile builds.

Deploy the rules after signing into the Firebase CLI:

```sh
bunx firebase-tools deploy --only firestore:rules --project subpager-subbyte
```

`firestore.rules` permits a device to read its own approval. Only approved devices can read messages and RIC mappings or register their own Expo token. Clients can update only their own push token; they cannot change approval or labels, write messages or access private jobs. The receiver uses the official Firebase Admin SDK with a private service account. See the receiver README for configuration.

The app creates an anonymous account and displays its ID in onboarding and settings. In the receiver repository:

```sh
bun run member:approve FIREBASE_DEVICE_ID
bun run member:list
bun run member:revoke FIREBASE_DEVICE_ID
```

User approval, labels and push tokens share `users/{uid}` as `approved`, `label` and `expoPushToken`. Existing Firebase identities retain their ID. Convex identities do not grant Firebase access. Reinstalling or clearing app data can require a new approval.

Online, the app waits for server-confirmed approval before syncing history. Offline, it permits saved history only for the same previously approved Firebase UID. A server-confirmed revocation clears saved history and dismisses notifications. An offline phone retains its cache until it reconnects and observes revocation.

## History and locations

Firestore listeners replace the full message and RIC mapping snapshots, including changes and removals. The app saves the latest snapshots in one SQLite row. New messages and location updates require internet and arrive automatically without manual refresh. Search matches text, RIC and unit names without case or accent differences. Messages use sequential Firestore document IDs such as `1`, `2` and `3`. Firebase identities keep their UIDs. RIC mappings use `ricUnits/{ric}` with `ric` and `unitName` fields; none were configured before migration.

The receiver transaction saves each message and queues private `pushJobs` and `locationJobs`. Separate listeners process those jobs without repeated polling reads. The receiver must be running to finish background work. Durable retry times and leases allow recovery after restart. The receiver has no SQLite database, HTTP API, domain or tunnel.

Location extraction uses OpenAI Responses with `gpt-6-luna`, no reasoning and structured output containing an exact message substring or null. Set `OPENAI_API_KEY` in the receiver ignored `.env`. API billing is separate from ChatGPT subscriptions. Extraction does not delay the initial feed or push. Completed results update canonical messages and repeats without sending another alert.

Underlined location text opens Google Maps with Slovenia as context. Extraction does not verify coordinates or guarantee a correct Maps result. Message rows do not open a detail screen. Times use the phone timezone, day/month/year and a 24-hour clock. Connection errors appear as toasts.

## Push delivery

The receiver sends through Expo, stores tickets, checks delayed receipts and conditionally clears invalid tokens. It retries transient errors and expires stale sends. Importing history creates no push or model jobs. A process crash between provider acceptance and the first database acknowledgement can repeat a request. Provider receipts do not prove that a phone displayed or sounded an alert.

Firebase Cloud Messaging remains the Android push transport. Keep `google-services.json` and the EAS FCM v1 credential. Android packages remain `com.subbyte.subpager` and `com.subbyte.subpager.dev`. iOS needs Apple signing and APNs credentials. Notification taps open the feed.

## Migration and rollback

The original Firebase checkpoints are app `1cac205` and receiver `39829c3`. The final Convex checkpoints are app `def4ee6` and receiver `6462a62`, also tagged `firebase-return-checkpoint-*`. The temporary migration archives were removed after verifying Firestore.

On 2026-10-09, all 22 messages, 14 completed locations, original Firebase approvals and device tokens were imported into Firestore and checked against the migration archive. No notification or model jobs were created. Server SQLite remains removed. The receiver outbox holds only unacknowledged receptions and removes them after Firestore confirms ingestion.

A subsequent atomic migration restored the original message IDs `1–22` and remapped duplicate references while preserving all message fields and locations. The next message ID is `23`; push jobs have their own sequence, and location jobs reuse message IDs. The Convex project and temporary migration archives have been deleted. The two original device labels were recovered from thread history and restored. Approval and token records were then merged into `users/{uid}`, and the deployed rules now use that collection. Older app bundles that read `members` and `devices` require an update.

## Google Play internal releases

The release flow matches subsocial: `main` push → production Android AAB build → submission to Google Play's `internal` track. The build profile's name and EAS Update channel are `production`; the Play destination is still internal testing. The `preview` profile creates an APK for direct installation and must not be used for Play submission. Remote versioning and `autoIncrement` give each production build a new Android version code. [Expo Android submission](https://docs.expo.dev/submit/android/).

Configured and checked on 2026-10-08:

- EAS has the default `Subpager Android` upload keystore for `com.subbyte.subpager`.
- The Google Play Android Developer API is enabled in GCP project `subpager`.
- `play-console-service-account@subpager.iam.gserviceaccount.com` is active in Play Console with access to Subpager and the submission permissions. Its key is assigned to EAS's Play Store Submissions slot. The local file is `./subpager-873873498300.json`, excluded by both `.gitignore` and `.easignore`. It is separate from the Firebase client config and FCM key. [Expo's service-account guide](https://github.com/expo/fyi/blob/main/creating-google-service-account.md).
- [Subpager's EAS GitHub settings](https://expo.dev/accounts/subbyte/projects/subpager/github) confirms `kremec/subpager-app` is connected. The release workflow passes EAS validation.

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

This setup linked GitHub, configured Android signing, assigned the Play and FCM service-account keys, enabled the Play API and uploaded the Firebase client configuration as an EAS file variable. No builds, store submissions, OTA updates, notifications or phone acceptance checks were performed.

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
