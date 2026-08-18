# Changelog

## 0.1.4

- Add OpenCode v2 plugin compatibility.
  - The package main entry (`@honcho-ai/opencode-honcho`) now exports a v2 `Plugin.define` server plugin.
  - The v1 runtime remains available under `@honcho-ai/opencode-honcho/v1` and the existing `./server` entry keeps exporting a v1 module for OpenCode v1.
  - The `./tui` entry now exports a hybrid module that satisfies both loaders: the default export exposes `id` and `setup` for the v2 TUI schema, while the v1 `tui` function and `__testing` helpers are hidden behind a Proxy so they remain accessible to v1 code but are invisible to v2 schema introspection.
  - v2 surfaces: tools (`honcho_setup`, `honcho_status`, `honcho_get_config`, `honcho_set_config`, `honcho_search`, `honcho_chat`, `honcho_create_conclusion`), system-prompt memory injection, shell env injection, slash commands, and best-effort event/message capture.
- Fix imports to pull v1 types from `@opencode-ai/plugin/v1` so the package type-checks against the installed beta plugin again.
- Update capability manifest to v2.

## 0.1.3

- Add `hosts.opencode.removeUserPrefix` to control how the user peer id is derived. New installs use the bare `<peerName>` to match the sibling claude-honcho / hermes-honcho plugins, while existing installs default to the legacy `user-<peerName>` peer so previously accumulated memory is never orphaned on upgrade.
- Enforce distinct user and agent peer ids to prevent collisions that would split memory across peers.
- Refactoring and cleanup work.

## 0.1.2

- Allow self-hosted and localhost Honcho setups to run without a Honcho API key.
- Inject Honcho memory when OpenCode calls the system hook without prompt text, including stable no-prompt context refreshes.
- Make the install command safe to re-run for updates by replacing stale Honcho `.tgz` and versioned plugin entries while preserving plugin options.
- Switch installation and update instructions to OpenCode's native `opencode plugin` command.

## 0.1.1

- Align Honcho runtime with shared config.
- Slash command clean-up.

## 0.1.0

- Initial standalone OpenCode Honcho plugin runtime package.
- TypeScript-native OpenCode plugin runtime built on the Honcho TypeScript SDK.
- Native OpenCode tools, prompt injection, compaction support, and multi-agent peer/session mapping.
- Shared OpenCode Honcho config at `~/.honcho/config.json`.
- Terminal/TUI surfaces clarify status vs settings, make `/honcho:setup` the primary setup path and distinguish session-message search from durable conclusion capture.
