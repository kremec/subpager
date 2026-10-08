# subpager app

Whitelist-only pager history and push notifications for `subpager-server`, using Firebase Anonymous Authentication and Firestore. Expo SDK 57, React Native 0.86, TypeScript and Bun. The structure follows subcycle/subsocial: thin `src/app` routes, `src/screens`, feature modules, theme tokens and inline component styles, `@/` imports, oxlint/oxfmt and Git quality hooks. Firebase and Expo SDKs handle authentication, token refresh and push transport. There is no app sign-in screen and no connection to the receiver's HTTP API.

## Branches

Use `develop` for active changes and `main` for reviewed releases and deployments. The first source commit is `feat: v0.0.1`. The remote is `git@github.com:kremec/subpager-app.git`; its default branch is `develop`. Expo is connected to this repository. `.eas/workflows/release.yml` matches subsocial: a push to `main` builds production Android and submits it to Google Play's internal track.

## Install and check

```sh
bun install
bun run check
bun run lint
bun run format:check
bun run test
bunx expo install --check
bunx expo-doctor@latest
```

The development build was verified on the Android emulator: onboarding, approved history, local timestamps, the settings bottom sheet and device-ID copying. Its new account is approved and has a registered Expo push token. This does not verify physical-phone behavior or notification delivery to the new development installation.

The feed uses LegendList, and its three-dot settings menu uses the same Expo UI bottom sheet and Tabler icon style as Subsocial. Install a new native build for the native dependencies and Android permission changes. An OTA update alone cannot apply them. Subpager blocks the external storage read/write permissions inherited from Expo FileSystem; history and identity use private app storage.

## Firebase access and history

Cloud setup completed on 2026-10-08 in `subpager-subbyte`: Anonymous Authentication enabled with cleanup off, default Standard Firestore in Frankfurt (`europe-west3`), and whitelist rules deployed. The project remains on Spark. All 80 Rules API tests and 18 live client-access checks passed; temporary test data and identity were removed. The receiver has a separate private Firestore key, and its existing eight messages were backfilled without sending alerts. No real device UID has been approved yet. Install a new native build, then approve the UID it shows. Phone behavior and push display remain unverified.

The Play tester list controls distribution. Firestore controls data access. Both are manual gates: add a friend's Google email to the Play internal tester group, then approve the UID shown by their installed app. A copied APK never grants access to messages.

1. In the existing Firebase project `subpager-subbyte`, enable Authentication > Sign-in method > Anonymous. Keep automatic cleanup of anonymous accounts disabled, because these identities are permanent device approvals.
2. Create the default Cloud Firestore database in production mode. Apply `../subpager-server/firestore.rules` before enabling the receiver's cloud integration. Do not use test-mode rules.
3. Configure the receiver as described in `../subpager-server/README.md`. It uploads history and checks approval before sending each notification. Its service-account key stays on the receiver and is never bundled into this app.
4. The app derives public Firebase client identifiers from the matching Android client in `google-services.json`, read through `GOOGLE_SERVICES_JSON` in EAS. This file contains client configuration, not privileged credentials. A build without a matching client displays a configuration error.
5. Install the app. It silently creates an anonymous Firebase account and preserves it with AsyncStorage. Use **Copy device ID** on the setup screen to share its UID with the administrator. After setup, the same control is in the three-dot settings menu.
6. From the receiver repository, run `bun run member:approve FIREBASE_UID "Friend's name"`, or create `members/{uid}` with `approved: true` and a `label` in Firebase Console. Use `bun run member:list` to inspect approvals and `bun run member:revoke FIREBASE_UID` to revoke one. Only the administrator can change membership. One approval grants both history and notifications. A missing document or `approved: false` denies both.
7. The app sees approval, opens history automatically and asks for OS notification permission. Onboarding and settings use the same device-ID row; tap it to copy the full ID. The app registers for all RICs, including when an older installation had saved an alert filter.

The search icon beside settings opens a modal like Subsocial. Search filters saved message text and RIC codes as you type, ignoring case and accents. Every entered word must match. It searches the full synced history.

An approved app writes only its own `devices/{uid}` document, containing `expoPushToken` and `rics`. Within an approved session, unchanged tokens do not rewrite the document. Native token-change events pass their token directly to Expo, avoiding another native token fetch that would trigger the listener again. It cannot modify messages or approvals, or list other members/devices. Notification permission disabled on the phone stores a null token when the app next resumes. History continues to work. Re-enabling permission registers the current token and receives future alerts; loading old history does not send old alerts.

