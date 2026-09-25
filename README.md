# Honcho Plugin for Opencode

> Add AI-native memory to OpenCode

Give OpenCode long-term memory that survives context wipes, session restarts, and fresh chats. Honcho remembers what you're working on, durable preferences, and prior context across your projects.

## Quick Start

### Step 1: Get Your Honcho API Key

1. Go to **[app.honcho.dev](https://app.honcho.dev)**
2. Sign up or log in
3. Copy your API key

### Step 2: Install the Plugin

The plugin supports OpenCode 2.x and 1.x from one package. OpenCode installs it and adds it to your global OpenCode config.

OpenCode 2.x (`@opencode/cli`):

```bash
opencode plugin add "@honcho-ai/opencode-honcho"
```

OpenCode 1.x:

```bash
opencode plugin "@honcho-ai/opencode-honcho" --global
```

To update an existing install, run `opencode plugin update` (2.x) or `opencode plugin "@honcho-ai/opencode-honcho" --force` (1.x).

If you edit the config by hand instead, the key is `plugins` on 2.x and `plugin` on 1.x, both taking `"@honcho-ai/opencode-honcho"` as an entry.

Existing installs keep **directional** observation until you choose. After updating, OpenCode prompts you to keep directional or switch to unified (also via `/honcho:setup` or `/honcho:config`). If you switch to unified, you can optionally run `/honcho:import` (OpenCode 1.x only) to reingest local OpenCode transcripts into the new collection.

This command expects the `opencode` CLI to already be installed and available on your `PATH`.
If your shell cannot find `opencode`, restart your shell or source your shell config and run the command again.

### Step 3: Run Setup in OpenCode

1. Start OpenCode
2. Run `/honcho:setup`
3. Keep the default `Honcho Cloud` option unless you explicitly want a self-hosted or local endpoint
4. Enter your Honcho API key
5. Enter your `peerName`
6. Run `/honcho:status` to verify the runtime
7. If you are upgrading an existing install, choose directional vs unified when prompted. After switching to unified, optionally run `/honcho:import` (OpenCode 1.x only) to backfill local history

## What You Get

- **Persistent Memory** - OpenCode can retain durable context across sessions
- **Hook-Driven Memory** - Hooks inject memory into the prompt and record significant tool activity, so recall works regardless of the model
- **Honcho Memory Skill** - A `honcho-memory` skill is installed into OpenCode's skills directory so the agent knows when to pull and save memory on its own
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
  "hosts": {
    "opencode": {
      "workspace": "opencode",
      "aiPeer": "opencode",
      "recallMode": "hybrid",
      "observationMode": "unified", // new installs; existing configs without this field stay directional
      "agentObserveMe": false, // true opts into self-observation on the root agent peer
      "sessionStrategy": "per-directory",
      "removeUserPrefix": true, // true uses the bare peerName; false (default on upgrade) keeps the legacy user-<peerName> peer
      "apiKey": "hch-..." // optional; overrides the root apiKey for this host
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

### Observation Mode

Controls which Honcho collection `honcho_chat`, `honcho_create_conclusion`, and targeted prompt recall use for the user. This is independent of `agentObserveMe` (whether the agent peer is modeled). Changing modes does not migrate existing conclusions — use `/honcho:import` (OpenCode 1.x only) to backfill local OpenCode transcripts so Honcho can derive into the new collection.

| Mode | Collection | Best for |
| --- | --- | --- |
| `unified` (default on new installs) | The user's self-collection (`observer=user`, `observed=user`) | Shared workspaces where multiple agents should recall each other's conclusions about the user |
| `directional` (existing installs until set) | This AI peer's view of the user (`observer=aiPeer`, `observed=user`) | Isolated per-agent memory; previous OpenCode behavior |

New `~/.honcho/config.json` files stamp `observationMode: "unified"`. Configs that predate the field keep **directional** so an upgrade does not orphan already-derived memory. After updating, OpenCode prompts you to keep directional or switch to unified (`/honcho:setup`, `/honcho:config`, or the TUI launch dialog). If you switch, optionally run `/honcho:import` (OpenCode 1.x only) to reingest local OpenCode transcripts:

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
| `/honcho:import` | Preview or import your local OpenCode session history into Honcho (OpenCode 1.x only for now) |

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

One `./server` entry serves both OpenCode generations: 1.x calls its `server()` hook map, 2.x reads its `id` and `setup()`.

| Purpose | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| Capture the user turn, fetch prompt-specific recall | `chat.message` | `session.hook("prompt")` |
| Memory instruction + stable snapshot (+ recall on 2.x) | `experimental.chat.system.transform` | `session.hook("context")` |
| Continuity block during compaction | `experimental.session.compacting` | `session.hook("compaction")` |
| Record significant tool activity | `tool.execute.after` | `tool.hook("execute.after")` |
| `HONCHO_*` variables for shell tools | `shell.env` | `shell.hook("create.before")` |
| `honcho_*` tools | `tool` | `tool.transform` |
| Session start, assistant capture, cleanup | `event` | `event.subscribe()` (`session.created`, `session.text.ended`, `session.step.ended`, `session.execution.*`, `session.deleted`) |

On 2.x, prompt-specific recall rides in the request context instead of a synthetic message part, because 2.x persists prompt-hook edits as the user's message.

### How hooks drive memory

- `experimental.chat.system.transform` always appends the Honcho memory instruction. With `recallMode` `hybrid` or `context` it also adds a stable memory snapshot (user profile, agent context, session summary), captured once on the first turn of a session.
- `chat.message` retrieves prompt-specific recall on user turns in `hybrid` and `context` mode, appending a synthetic memory part when it yields a new block. Unchanged blocks are deduplicated within the session. In `tools` mode nothing beyond the instruction is injected; the model reaches memory only through the `honcho_*` tools.
- `tool.execute.after` records shell commands, file edits, and delegated tasks to the session. Read-only and trivial calls are skipped. Shell arguments that may carry credentials are redacted, keeping only the executable name.
- On session start and after `honcho_setup`, the packaged `honcho-memory` skill is copied to `~/.config/opencode/skills/honcho-memory`, or `$OPENCODE_CONFIG_DIR/skills/honcho-memory` when set. An unchanged file is left untouched.

## Development

For macOS/Linux local branch testing:

```bash
bun install
bun run build
```

On OpenCode 1.x, register the checkout with the CLI:

```bash
opencode plugin "$PWD" --global --force
```

On OpenCode 2.x, `opencode plugin add` only accepts npm or Git package specifiers, so point the `plugins` key in `~/.config/opencode/opencode.json` at the checkout instead:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-honcho"]
}
```

OpenCode 2.x resolves a local plugin directory by its root `server` and `tui` modules rather than the `exports` map, so the checkout ships `server.js` and `tui.js` shims that re-export `dist/`. Run `bun run build` before starting OpenCode. To test the packed tarball on 2.x, unpack it and point `plugins` at the unpacked directory; `plugin add` does not take tarballs. Plugin logs go to stderr on 2.x (`opencode run --standalone --print-logs`) and to OpenCode's log under `service=opencode-honcho` on 1.x.

`/honcho:import` is available on OpenCode 1.x only for now.
