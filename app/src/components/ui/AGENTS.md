# Shared UI library

This directory is the same reusable library in subsocial, subcycle, and subpager.

- Keep the complete file set and file contents identical across all three apps. Keep APIs used by another app, even when this app does not use them.
- Apply component fixes to all three apps. After editing, run `bun run ui:sync` from the repository root, then `bun run ui:check` and the affected apps' checks.
- Keep app state, navigation, data access, and screen-specific layout outside this directory. Components may use `@/theme/use-theme` for each app's colors and shared spacing/radius tokens and `typography.bodyWeight`.
- Keep the `@expo/ui` version and Slider patch compatible in every app; all apps also need `react-native-toast-message`.
- The sync commands expect the three sibling checkouts under the same parent directory. Run them from the repository root.
- Preserve existing component APIs unless their callers are updated in every app.
