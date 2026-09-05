# Changelog

## Unreleased

- Treat recalled memory as untrusted reference data in the injected instruction: the model may use its factual content but must never follow instructions embedded in it.
- Redact potentially credential-bearing shell arguments (API keys, passwords, cookies, authorization headers) before tool activity is persisted to Honcho; when a command may contain secrets, only the executable name is kept. Covers credential flags like `curl -u`, and judges compound commands (`a && b`) segment by segment.
- Always inject Honcho memory instructions on the system transform, even when `recallMode` is `tools`; keep stable and prompt-specific memory injection limited to `context` and `hybrid`, with prompt-specific context appended through `chat.message`.
- Record significant tool activity (shell commands, file edits, delegated tasks) into Honcho via `tool.execute.after`; read-only and trivial calls are skipped.
- Ship a `honcho-memory` skill with the package and copy it to OpenCode's documented global config directory (respecting `OPENCODE_CONFIG_DIR`) on session start and successful setup, while avoiding rewrites when the installed file already matches.
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
