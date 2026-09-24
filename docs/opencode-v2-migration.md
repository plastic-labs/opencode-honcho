# OpenCode v2 migration plan

Written 2026-09-24. Target: ship a v2-compatible release by Friday 2026-09-26.

Sources checked: `EXTERNAL/opencode-v2` (worktree of `origin/v2`, head `c832432d89`, 2026-09-24),
`EXTERNAL/opencode` (`origin/dev`, v1 line), the official v2 docs (`opencode.ai/v2/docs/build/plugins/`, `.../migrate-v1/`, `.../cli/`), npm, and
[plastic-labs/opencode-honcho#46](https://github.com/plastic-labs/opencode-honcho/issues/46).

## 1. State of the ecosystem

| Fact | Detail |
|---|---|
| v2 packages | `@opencode/cli`, `@opencode/plugin`, `@opencode/sdk` at 2.0.16, published 2026-09-24. `latest` dist-tag on `@opencode/cli` is 2.0.16. |
| v1 packages | `@opencode-ai/plugin` 1.18.32, published 2026-09-22. Still released from `dev`. Both lines are live. |
| Source | v2 is the `v2` branch of anomalyco/opencode (separate from `dev`; tags v2.0.0 to v2.0.16 are not ancestors of `dev`). |
| Local binary | `~/.opencode/bin/opencode` is 1.18.23. A v2 install is needed for testing. |
| Our package | `@honcho-ai/opencode-honcho` 0.1.4 depends on `@opencode-ai/plugin ^1.18.23`. Fails on v2 with `Plugin must export a default definition with an id and an effect or setup function.` (issue #46). |

Note: the `plugins.mdx` docs inside the v2 repo are still the v1 docs. The authoritative v2 references are
`packages/plugin/src/README.md` in the v2 checkout and the hosted docs above.

## 2. How the loaders work (verified in source)

### Server plugin

Both versions resolve the package's `./server` export first and fall back to the root export.

- v1 (`packages/opencode/src/plugin/shared.ts`, `resolvePackageEntrypoint`): reads `exports["./server"]`, then `main`.
  `readV1Plugin` in detect mode: if `default` is an object with `id`, it must have a `server` function.
- v2 (`packages/plugin/src/host.ts` `resolve` and `packages/core/src/plugin/module.ts`): tries `<pkg>/server`, then
  `<pkg>`. `default` must match `{ id: string, setup: fn }` or `{ id: string, effect: fn }`. Extra keys are ignored.

So one `dist/server.js` can serve both:

```ts
// src/server.ts
import type { Plugin as V2 } from "@opencode/plugin"   // type-only, nothing bundled
import { createHonchoRuntimePlugin } from "./index.js"
import { setup } from "./v2/runtime.js"

export const server = createHonchoRuntimePlugin()      // v1 hook factory (unchanged)

const definition: V2.Plugin = { id: "@honcho-ai/opencode-honcho", setup }

export default { ...definition, server }               // v1 calls server(), v2 reads id + setup
```

The official migration guide documents exactly this shape ("Support V1 and V2 from one package") and says the v1
object form is supported from 1.18.29. We already ship an object default in 0.1.4, so nothing changes for v1 users.

### TUI plugin

- v1: `./tui` default must be `{ id, tui }` (and must not also have `server`).
- v2 (`packages/tui/src/plugin/context.tsx` `isPlugin`): `./tui` default must be `{ id: string, setup: fn }`.

So `export default { id, tui, setup }` works for both. The v2 TUI only loads `./tui` when the server reports the
plugin as active with `features.tui`, which `Host.resolve` sets whenever the `./tui` export exists.

### Installation and runtime

- v2 installs npm plugins with Arborist into `~/.cache/opencode/npm/<key>/node_modules/<name>`. Our `dependencies`
  (`@honcho-ai/sdk`, `@honcho-ai/harness-plugin-core`) get installed normally.
- Config key is `plugins` (v1 was `plugin`). Entries are a string or `{ "package", "options" }`. `opencode plugin add
  <spec>` exists in v2 and writes global config. `.opencode/plugins/` is auto-discovered.
- v2 has a Node runtime build (Node 26) alongside Bun. Build the server bundle with `--target node` so it runs on both.
- Skills are discovered from `skills/` and `skill/` under every config directory, including `~/.config/opencode`.
  Our existing skill auto-install path keeps working on v2. `ctx.skill.transform` can replace the disk write later.

## 3. Hook mapping for our plugin

Inventory of what `src/index.ts` registers today, and where each goes on v2.

| v1 today (`src/index.ts`) | Purpose | v2 |
|---|---|---|
| `event` → `session.created` | hydrate session-start context, install skill, read `info.version` | `ctx.event.subscribe()` → `session.created` (`data.sessionID`, `data.location.directory`, `data.model`, `data.version`). Host version is also `ctx.app.version` directly. |
| `event` → `message.updated` + `message.part.updated` | capture completed assistant message | `session.text.ended` (`assistantMessageID`, `ordinal`, `text`) accumulated per message, flushed on `session.execution.succeeded` / `failed` / `interrupted`. Fallback: `ctx.session.context({ sessionID })` and take the trailing assistant messages. |
| `event` → `session.deleted` / `session.error` | drop state | `session.deleted`, `session.execution.failed`. |
| `event` → `session.compacted` | log boundary | `session.compaction.ended` (carries the summary `text`). |
| `chat.message` | capture user prompt; push synthetic recall part; remember model | `ctx.session.hook("prompt")` for capture (`sessionID`, `messageID`, `prompt.text`). Do not put recall in `prompt.text`: prompt edits become the persisted user message. Store the recall per session and emit it from `context` (below). Model comes from `context` (`event.model`) or `session.step.started`. |
| `experimental.chat.system.transform` | system instruction + stable memory snapshot | `ctx.session.hook("context", e => e.system.push({ type: "text", text }))`. Fires on every model call including tool continuations, so it must read cached state only, no Honcho calls inside. |
| `experimental.chat.messages.transform` | no-op | drop. |
| `experimental.session.compacting` | "Honcho Continuity" block | `ctx.session.hook("compaction", e => e.system.push({ type: "text", text }))`. |
| `tool.execute.after` | record significant tool activity | `ctx.tool.hook("execute.after", e => ...)`; `e.tool`, `e.input`, `e.status` (`completed` → `e.result`, `error` → `e.error`), `e.sessionID`. |
| `shell.env` | `HONCHO_API_KEY`, `HONCHO_URL`, `HONCHO_WORKSPACE_ID` | `ctx.shell.hook("create.before", e => { e.env.X = ... })`. |
| `command.execute.before` | no-op guard | drop. |
| `tool: {...}` (7 tools via `tool()` + zod) | honcho_get_config, honcho_setup, honcho_status, honcho_set_config, honcho_search, honcho_chat, honcho_create_conclusion | `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, execute: async (input, context) => ({ content }) }))`. Hand-write the seven JSON Schemas rather than adding a zod-to-JSON-Schema dependency. Executors receive `context.signal`; check `Tool.Context` for the session id. |
| `pluginInput.client.app.log` | logging | no ctx logger; `console.log` / `console.error` (per migration guide). |
| `pluginInput.directory` / `worktree` / `project` | project root, session scope | `ctx.location.directory`, `ctx.location.project.{id,directory,canonical}` for the plugin instance; per session use `session.created` `data.location.directory` or `ctx.session.get({ sessionID }).location`. Plugins are instantiated per location in v2, so `ctx.location` is stable for the instance. |

TUI (`src/tui.ts`, `src/import.ts`):

| v1 today | v2 |
|---|---|
| `api.command.register(() => [...{ slash: { name } }])` | `context.keymap.layer(() => ({ mode: "global", commands: [{ id, title, group: "Honcho", palette: true, slash: { name }, run }] }))`. Verify whether slash names may contain `:`; fall back to `honcho-setup` style if not. |
| `api.ui.dialog.replace(<DialogSelect …/>)` JSX components | `await context.ui.dialog.select({ title, options: [{ title, value, description }] })`, `.prompt`, `.confirm`, `.alert`. Promise-based, no JSX, so `--external @opentui/*` is unnecessary unless we render slots. |
| `api.route.current.params.sessionID` | `context.ui.router.current()` → `{ type: "session", sessionID }`. |
| `api.state.path.worktree` | `context.location?.directory` / `context.data.location.default()`. |
| `api.client.project.list / session.list / session.messages` (import) | `context.client` (v2 generated client). Endpoints changed (`session.message.list` etc.). Port separately. |
| TUI ↔ server via `~/.honcho/config.json` | unchanged; the server side re-reads config per hook. |

## 4. Recommended approach: dual-export, same package, 0.2.0

Ship one package that loads on v1 and v2. Rejected alternatives: a separate `-v2` package (users must edit config,
two release trains) and dropping v1 (v1 is still released weekly and is what our own machines run).

### Code changes

1. `src/v2/runtime.ts` (new): `export const setup = async (ctx) => { ... return cleanup }`.
   Reuse the non-hook internals from `src/index.ts` (`deriveRuntimeHandle`, `createActiveRuntime`, `captureMessage`,
   `hydrateSessionStartContext`, `summarizeToolExecution`, tool bodies). Those take `PluginInput` today only for
   `directory`/`worktree`/`project` and `client.app.log`; introduce a tiny host adapter
   `{ directory: string; worktree: string; log(level, msg, extra) }` so both entry points can build one.
2. `src/server.ts`: dual default export as in section 2. Keep `export const server`.
3. `src/tui.ts`: add `setup(context)` implementing the five commands with promise dialogs; export
   `{ id, tui, setup }`. `honcho:import` may show "not available on OpenCode 2 yet" in the first release.
4. Event loop: one `for await (const e of ctx.event.subscribe({ signal }))` started with `void`; cleanup calls
   `controller.abort()` and does not await the iterator (awaiting hangs reload).
   Guard against hot-reload double activation with a module-level generation token.
5. Recall flow: `prompt` hook captures the user turn and computes prompt-specific recall into per-session state;
   `context` hook appends the system instruction, the sealed stable snapshot, and any pending recall for that
   session's latest user message, deduped by `messageID` so tool continuations do not re-inject. Only touch
   `event.system`; do not mutate `event.messages` (may be frozen).
6. Telemetry headers: `X-Honcho-Host` from `ctx.app.version` (+ `ctx.app.channel`), model from `context`
   `event.model` or `session.step.started`.
7. Build: server and index bundles with `--target node`, `--external @opencode-ai/plugin --external @opencode/plugin`.
   All `@opencode/plugin` imports are `import type` (its `Plugin.define` is an identity function, so a plain typed
   object is equivalent). Add `@opencode/plugin` as a devDependency for types. Keep `@opencode-ai/plugin` as a
   runtime dependency because the v1 path imports `tool` from it.
8. `package.json`: `exports` unchanged (`./server`, `./tui`), add `"./package.json"`. Version 0.2.0. Do not set
   `engines.opencode` (v1 enforces it and would block v2 semver).

### Tests (keep small)

One wire test against `dist/server.js` and `dist/tui.js`: default export has `id`, `setup` function, and `server`
(or `tui`) function; `setup(fakeCtx)` registers `session.hook("prompt"|"context"|"compaction")`,
`tool.hook("execute.after")`, `shell.hook("create.before")`, one `tool.transform` adding the seven tools, and one
event subscription; drive a prompt then a context event and assert the Honcho system text is appended once.
Keep existing v1 tests as they are.

### Verification before publishing

1. Scratch HOME (see `docs/vm-runbook.md`): `npm i -g @opencode/cli@2.0.16`, `opencode plugin add /abs/path/to/repo`
   (or `plugins: ["/abs/path"]`), open TUI, confirm plugin `active` with TUI feature, run a prompt, check Honcho
   receives user and assistant messages with the three telemetry headers, run each `/honcho…` command.
2. Same with v1 1.18.32 and 1.18.23 (`opencode plugin "$PWD" --global --force`) to confirm no regression.
3. Test the installed npm tarball (`npm pack` then `opencode plugin add ./tgz`), not only a linked path.

### Schedule

- Wed/Thu: runtime.ts, server.ts, tui.ts, build changes, wire test.
- Thu: end-to-end on v2 and v1 from a scratch HOME; fix fallout (slash names, tool context, event payloads).
- Fri: CHANGELOG, README (`plugins` key, `opencode plugin add`), publish 0.2.0 after explicit go-ahead, reply on #46.

## 5. Gotchas collected from source

- `context` runs on every model call, including after each tool result. Anything network-bound belongs in `prompt`
  or the event loop, with `context` reading cached state.
- `prompt` edits are persisted as the user's message and the hook runs before attachment resolution. Use it for
  capture only.
- Compaction: v2 emits `session.compaction.ended` with the summary text. `session.compacted` also exists but is
  ephemeral and carries only the session id.
- Event stream cleanup: abort, never await. Setup may run twice on hot reload; the old generation's cleanup runs.
- `ctx.location` is where the plugin instance loaded, not necessarily the session's directory. Read the session.
- Tool names: dots and unsupported characters become `_`; our `honcho_*` names are fine.
- The v2 client API differs from v1 (`session.message.list`, locations). Only the TUI import feature depends on it.

## 6. Follow-ups after 0.2.0

- Port `honcho:import` to the v2 client.
- Register the `honcho-memory` skill through `ctx.skill.transform` instead of writing into `~/.config/opencode/skills`.
- Move OpenCode-scoped settings into `ctx.storage` or `plugins[].options` while keeping `~/.honcho/config.json`
  as the cross-harness source of truth.
- Optional RPC contract (`./rpc`) so the TUI can show live status from the server plugin instead of re-deriving it
  from the config file.

## 7. Verification log (2026-09-24, branch `feat/opencode-v2`)

Implemented as planned: `createHonchoCore` in `src/index.ts`, `src/v2/runtime.ts`, `src/v2/types.ts`, dual default
exports in `src/server.ts` and `src/tui.ts`, root `server.js` / `tui.js` shims, Node build target, `tests/v2-wire.test.js`.

| Check | Result |
|---|---|
| `bun run test` (28 tests, 10 files) | pass |
| OpenCode 2.0.16 local (macOS), `plugins: ["/abs/checkout"]` | `/plugins` lists TUI + Server plugin `active`; `/honcho:status`, `/honcho:settings`, `/honcho:config`, `/honcho:setup`, `/honcho:import` dialogs work; a turn writes user + assistant messages to Honcho with `session.prompt` / `event.session.step.ended` sources and `hostVersion: 2.0.16` |
| OpenCode 2.0.16 on Azure VM `opencode-honcho-test` (Ubuntu, Bun runtime), unpacked tarball dir | same: plugins active, `/honcho:status`, turn captured both ways |
| OpenCode 1.18.23 local and 1.18.32 on the VM, `plugin: [...]` | plugin loads, `Honcho session initialized`, user turn captured (headless assistant capture is the known 1.x race) |

Findings that changed the plan:

- **Local directories need root modules.** For an absolute directory in `plugins`, v2 resolves `<dir>/server` and
  `<dir>/tui` (extension inferred), not the `exports` map; without them the plugin is silently dropped and
  `opencode plugin list` says "No plugins found". npm installs (`target.name` set) do use `exports`. Hence the shims.
- **Never log to stdout.** In `opencode run --standalone` the server child uses stdout as its RPC transport; plugin
  `console.log` output vanished. All v2 logs go through `console.error`.
- **Keymap layers must be created inside a slot.** `context.keymap.layer` calls `useContext` and throws
  `Keymap.Provider is missing` when called directly from `setup`; wrap it in `context.ui.slot({ append: "app", render })`.
- **Headless runs cut the assistant capture short.** `opencode run` exits right after the reply; the write started at
  `session.step.ended` does not finish. The TUI and long-lived server capture fine. Same class of race as 1.x.
- **The curl installer still ships 1.x.** `curl -fsSL https://opencode.ai/install | bash` installs the latest GitHub
  release, 1.18.32 today, because v2 has no GitHub Releases. v2 comes from npm (`@opencode/cli`); on a Node-less VM,
  `bun add -g --trust @opencode/cli@2.0.16` works.
- **v2 free models** (`opencode/big-pickle` etc.) need no provider auth, handy for smoke tests. `--log-level` values
  are lowercase on v2.
- The TUI driver used for the text screenshots is `tui_drive.py` (pty + pyte); worth moving into the repo's tooling.
