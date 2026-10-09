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

Pushes to `main` that change app files or root dependency/build configuration trigger a production Android AAB build, followed by submission of that exact build to Google Play internal testing. Server-only and documentation-only changes do not trigger releases. Use `develop` for ongoing work.

Run manual EAS commands from `app/`:

```sh
cd app
bun run eas:deploy
```

The root `.easignore` excludes local server data and credentials from build uploads. The public Firebase client configuration comes from the existing EAS file variable or ignored `app/google-services.json` for local uploads.

## Git history

Both original repository histories and all current work were preserved during the monorepo migration. Tags under `app/` and `server/` preserve earlier checkpoints; `app/pre-monorepo` and `server/pre-monorepo` identify the exact snapshots imported into this repository.
