# Project instructions

Use Bun and TypeScript. Keep the smallest clear solution and follow the existing patterns in each workspace.

- `app/` contains the Expo mobile app. Follow its AGENTS.md for React and TypeScript conventions.
- `server/` contains the radio receiver and background workers. Follow its AGENTS.md for receiver safety and testing.
- Firestore rules, indexes and Firebase CLI configuration live at the repository root.
- Install dependencies at the root with `bun install`. Keep one root lockfile.
- Root `check`, `lint`, `test` and `format:check` commands run both workspaces.
- Run Expo and EAS commands from `app/`. Keep the existing EAS project, package identifiers and signing credentials.
- Keep server secrets, configuration, decoder binaries, recordings and the outbox out of Git and EAS uploads.
- Do not start services, builds, deployments or real notifications as routine verification.
- Preserve concurrent changes. App and server protocol changes should be reviewed together.
