# subpager app

Private pager history and push notifications for `subpager-server`. Expo SDK 57, React Native 0.86, TypeScript and Bun. The structure follows subcycle/subsocial: thin `src/app` routes, `src/screens`, feature modules, theme tokens and inline component styles, `@/` imports, oxlint/oxfmt and Git quality hooks. No cloud project IDs or credentials were copied from those apps.

## Branches

Use `develop` for active changes and `main` for reviewed releases and deployments. The first source commit is `feat: v0.0.1`. The remote is `git@github.com:kremec/subpager-app.git`; its default branch is `develop`. Expo is connected to this repository. `.eas/workflows/release.yml` matches subsocial: a push to `main` builds production Android and submits it to Google Play's internal track.

## Install and check

```sh
bun install
bun run check
bun run lint
bun run format:check
bunx expo install --check
bunx expo-doctor@latest
```

The repository has not been built or tested on a phone. Type and dependency checks do not verify push delivery.

## Connect a phone

1. Set up the receiver and private HTTPS server as described in `../subpager-server/README.md`.
2. Create a separate server device key for each phone. Do not reuse one key across people or devices.
3. Open **Connection settings**. Enter the HTTPS origin and device key. Development builds also permit HTTP for local testing; native platform network restrictions may still block cleartext HTTP.
4. Leave **Alert RICs** empty to receive all alerts, or enter comma-separated pager addresses. This filters push notifications only. It does not restrict who can read history. Share server access only with people allowed to see the server's full history.
5. Allow notification permission. Check the registration state in settings. It refreshes when the app returns to the foreground and when the push token changes.

Credentials are held in Expo SecureStore. Messages are cached in local SQLite, without credentials or push tokens. The latest 500 cached messages are available when offline; the cache keeps at most 1,000 messages. Message history remains complete on the server and can be paged with **Load older messages**. Switching server or device key and disconnecting erase the local message cache. Disconnect needs the old server reachable so its push registration can be removed first. If the old server is permanently unavailable, revoke that device key on the server before clearing app data.

When active, the app refreshes every 20 seconds, when a notification arrives, on resume, or with pull-to-refresh. Background alerts use Expo push. Tapping an alert opens its message, including when launching a closed app. Push delivery depends on phone settings, operating system, Expo, APNs/FCM and internet connectivity; this app is a secondary receiver, not an official emergency pager.

## Set up Expo push

The app uses the server's `content` field for history, details and cached messages. Android Firebase credentials are configured in EAS for `com.subbyte.subpager`. Push delivery still needs testing on an installed app. Apple signing and APNs credentials have not been configured.

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

If you later build the development variant, register `com.subbyte.subpager.dev` as another Android app in the same Firebase project. Use its matching client file and configure EAS push credentials for that app identifier too. Preview/production continue to use the base package.

### Build and connect

After credentials setup:

```sh
bunx eas-cli@latest build --platform android --profile preview
```

Accept EAS-managed Android signing when prompted, then download and install the APK from the build link. This preview APK is for direct installation. For the existing Google Play app and its internal testing track, use the production build and submission flow below.

The receiver computer must run the server and have outbound HTTPS access to Expo. The phone needs a reachable HTTPS origin for registration and history. The current server binds only to `127.0.0.1:8787`; a phone cannot reach its own localhost. Put a trusted HTTPS proxy/tunnel in front of that local API, or provide a private HTTPS route. Do not expose an unauthenticated raw port. No network route or tunnel has been installed here.

Create one server key per phone:

```sh
cd ~/Projects/prod/subpager-server
bun run device:add "My phone"
```

In the app, enter that HTTPS origin and key, grant notification permission, and confirm "Push notifications registered". The app obtains its Expo push token and registers it with the server. The server sends via Expo; Firebase credentials stay in EAS, not on the receiver computer. `EXPO_ACCESS_TOKEN` is optional unless enhanced push security is enabled in Expo; if enabled, the server must use the matching access token. [Expo sending guide](https://docs.expo.dev/push-notifications/sending-notifications/).

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

Use Expo's notification tool with neutral test content for transport checks. Replay is read-only and never sends push; live history contains only real receptions.

- Receive a new real call while the app is open. Confirm history, content, time and RIC match the server.
- Repeat while the phone is locked and while the app is closed. Confirm an alert, sound according to phone settings, and the correct detail screen after tapping. Use a new live page for history checks and an explicit neutral test notification for transport checks.
- Repeat with a matching RIC and a nonmatching RIC. Confirm push filtering, and that history still contains both.
- Disable notification permission. Resume the app and confirm its server registration is removed. Enable permission and resume to register again.
- Disconnect, send another message and confirm no newly queued notifications for this key. Notifications already accepted by Expo/APNs/FCM may still arrive. Change server or key and confirm cached history is erased.
- Turn off server connectivity. Confirm saved history remains readable and the error is visible. Restore it, resume the app and confirm history catches up.
- Load more than 50 messages, pull to refresh and confirm loaded pages remain present. A notification tap must work when its message has not been cached.

Configuration and dependency checks do not prove signing, store submission, physical-device behavior or push delivery.