New phones, clearing app data or reinstalling can create a new UID and require another approval. Never use the UID as a password: Firebase also requires proof that this app instance owns that identity. Revoking membership stops future server sends and cloud reads. The app erases SQLite history and dismisses displayed alerts when it observes revocation. Previously copied content and alerts already handed to the push provider cannot be recalled. An offline phone may retain its last known approval and cached messages until it reconnects.

After approval, Firestore listeners sync all history and RIC unit mappings into separate SQLite tables. Messages are immutable: the first confirmed server snapshot fills history, then the listener caches only new messages. Existing cached messages are never rewritten. Unit mappings still reflect renames and removals. Each new listener attachment can read the full collections again. SQLite keeps history without a message-count limit for offline viewing and search. Empty SDK memory-cache snapshots never replace saved history. Revocation clears both local tables. Pull-to-refresh reattaches the listeners.

History listeners wait for connection initialization and reattach after a connection retry. Returning to the foreground retries only listeners that ended with an error; healthy listeners stay attached. Local lifecycle tests run in isolated Bun test environments so their native-module mocks cannot affect other test files.

The receiver's SQLite database is authoritative. Edit its `ric_units (ric, unit_name)` table, then run `bun run ric:sync` from `../subpager-server` to publish definitions to `ricUnits` in Firestore. Message content is uploaded once and does not support later corrections. Approved reads of the mapping collection require the server `firestore.rules`.

Feed and detail headings show the current unit name with the seven-digit RIC, or just the RIC if no mapping exists. Search matches unit names as well as RIC and message text. Content uses normal text weight; decoder markers such as `<LF>` display as spaces. Timestamps use the phone's timezone, day/month/year dates and a 24-hour clock. Notification taps open the shared live history, so an open detail view also receives unit-name changes.

Neither phones nor Firebase connect to your Mac. The receiver needs only outbound access to Firebase and Expo. The app uses Firebase's internet-accessible endpoints with enforced authentication and whitelist rules. Receiver downtime delays cloud history; phone notification settings do not control history uploads.

## Set up Expo push

The app uses the server's `content` field for history, details and cached messages. Notifications use the seven-digit RIC and reception timestamp as their title, for example `0123456 · 08/10/2026, 12:07`, and the received content verbatim as their body. Notification timestamps use Ljubljana local time, including daylight saving changes. Android Firebase credentials are configured in EAS for `com.subbyte.subpager`. Push delivery still needs testing on an installed app. Apple signing and APNs credentials have not been configured.

