# Subpager

One repository for the Expo mobile app, Bun radio receiver and Firebase configuration.

- [app/](app/README.md): Android/iOS app, live feed and offline SQLite cache.
- [server/](server/README.md): POCSAG receiver, local recordings, durable outbox, push delivery and location extraction.
- Root Firebase files: Firestore security rules and indexes.

## Install and check

```sh
bun install
bun run check
bun run lint
bun run test
bun run format:check
```

Bun workspaces share one lockfile. Dependencies use a hoisted install so native Expo modules have one installation. Each workspace keeps its own dependencies and TypeScript configuration. The receiver can install only its production dependencies with `bun install --filter subpager-server --production --frozen-lockfile` from a clean checkout.

## Run

```sh
bun run start         # Expo development server
bun run server:start  # radio receiver and background workers
bun run server:deploy # deploy server changes to the TV box
```

Do not start a second Metro server or receiver. Server commands run from `server/`, so its ignored `.env`, `config.json`, `bin/` and `data/` remain local to that directory. See the workspace READMEs for configuration and hardware commands.

## Firebase

Firestore is the sole backend database. Firebase Auth identifies devices. The app uses the client SDK; the receiver uses private Admin credentials. Deploy rules and indexes from this directory:

```sh
bunx firebase-tools deploy --only firestore --project subpager-subbyte
```

This command affects live access and indexes. Changing repository files alone does not deploy them.

## Android releases

The existing EAS project remains `@subbyte/subpager`. Its GitHub connection uses `kremec/subpager` with `app` as the base directory. `app/eas.json` and `app/.eas/workflows/release.yml` stay beside the Expo app.

Pushes to `main` that change `app/`, `shared/`, or root build configuration trigger a production Android AAB build, followed by submission of that exact build to Google Play internal testing. Server-only and documentation-only changes do not trigger releases. The shared `bun.lock` is used during builds but does not trigger them; release app dependency updates that only change the lockfile manually. The receiver deploys only when you run `bun run server:deploy`. Use `develop` for ongoing work.

Run manual EAS commands from `app/`:

```sh
cd app
bun run eas:deploy
```

The root `.easignore` excludes the receiver directory from build uploads except for its workspace manifest. The public Firebase client configuration comes from the existing EAS file variable or ignored `app/google-services.json` for local uploads.

## Branches and commits

Use `develop` for ongoing work and PRs, and `main` for releases. Branch from `develop`, use short Conventional Commit titles such as `fix(app): preserve the feed scroll position`, and title release commits `feat: vX.Y.Z`.

The monorepo preserves both original histories. The app and receiver snapshots imported during the migration are `80fed3f` and `92ade0a`, respectively.

## License

This project is source available under the [Sustainable Use License, version 1.0](LICENSE.md).
