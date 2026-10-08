# subpager app

Private pager history and Expo push notifications, using Convex for the database and anonymous authentication. The receiver saves radio messages to local SQLite, then uploads them through an authenticated Convex HTTP endpoint. Convex publishes history and queues push independently of location extraction.

## Install and check

```sh
bun install
bun run check
bun run lint
bun run format:check
bun run test
```

Use Bun. Do not start another Metro server if one is already running. Native dependencies and Android permission changes require a new native build. Subpager blocks external storage read/write permissions; identity and history use private app storage.

## Convex setup

The backend source lives in `convex/` in this repository. The receiver uses its HTTP endpoints and needs no Convex runtime dependency. Generated API types are checked into source control.

The single production deployment is `https://clever-dinosaur-653.eu-west-1.convex.cloud`.

Local Expo reads `EXPO_PUBLIC_CONVEX_URL` from `.env.local`. All EAS profiles use production. Build profiles retain their existing distribution and update channels. The separate Convex development deployment was backed up and deleted.

```sh
bun run convex:deploy
```

This deploys the backend to production. It does not build or publish the mobile app. For database inspection and function calls, use `bunx convex data --prod` and `bunx convex run --prod`. Do not run `convex dev`, which would create another development deployment.

Configure `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` and `RECEIVER_SECRET` in Convex production. Auth uses the built-in deployment `CONVEX_SITE_URL`. The receiver secret stays in a private file on the receiver. Optional `EXPO_ACCESS_TOKEN` belongs in Convex when Expo enhanced push security is enabled. `PUSH_MAX_AGE_SECONDS` defaults to 300.

The app creates an anonymous account and persists its tokens with SecureStore. Copy the device ID from onboarding or the settings sheet. In the receiver repository:

```sh
bun run member:approve CONVEX_DEVICE_ID
bun run member:list
bun run member:revoke CONVEX_DEVICE_ID
```

Only administrators can approve devices or write messages. Approval permits history and notifications. Revocation stops cloud reads and future sends; the online app clears cached history and dismisses displayed notifications when it observes the change. An offline phone retains its last known approval until reconnection. Clearing app data or reinstalling can require a new approval.

Firebase anonymous IDs cannot prove ownership of Convex accounts. Existing installations receive new IDs and require approval again. Old Firebase approval is never reused to grant new cloud access.

## History and locations

Convex live queries sync full history and RIC unit mappings into SQLite for offline viewing and search. Existing messages are upserted, so later location updates appear in the feed. Messages use native Convex document IDs; receiver numeric IDs stay in a separate ingestion mapping. Search matches message text, RICs and unit names, ignoring case and accents. Unit names are maintained in the receiver SQLite `ric_units` table and published with `bun run ric:sync`.

The receiver runs location extraction independently of message upload. It uses OpenAI Responses with `gpt-6-luna`, no reasoning, and structured output containing an exact message substring or null. The worker persists retries and completed extraction results. A later Convex location patch does not send another notification. An unavailable model leaves the original message readable and does not delay push.

Extracted location text is underlined and opens a Google Maps search with Slovenia as context. Extraction identifies text; it does not verify coordinates or guarantee a correct Maps result. The app preserves the received text. Decoder markers such as `<LF>` display as spaces. Times use the phone timezone, day/month/year and a 24-hour clock. Connection errors are shown as toasts.

API billing is separate from ChatGPT subscriptions. Set `OPENAI_API_KEY` in the receiver's ignored `.env` file, never in Convex, the app, source control or logs. Bun loads this file automatically. Restart the receiver after changing the key. ChatGPT Go's allowance for the benchmark subscription route is unverified; API mode avoids that dependency.

## Expo push and Firebase

Firebase remains only for Android FCM delivery. Keep `google-services.json` configured through `GOOGLE_SERVICES_JSON` and keep the EAS FCM v1 credential. Firebase JS, Firestore and Firebase Authentication are no longer used by this app or receiver.

Convex sends through Expo, retains tickets, checks delayed receipts and clears invalid tokens only when the device still has that token version. It retries transient errors and expires stale sends. Notification taps open the feed. Message rows do not open a detail screen; only underlined locations open Maps. Importing old history never creates notification jobs. A provider receipt does not prove the phone displayed or sounded an alert.

The Android packages remain `com.subbyte.subpager` and `com.subbyte.subpager.dev`. iOS still needs Apple signing and APNs credentials. No phone connects directly to the receiver, and no public receiver domain or tunnel is needed.

## Migration and rollback

The pre-migration checkpoints are app `1cac205` and receiver `39829c3`. A consistent local SQLite backup and private configuration backup were saved outside both repositories before migration. Keep that backup and the old Firebase project until device acceptance checks pass.

Use `bun run history:import` from the receiver repository with the intended Convex configuration to import local history without notifications. Ingest is idempotent and rejects an existing receiver ID with different message content. Never reset the receiver database against existing cloud history. Location backfill is explicit through `bun run location:backfill`.

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
- Keep the phone offline for more than 50 new messages. Restore internet and confirm every gap is filled and the full history remains available.
- Disconnect the Mac from the internet. Confirm local receptions remain saved, then upload after reconnecting without a burst of delayed notifications.
- Revoke the UID. Confirm cloud reads and new sends stop, and the online app clears cached history. Confirm that offline retained content cannot be remotely erased.
- Clear app data or install on another phone. Confirm the new UID has no access before manual approval.

Type, lint and dependency checks do not prove deployed rules, cloud permissions, signing, store submission, physical-device behavior or push delivery.
