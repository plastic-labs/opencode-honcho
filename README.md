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

This command expects the `opencode` CLI to already be installed and available on your `PATH`.
If your shell cannot find `opencode`, restart your shell or source your shell config and run the command again.

### Step 3: Run Setup in OpenCode

1. Start OpenCode
2. Run `/honcho:setup`
3. Keep the default `Honcho Cloud` option unless you explicitly want a self-hosted or local endpoint
4. Enter your Honcho API key
5. Enter your `peerName`
6. Run `/honcho:status` to verify the runtime

## What You Get

- **Persistent Memory** - OpenCode can retain durable context across sessions
- **Cloud or Local Deployments** - Use Honcho Cloud or point at a self-hosted or local Honcho instance
- **Workspace Mapping** - OpenCode projects map to Honcho workspaces
- **Session Mapping** - Sessions can be scoped per directory, repo, branch, chat instance, or globally
- **Durable Writes** - Honcho can retain stable conclusions and session context
- **Memory Retrieval** - Search memory, query Honcho knowledge, and inject relevant context into prompts
- **Peer Modeling** - User and root-agent peers follow a fixed observation model tuned for OpenCode

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
  "hosts": {
    "opencode": {
      "workspace": "opencode",
      "aiPeer": "opencode",
      "recallMode": "hybrid",
      "sessionStrategy": "per-directory",
      "removeUserPrefix": true // true uses the bare peerName; false (default on upgrade) keeps the legacy user-<peerName> peer
    }
  }
}
```

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

## Operator Commands

| Command | Description |
| --- | --- |
| `/honcho:setup` | First-time setup for cloud or local Honcho |
| `/honcho:status` | Show effective Honcho status for the current OpenCode project, including live workspace and session names when available |
| `/honcho:settings` | Show effective config values and config paths |
| `/honcho:config` | Edit shared Honcho fields in `~/.honcho/config.json` |

## Agent Tools

The plugin exposes these tools inside OpenCode:

| Tool | Description |
| --- | --- |
| `honcho_setup` | Validate setup and persist shared credentials or endpoint settings |
| `honcho_status` | Show effective runtime status |
| `honcho_get_config` | Read effective and persisted settings |
| `honcho_set_config` | Update a persisted shared setting |
| `honcho_search` | Search Honcho session messages in the current session |
| `honcho_chat` | Query Honcho for reasoning-backed context |
| `honcho_create_conclusion` | Save a durable memory conclusion |

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
