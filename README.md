# Honcho Plugin for Opencode

> Add AI-native memory to OpenCode

Give OpenCode long-term memory that survives context wipes, session restarts, and fresh chats. Honcho remembers what you're working on, durable preferences, and prior context across your projects.

## Quick Start

### Step 1: Get Your Honcho API Key

1. Go to **[app.honcho.dev](https://app.honcho.dev)**
2. Sign up or log in
3. Copy your API key

### Step 2: Install the Plugin

OpenCode installs the Honcho plugin and adds it to your global OpenCode config.

```bash
opencode plugin "@honcho-ai/opencode-honcho" --global
```

To update an existing plugin install:

```bash
opencode plugin "@honcho-ai/opencode-honcho" --force
```

Existing installs keep **directional** observation until you choose. After updating, OpenCode prompts you to keep directional or switch to unified (also via `/honcho:setup` or `/honcho:config`). If you switch to unified, you can optionally run `/honcho:import` to reingest local OpenCode transcripts into the new collection.

This command expects the `opencode` CLI to already be installed and available on your `PATH`.
If your shell cannot find `opencode`, restart your shell or source your shell config and run the command again.

### Step 3: Run Setup in OpenCode

1. Start OpenCode
2. Run `/honcho:setup`
3. Keep the default `Honcho Cloud` option unless you explicitly want a self-hosted or local endpoint
4. Enter your Honcho API key
5. Enter your `peerName`
6. Run `/honcho:status` to verify the runtime
7. If you are upgrading an existing install, choose directional vs unified when prompted. After switching to unified, optionally run `/honcho:import` to backfill local history

## What You Get

- **Persistent Memory** - OpenCode can retain durable context across sessions
- **Cloud or Local Deployments** - Use Honcho Cloud or point at a self-hosted or local Honcho instance
- **Workspace Mapping** - OpenCode projects map to Honcho workspaces
- **Session Mapping** - Sessions can be scoped per directory, repo, branch, chat instance, or globally
- **Durable Writes** - Honcho can retain stable conclusions and session context
- **Memory Retrieval** - Search memory, query Honcho knowledge, and inject relevant context into prompts
- **Peer Modeling** - User and root-agent observation flags are configurable (`observationMode`, `agentObserveMe`)

## Installation Output

OpenCode:

- registers `@honcho-ai/opencode-honcho` with OpenCode
- resolves the package's native server and TUI plugin targets
- updates plugin entries in your global OpenCode config
- activates the plugin globally for all OpenCode projects

## Configuration

OpenCode Honcho configuration lives in:

- `~/.honcho/config.json`

OpenCode reads and writes this shared config file directly. OpenCode-specific defaults live under `hosts.opencode` in that file.

```jsonc
{
  "apiKey": "hch-...",
  "peerName": "user",
  "baseUrl": "https://api.honcho.dev",
  "timeoutMs": 30000, // optional; Honcho HTTP timeout
  "enabled": true, // optional; false turns off every Honcho harness plugin that reads this file
  "hosts": {
    "opencode": {
      "workspace": "opencode",
      "aiPeer": "opencode",
      "recallMode": "hybrid",
      "observationMode": "unified", // new installs; existing configs without this field stay directional
      "agentObserveMe": false, // true opts into self-observation on the root agent peer
      "sessionStrategy": "per-directory",
      "removeUserPrefix": true, // true uses the bare peerName; false (default on upgrade) keeps the legacy user-<peerName> peer
      "apiKey": "hch-...", // optional; overrides the root apiKey for this host
      "enabled": true, // optional; false turns off only the OpenCode plugin
      "timeoutMs": 30000 // optional; overrides the root timeout for this host
    }
  }
}
```

### Shared runtime

Identity, connection, and the kill switch (`peerName`, `workspace`, `baseUrl`, `timeoutMs`, `apiKey`, `enabled`) are resolved by [`@honcho-ai/harness-plugin-core`](https://github.com/plastic-labs/honcho/tree/main/harness-plugin-core), the runtime shared by every Honcho harness plugin. The OpenCode-only keys (`aiPeer`, `recallMode`, `observationMode`, `agentObserveMe`, `sessionStrategy`, `removeUserPrefix`) are read from `hosts.opencode` by this plugin.

Resolution, highest wins: `HONCHO_*` environment → `hosts.opencode` → root → built-in.

| Environment variable | Overrides |
| --- | --- |
| `HONCHO_CONFIG_PATH` | Location of the shared config file (default `~/.honcho/config.json`) |
| `HONCHO_API_KEY` | `apiKey` |
| `HONCHO_URL`, `HONCHO_BASE_URL` | `baseUrl` (`local` means `http://localhost:8000`) |
| `HONCHO_WORKSPACE`, `HONCHO_WORKSPACE_ID` | `workspace` |
| `HONCHO_PEER_NAME` | `peerName` |
| `HONCHO_TIMEOUT_MS` | `timeoutMs` |
| `HONCHO_ENABLED=false` | `enabled` |
| `HONCHO_AI_PEER` | `hosts.opencode.aiPeer` (OpenCode only) |

String values may reference environment variables as `${VAR}`. Older files are read as-is: `environmentUrl`, `workspaceId`, and a top-level `apiKey` are remapped in memory, and the file is never rewritten just to migrate it. A root `workspace` is honored as the default when `hosts.opencode.workspace` is unset.

When `enabled` is `false` (root, `hosts.opencode`, or `HONCHO_ENABLED=false`) the plugin is inert: no capture, no prompt injection, no `shell.env` exports, and the memory tools return a "disabled" error. `/honcho:status`, `/honcho:settings`, `/honcho:setup`, and `/honcho:config` keep working so you can turn it back on (`honcho_set_config field=enabled value=true`).

### Telemetry headers

Every request to Honcho identifies the caller so usage can be attributed per harness. No conversation content is added.

| Header | Value |
| --- | --- |
| `X-Honcho-Host` | `opencode (<platform>)`, or `opencode/<version> (<platform>)` where the TUI exposes the OpenCode version |
| `X-Honcho-Plugin` | `opencode-honcho/<version>` |
| `X-Honcho-Agent-Model` | `providerID/modelID` of the OpenCode completion model for the current session (e.g. `openrouter/anthropic/claude-sonnet-4-5`), once a chat hook has reported it. Switching models mid-session (`-m`, `/models`) updates it on the next request |

### Cloud vs Local

For Honcho Cloud:

- `apiKey` is required
- `baseUrl` should remain `https://api.honcho.dev`

For self-hosted or local Honcho:

- `baseUrl` should point to your deployment, for example `http://127.0.0.1:8000`
- `apiKey` is required only if that deployment requires authentication

If OpenCode is running in Docker or another remote environment, `localhost` may not refer to your machine. The configured `baseUrl` must be reachable from the OpenCode host runtime.

### Session Strategies

| Strategy | Behavior | Best for |
| --- | --- | --- |
| `per-directory` | One session per working directory | Default project memory |
| `per-repo` | One session per repository | Repos with multiple entry directories |
| `git-branch` | Session changes with the current branch | Branch-specific workflows |
| `per-session` | New session for each OpenCode session id | Short-lived isolated work |
| `chat-instance` | Session follows the current chat instance | Highly ephemeral usage |
| `global` | One session for everything | Shared memory across all work |

### Observation Mode

Controls which Honcho collection `honcho_chat`, `honcho_create_conclusion`, and targeted prompt recall use for the user. This is independent of `agentObserveMe` (whether the agent peer is modeled). Changing modes does not migrate existing conclusions — use `/honcho:import` to backfill local OpenCode transcripts so Honcho can derive into the new collection.

| Mode | Collection | Best for |
| --- | --- | --- |
| `unified` (default on new installs) | The user's self-collection (`observer=user`, `observed=user`) | Shared workspaces where multiple agents should recall each other's conclusions about the user |
| `directional` (existing installs until set) | This AI peer's view of the user (`observer=aiPeer`, `observed=user`) | Isolated per-agent memory; previous OpenCode behavior |

New `~/.honcho/config.json` files stamp `observationMode: "unified"`. Configs that predate the field keep **directional** so an upgrade does not orphan already-derived memory. After updating, OpenCode prompts you to keep directional or switch to unified (`/honcho:setup`, `/honcho:config`, or the TUI launch dialog). If you switch, optionally run `/honcho:import` to reingest local OpenCode transcripts:

```json
{
  "hosts": {
    "opencode": {
      "observationMode": "unified"
    }
  }
}
```

### Agent self-observation

The root agent peer is created with `observeMe: false` by default: Honcho models the user, not the assistant. Set `agentObserveMe` to `true` if you want a peer card / representation of the agent itself.

```json
{
  "hosts": {
    "opencode": {
      "agentObserveMe": true
    }
  }
}
```

## Operator Commands

| Command | Description |
| --- | --- |
| `/honcho:setup` | First-time setup for cloud or local Honcho |
| `/honcho:status` | Show effective Honcho status for the current OpenCode project, including live workspace and session names when available |
| `/honcho:settings` | Show effective config values and config paths |
| `/honcho:config` | Edit shared Honcho fields in `~/.honcho/config.json` |
| `/honcho:import` | Preview or import your local OpenCode session history into Honcho |

### Importing local history

`/honcho:import` reads session history through the OpenCode SDK client that the plugin receives, maps sessions with the same `sessionStrategy` as live capture, and uploads user/assistant text with original timestamps.

- First call (or the TUI preview) is a dry run — it does not upload.
- Confirming sends conversation content to Honcho. Already-imported sessions are skipped (`~/.honcho/opencode-import-state.json`).
- After switching an existing install to `observationMode: "unified"`, import so past transcripts can be derived into the user self-collection instead of remaining only on the old directional pair.

## Agent Tools

The plugin exposes these tools inside OpenCode:

| Tool | Description |
| --- | --- |
| `honcho_setup` | Validate setup and persist shared credentials or endpoint settings |
| `honcho_status` | Show effective runtime status |
| `honcho_get_config` | Read effective and persisted settings |
| `honcho_set_config` | Update a persisted shared setting |
| `honcho_search` | Search Honcho session messages in the current session |
| `honcho_chat` | Query Honcho for reasoning-backed context (observer follows `observationMode`) |
| `honcho_create_conclusion` | Save a durable memory conclusion (same observer as `honcho_chat`) |

## Plugin Surfaces

The plugin uses these OpenCode plugin capabilities:

- `event`
- `chat.message`
- `tool.execute.after`
- `command.execute.before`
- `experimental.chat.system.transform`
- `experimental.session.compacting`
- `shell.env`
- `tool`

## Development

For macOS/Linux local branch testing:

```bash
bun install
bun run build
opencode plugin "$PWD" --global --force
```

That command wires the current checkout into OpenCode with `--force`, which is the intended local branch-testing flow.
