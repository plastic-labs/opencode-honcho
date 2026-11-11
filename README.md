# Honcho Plugin for Opencode

> Add AI-native memory to OpenCode

Give OpenCode long-term memory that survives context wipes, session restarts, and fresh chats. Honcho remembers what you're working on, durable preferences, and prior context across your projects.

## Quick Start

### Step 1: Get a Honcho account

Sign up at **[app.honcho.dev](https://app.honcho.dev)**. You can sign OpenCode in from the browser during setup, or copy an API key from the dashboard.

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

This command expects the `opencode` CLI to already be installed and available on your `PATH`.
If your shell cannot find `opencode`, restart your shell or source your shell config and run the command again.

### Step 3: Run Setup in OpenCode

1. Start OpenCode
2. Run `/honcho:setup`
3. Choose **Sign in to Honcho Cloud** (approve OpenCode in your browser), **Honcho Cloud API key**, or **Self-hosted**
4. Confirm your `peerName`: your name in Honcho. Setup offers the name your other Honcho plugins already use, else `$USER`
5. Run `/honcho:status` to verify

## What You Get

- **Every message saved** - Each OpenCode session is one Honcho session, named after the OpenCode session id. Every user and assistant message is saved; long ones are split into `[Part i/N]` messages, never truncated. Slash commands, harness-injected text and subagent prompts are skipped
- **Scopes** - A new session joins two scopes: its git repository (worktrees share the repository's scope) and your machine's short hostname
- **Your profile at session start** - The memory directives and your peer card are added to the system prompt once per session. Nothing is fetched or injected per turn
- **Recall on demand** - The model calls `honcho_chat` to ask about you, optionally limited to a scope or widened to the whole workspace
- **Honcho Memory Skill** - A `honcho-memory` skill is installed into OpenCode's skills directory so the agent knows when to pull and save memory on its own
- **Cloud or self-hosted** - Sign in to Honcho Cloud, use an API key, or point at your own Honcho

## Installation Output

OpenCode:

- registers `@honcho-ai/opencode-honcho` with OpenCode
- resolves the package's native server and TUI plugin targets
- updates plugin entries in your global OpenCode config
- activates the plugin globally for all OpenCode projects

## Configuration

The plugin keeps its settings in one block, `hosts.opencode`, in `~/.honcho/config.json` (or the file `OPENCODE_HONCHO_CONFIG_PATH` names). Nothing is read from the top level of the file or from other plugins' blocks.

```jsonc
{
  "hosts": {
    "opencode": {
      "apiKey": "hch-...",   // or "oauth": { ... }, written by /honcho:login
      "peerName": "user",    // your name in Honcho
      "workspace": "opencode",
      "aiPeer": "opencode",
      "baseUrl": "http://127.0.0.1:8000" // self-hosted only; omit for Honcho Cloud
    }
  }
}
```

| Setting | Default | Notes |
| --- | --- | --- |
| `apiKey` / `oauth` | none | `HONCHO_API_KEY` overrides both. With both set, a live sign-in wins. Sign-in is Honcho Cloud only |
| `peerName` | `$USER` | `HONCHO_PEER_NAME` overrides it |
| `workspace` | `opencode` | `HONCHO_WORKSPACE` overrides it |
| `aiPeer` | `opencode` | `HONCHO_AI_PEER` overrides it |
| `baseUrl` | Honcho Cloud | `HONCHO_BASE_URL` (or `HONCHO_URL`) overrides it. A self-hosted Honcho without auth needs no key |

Upgrading from an older version writes the API key, server, workspace and peer that version was using into `hosts.opencode` on first start, and drops the settings this version no longer has (`recallMode`, `observationMode`, `sessionStrategy`, `removeUserPrefix`, `agentObserveMe`). Older versions kept your memory under the peer `user-<peerName>` unless `removeUserPrefix` was `true`, so that is the `peerName` you get, and your memory stays where it was. The top level and other plugins' blocks are left alone; `honcho doctor` from the Honcho CLI cleans those up once every plugin reads its own block. Both peers join each session with Honcho's defaults: each is modeled from its own messages, neither models the other.

If OpenCode is running in Docker or another remote environment, `localhost` may not refer to your machine. The configured `baseUrl` must be reachable from the OpenCode host runtime.

The plugin logs to `opencode-honcho.log` next to the config file (capped at 1 MB), as well as to OpenCode's own log.

## Operator Commands

| Command | Description |
| --- | --- |
| `/honcho:setup` | Connect to Honcho Cloud (sign in or API key) or a self-hosted Honcho, and confirm your `peerName` |
| `/honcho:login` | Sign in to Honcho Cloud in your browser (with the `honcho-cli` OAuth client until `opencode-honcho` is registered) |
| `/honcho:status` | Show the effective settings, how the plugin signs in, and the Honcho session for the current OpenCode session |
| `/honcho:settings` | Show what is saved in `hosts.opencode` |
| `/honcho:config` | Edit one `hosts.opencode` field |
| `/honcho:import` | Preview or import your local OpenCode session history into Honcho |

### Importing local history

`/honcho:import` reads session history through the OpenCode SDK client that the plugin receives and uploads user/assistant text with original timestamps, each OpenCode session into the Honcho session of the same id.

- First call (or the TUI preview) is a dry run — it does not upload.
- Confirming sends conversation content to Honcho. Already-imported sessions are skipped (`~/.honcho/opencode-import-state.json`).

## Agent Tools

The plugin exposes these tools inside OpenCode:

| Tool | Description |
| --- | --- |
| `honcho_chat` | Ask Honcho about the user (their own view of themselves). `scope` limits the answer to one or more scopes, `workspace: true` asks across the whole workspace, `reasoning_level` (`minimal` to `max`) defaults to `medium` |
| `honcho_search` | Search saved messages in this session, or the whole workspace with `workspace: true` |
| `honcho_create_conclusion` | Save an insight about the user (only when the model chooses to) |
| `honcho_status` | Show the effective settings, auth, Honcho session id and scopes, and config warnings |
| `honcho_get_config` | Read the effective settings |
| `honcho_set_config` | Save `peerName`, `workspace`, `aiPeer` or `baseUrl` to `hosts.opencode` |
| `honcho_setup` | Validate an API key (or self-hosted `baseUrl`) and save it with `peerName` |

## Plugin Surfaces

One `./server` entry serves both OpenCode generations: 1.x calls its `server()` hook map, 2.x reads its `id` and `setup()`.

| Purpose | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| Save the user turn | `chat.message` | `session.hook("prompt")` |
| Skip a slash command's expanded prompt | `command.execute.before` | the prompt matches a command template (below), or its metadata names a source |
| Directives + peer card in the system prompt | `experimental.chat.system.transform` | `session.hook("context")` |
| `honcho_*` tools | `tool` | `tool.transform` |
| Session start, assistant capture, cleanup | `event` | `event.subscribe()` (`session.created`, `session.text.ended`, `session.step.ended`, `session.execution.*`, `session.deleted`) |

- The first event or prompt of a session opens its Honcho session with both peers. The repository and host scopes are attached only when that Honcho session is first created (the plugin asks Honcho), so a resumed session is never re-attached, which would queue a backfill of its messages.
- OpenCode 2.x hands plugins a slash command's expansion as an ordinary prompt. The plugin reads the command templates from the same places OpenCode does (`opencode.json[c]` `commands`, `{command,commands}/**/*.md` in the global and `.opencode/` config directories) and skips a prompt that one of them expands to, along with `/init` and `/review`. A template with under 12 characters of fixed text is not matched. Prompts whose metadata names a source (goal continuations, scheduled runs) are skipped too.
- The system-prompt block is built once per session (one peer card request) and re-sent unchanged, so the prompt prefix stays cacheable.
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
