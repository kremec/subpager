# Project instructions

Use Bun and TypeScript. Keep zero runtime npm dependencies unless a concrete need justifies one. Keep files in kebab-case and use built-in APIs. Never change host drivers, run radio surveys, send real push alerts, start services or deploy as part of routine checks. Tests use temporary databases and simulated child processes. Run `bun run check`, `bun run lint` and focused `bun test` checks. Do not claim RF reception or mobile push works without hardware evidence.
