# Changelog

## 0.2.0

- Support OpenCode 2.x (`@opencode/cli`, `@opencode/plugin` 2.0.x) alongside 1.x from one package. The `./server` and `./tui` entries default-export `{ id, server, setup }` / `{ id, tui, setup }`: 1.x calls `server()`/`tui()`, 2.x calls `setup()`. Fixes the `Plugin must export a default definition with an id and an effect or setup function` load failure (#46).
- Split the runtime into a host-agnostic core (`createHonchoCore`) with the 1.x hook map and the 2.x `setup` as thin adapters over it. Behaviour on 1.x is unchanged.
- OpenCode 2.x runtime: user turns are captured from `session.hook("prompt")`; the memory instruction, stable snapshot, and prompt-specific recall are added in `session.hook("context")`; compaction continuity in `session.hook("compaction")`; tool activity via `tool.hook("execute.after")`; `HONCHO_*` shell variables via `shell.hook("create.before")`; the seven `honcho_*` tools via `tool.transform` (zod schemas are accepted as Standard Schema). Assistant replies are assembled from `session.text.ended` and written at `session.step.ended`, with a turn-boundary flush on `session.execution.*`. `X-Honcho-Host` uses `ctx.app.version`.
- OpenCode 2.x TUI: `/honcho:setup`, `/honcho:status`, `/honcho:settings`, and `/honcho:config` use the 2.x dialog API. `/honcho:import` reads the 2.x session store through the 2.x client (all sessions, newest first, paged by cursor) and uploads the same way as on 1.x.
- Ship root `server.js` and `tui.js` shims so a local checkout or unpacked tarball loads on 2.x, which resolves plugin directories by root module rather than the `exports` map.
- `zod` is the only new runtime dependency. Both OpenCode plugin packages are type-only devDependencies (`@opencode/plugin` for the 2.x adapter, `@opencode-ai/plugin` for the 1.x one); neither is imported at runtime, so consumers install neither. Build the bundles for the Node target so they run under both the Bun and Node OpenCode runtimes. 2.x plugin logs go to stderr, never stdout (the server may use stdout as its RPC transport).

## 0.1.4

- Inject memory through OpenCode hooks. The system prompt always carries the Honcho memory instruction; with `recallMode` `hybrid` or `context`, a stable memory snapshot is added once per session and prompt-specific recall is retrieved for user turns, then appended when new (unchanged blocks are deduplicated within the session). `tools` injects the instruction only. Recalled memory is presented as untrusted reference data.
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
