# Changelog

## Unreleased

- Inject memory through OpenCode hooks. The system prompt always carries the Honcho memory instruction; with `recallMode` `hybrid` or `context`, a stable memory snapshot is added once per session and prompt-specific recall is appended to each user turn. `tools` injects the instruction only. Recalled memory is presented as untrusted reference data.
- Record significant tool activity (shell commands, file edits, delegated tasks) to Honcho via `tool.execute.after`. Read-only and trivial calls are skipped; shell arguments that may carry credentials are redacted down to the executable name.
- Ship a `honcho-memory` skill and install it to `~/.config/opencode/skills/honcho-memory` (or `$OPENCODE_CONFIG_DIR/skills/honcho-memory`) on session start and after setup. An unchanged file is left untouched.
- Every Honcho request carries `X-Honcho-Host` (OpenCode version and platform), `X-Honcho-Plugin` (plugin version), and `X-Honcho-Agent-Model` (the session's current `providerID/modelID`) headers via `@honcho-ai/harness-plugin-core`, so server-side telemetry can attribute traffic to the plugin, host harness, and agent model. `honcho_status` reports the identity being sent.
- Update `@honcho-ai/sdk` to 2.4.0.
- Honor `hosts.opencode.apiKey` as an override of the root `apiKey`. Setup preserves a host-scoped key instead of copying or dropping it.
- Add `hosts.opencode.observationMode`. New installs default to `unified`; configs that omit the field stay `directional`. `honcho_chat`, `honcho_create_conclusion`, and targeted prompt recall follow the mode.
- Prompt on upgrade (`/honcho:setup`, `/honcho:status`, `/honcho:config`, and TUI launch) to keep directional or switch to unified, and suggest `/honcho:import` after switching so local history can be reingested.
- Add `/honcho:import` to preview/import local OpenCode SQLite transcripts into Honcho, including after switching to unified. Import and live capture trust OpenCode's `ignored` parts and do not drop messages that start with `/`.
- Add `hosts.opencode.agentObserveMe` (default `false`). Set `true` to opt into self-observation / peer-card derivation on the root agent peer.

## 0.1.3

- Add `hosts.opencode.removeUserPrefix` to control how the user peer id is derived. New installs use the bare `<peerName>` peer, while existing installs default to the legacy `user-<peerName>` peer so previously accumulated memory is never orphaned on upgrade.
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