For a first Android installation, use the existing `preview` build profile. It produces a standalone, internally distributed APK using `com.subbyte.subpager`. It does not need Metro or Google Play publication. Expo Go is not the target for remote push testing. [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/), [internal distribution](https://docs.expo.dev/build/internal-distribution/).

### Expo project

`app.config.ts` links Subpager to EAS project `0f53fe8f-bb64-4106-bb76-86ac5139e53e`. The project ID is checked in, as in subsocial. Confirm the linked project from this directory:

```sh
eas project:info
```

The build profiles, Bun version, remote app versioning, development app identifiers and Android internal submission track follow subsocial. `bun run eas:build:prod:preview:android` creates a standalone Android preview using the production app identifier. `bun run eas:build:local` uses the same preview profile locally.

EAS Update uses this project's own update URL, the `fingerprint` runtime policy and separate `preview`/`production` channels, as in subsocial. The fingerprint prevents updates from targeting incompatible native runtimes. Publishing requires an installed build and an explicit command, for example `eas update --channel preview --environment preview --message "Describe the change"`. [EAS Update setup](https://docs.expo.dev/eas-update/getting-started/), [runtime versions](https://docs.expo.dev/eas-update/runtime-versions/).

### Android Firebase credentials

Configured on 2026-10-08: Firebase project `subpager-subbyte`, Android package `com.subbyte.subpager`, Cloud Messaging API v1 enabled, and the matching service-account key assigned to EAS's FCM V1 slot. The key's `cloudmessaging.messages.create` permission was checked without sending a notification. Its local file is `./subpager-subbyte-firebase-adminsdk-fbsvc-7f8ecc80a4.json`, excluded from Git and EAS build uploads. The following steps describe how to replace the configuration if needed.

1. Create a Firebase project for Subpager. Cloud Messaging is available without enabling paid hosting or databases. The Firebase project is also its Google Cloud project; no separate GCP project or cloud server is needed. [Firebase projects](https://firebase.google.com/docs/projects/learn-more), [pricing](https://firebase.google.com/pricing).
2. Register an Android app with package name `com.subbyte.subpager`, which matches preview/production. Download its `google-services.json`.
3. Keep `google-services.json` in the project root for local builds. Git ignores it; `.easignore` includes it in builds uploaded from this checkout. For GitHub-triggered workflows, `app.config.ts` reads the file path from `GOOGLE_SERVICES_JSON`, with the local file as its fallback. This project's client file is already uploaded as an EAS secret file variable for the `production` and `preview` environments. Re-upload it if you replace the local client configuration. [EAS file variables](https://docs.expo.dev/eas/environment-variables/faq/), [EAS ignore files](https://docs.expo.dev/build-reference/easignore/).
4. In Firebase Project settings, check that Cloud Messaging API v1 is enabled. In Service accounts, generate and privately keep a service-account JSON key. This is a different file from `google-services.json` and must never go into the app or Git.
5. Run the following, select Android and the preview build profile, then Google Service Account > Manage your Google Service Account Key for Push Notifications (FCM V1) > Upload a new service account key. EAS uses it to send through Firebase. [Expo FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials/).

```sh
bunx eas-cli@latest credentials --platform android
```

The development variant is registered as `com.subbyte.subpager.dev` (Subpager development) in the same Firebase project. Local `google-services.json` includes both production and development clients. EAS has a separate development package credential record with the same project's FCM v1 service account assigned. Run `bun run run:staging:android` to build and open it with Metro. Preview/production continue to use the base package. The emulator uses only the development installation and has its own approved account.

### Build and connect

After credentials setup:

```sh
bunx eas-cli@latest build --platform android --profile preview
```

Accept EAS-managed Android signing when prompted, then download and install the APK from the build link. This preview APK is for direct installation. For the existing Google Play app and its internal testing track, use the production build and submission flow below.

The receiver computer needs outbound HTTPS access to Firestore and Expo. Phones need internet access to Firebase; no public receiver origin, domain or tunnel is required. Expo still sends notifications through the EAS-managed FCM/APNs credentials.

`EXPO_ACCESS_TOKEN` is optional unless enhanced push security is enabled in Expo. If enabled, the receiver must use the matching access token. [Expo sending guide](https://docs.expo.dev/push-notifications/sending-notifications/).

Test with neutral content using [Expo's push notification tool](https://expo.dev/notifications), then confirm a new real call reaches history and alerts while the phone is locked. Test messages must not be inserted into live pager history. A successful Expo receipt is provider acceptance, not proof that the phone displayed or sounded an alert.

### iPhone

The Expo project is shared, but iOS needs Apple signing and APNs credentials rather than Firebase. Use a paid Apple Developer account, run `bunx eas-cli@latest device:create` to register an iPhone for an internal build, then build with `bunx eas-cli@latest build --platform ios --profile preview`. Let EAS manage signing and generate/select an APNs push key when prompted. No App Store listing is needed for an ad hoc internal build; each device must be included in its provisioning profile. [Expo push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/), [iOS internal distribution](https://docs.expo.dev/build/internal-distribution/).

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
- Receive a real call while the app is open, locked and closed. Compare message content, time and RIC with the receiver. Tap an alert for a message that is not cached and confirm its details load.
- Confirm alerts arrive for all RICs and that their title is the seven-digit RIC and reception time, with received content in the body.
- Disable notification permission and resume. Confirm the device token becomes null while history keeps syncing. Enable permission, resume and confirm new alerts resume without replaying old ones.
- Keep the phone offline for more than 50 new messages. Restore internet and confirm every gap is filled. Page older history and confirm refresh preserves loaded messages.
- Disconnect the Mac from the internet. Confirm local receptions remain saved, then upload after reconnecting without a burst of delayed notifications.
- Revoke the UID. Confirm cloud reads and new sends stop, and the online app clears cached history. Confirm that offline retained content cannot be remotely erased.
- Clear app data or install on another phone. Confirm the new UID has no access before manual approval.

Type, lint and dependency checks do not prove deployed rules, cloud permissions, signing, store submission, physical-device behavior or push delivery.
