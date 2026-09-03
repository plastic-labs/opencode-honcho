# Changelog

## Unreleased

- Adopt `@honcho-ai/harness-plugin-core` as the shared runtime. `peerName`, `workspace`, `baseUrl`, `timeoutMs`, `apiKey`, and `enabled` now resolve through it (env → `hosts.opencode` → root → built-in), including `${VAR}` interpolation, `baseUrl` normalization, and in-memory migration of `environmentUrl` / `workspaceId` / top-level `apiKey`. Behavior changes: `HONCHO_CONFIG_PATH` relocates the shared config; a root `workspace` is honored when `hosts.opencode.workspace` is unset; `hosts.opencode.baseUrl` and `hosts.opencode.peerName` are honored as host overrides; `peerName` falls back to `$USER` when unset.
- Add `enabled` (root or `hosts.opencode`, or `HONCHO_ENABLED=false`) as a kill switch. Disabled installs skip capture, prompt injection, `shell.env` exports, and the memory tools; status/config tools keep working. Add `timeoutMs` (root, `hosts.opencode`, or `HONCHO_TIMEOUT_MS`) and pass it to the SDK. Both are settable with `honcho_set_config` and shown by `/honcho:status` and `/honcho:settings`.
- Send telemetry headers on every Honcho request: `X-Honcho-Host: opencode`, `X-Honcho-Plugin`, `X-Honcho-Runtime`, and `X-Honcho-Agent-Model` (`providerID/modelID` of the OpenCode model reported by chat hooks, kept current on the reused client). `honcho_status` reports `enabled`, `timeoutMs`, `configWarnings`, and `telemetry`.
- Reuse one Honcho client per endpoint/workspace/key instead of constructing a new one per hook call.
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
