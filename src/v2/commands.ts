import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isRecord } from "../core.js"

/**
 * OpenCode 2.x runs a slash command by expanding its template and sending the result through
 * `session.prompt`, the same hook a typed prompt arrives on, with no metadata saying it was a
 * command. This recognises those expansions so they are not saved as the user's words: it reads
 * the command templates from the same sources OpenCode's config command plugin does
 * (`packages/core/src/config/plugin/command.ts`, `config/discovery.ts`) and matches the prompt
 * against each template the way `evaluateTemplate` fills it in.
 */

const CONFIG_FILES = ["opencode.json", "opencode.jsonc"]
const COMMAND_DIRS = ["command", "commands"]

// A template with less fixed text than this can't be told apart from a typed prompt, so it is not
// matched: saving a command's expansion is the safer mistake than dropping something the user wrote.
const MIN_LITERAL_CHARS = 12
const PLACEHOLDER = /\$(?:ARGUMENTS|[1-9]\d*)/
const HOLE = /\$(?:ARGUMENTS|[1-9]\d*)|!`[^`]+`/g

/**
 * Built-in `/init` and `/review` (`packages/core/src/plugin/command/{initialize,review}.txt`): their
 * first lines, unchanged since the 2.x command registry landed. The texts run to several KB.
 */
const BUILTIN_OPENINGS = [
  "Create or update `AGENTS.md` for this repository.",
  "You are a code reviewer. Your job is to review code changes and provide actionable feedback.",
]
const BUILTIN_MIN_CHARS = 1500

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * An anchored pattern for what `evaluateTemplate` can produce from `template`: placeholders and
 * `!\`cmd\`` output are wildcards; whitespace is loose because the result is trimmed; a template
 * without placeholders gets any arguments appended after a blank line. Null when too little of the
 * template is fixed text to recognise it.
 */
export const compileTemplate = (template: string): RegExp | null => {
  const text = template.trim()
  const literals = text.split(HOLE)
  if (literals.join("").replace(/\s+/g, "").length < MIN_LITERAL_CHARS) return null
  const body = literals.map((part) => escape(part).replace(/\s+/g, "\\s*")).join("[\\s\\S]*?")
  const appended = PLACEHOLDER.test(text) ? "" : "(?:\\s*\\n\\n[\\s\\S]*)?"
  return new RegExp(`^\\s*${body}${appended}\\s*$`)
}

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf-8")
  } catch {
    return null
  }
}

const isDirectory = (dir: string) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// JSONC: drop comments outside strings, then trailing commas.
const parseJsonc = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // fall through
  }
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      if (i < 0) break
      i++
    } else {
      out += char
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return null
  }
}

/** `commands` (and the 1.x `command` key 2.x still reads) from one config document. */
const documentTemplates = (value: unknown): string[] => {
  if (!isRecord(value)) return []
  return [value.commands, value.command].flatMap((map) =>
    isRecord(map)
      ? Object.values(map).flatMap((command) =>
          isRecord(command) && typeof command.template === "string" ? [command.template] : [],
        )
      : [],
  )
}

const fileTemplates = (file: string) => {
  const text = readText(file)
  return text === null ? [] : documentTemplates(parseJsonc(text))
}

const markdownFiles = (dir: string, depth = 0): string[] => {
  if (depth > 8) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name)
    if (isDirectory(full)) return markdownFiles(full, depth + 1)
    return name.endsWith(".md") ? [full] : []
  })
}

/** A command file's template: its body after the frontmatter, trimmed. */
const markdownTemplate = (content: string) =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim()

/** One config directory: its `opencode.json[c]` and its `{command,commands}/**\/*.md` files. */
const directoryTemplates = (dir: string) => [
  ...CONFIG_FILES.flatMap((name) => fileTemplates(path.join(dir, name))),
  ...COMMAND_DIRS.flatMap((sub) => markdownFiles(path.join(dir, sub)))
    .sort()
    .flatMap((file) => {
      const content = readText(file)
      return content === null ? [] : [markdownTemplate(content)]
    }),
]

const systemDirectory = () =>
  process.platform === "darwin"
    ? "/Library/Application Support/opencode"
    : process.platform === "win32"
      ? path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
      : "/etc/opencode"

const globalDirectory = () =>
  process.env.OPENCODE_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || homedir(), ".config"), "opencode")

/** Every command template OpenCode 2.x would load for `directory`, as config discovery finds them. */
export const commandTemplates = (directory: string): string[] => {
  const templates = [...directoryTemplates(systemDirectory()), ...directoryTemplates(globalDirectory())]
  if (process.env.OPENCODE_CONFIG) templates.push(...fileTemplates(process.env.OPENCODE_CONFIG))
  // Project: every ancestor's opencode.json[c] and .opencode/ directory.
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    templates.push(...CONFIG_FILES.flatMap((name) => fileTemplates(path.join(dir, name))))
    const local = path.join(dir, ".opencode")
    if (local !== globalDirectory() && existsSync(local)) templates.push(...directoryTemplates(local))
    if (path.dirname(dir) === dir) break
  }
  if (process.env.OPENCODE_CONFIG_CONTENT) templates.push(...documentTemplates(parseJsonc(process.env.OPENCODE_CONFIG_CONTENT)))
  return templates
}

const REFRESH_MS = 5_000

/** A matcher for one plugin location, re-reading the command sources at most every few seconds. */
export const createCommandMatcher = (directory: string) => {
  let compiled: RegExp[] = []
  let loadedAt = 0
  return (prompt: string) => {
    if (Date.now() - loadedAt > REFRESH_MS) {
      compiled = commandTemplates(directory).flatMap((template) => compileTemplate(template) ?? [])
      loadedAt = Date.now()
    }
    const text = prompt.trim()
    if (text.length >= BUILTIN_MIN_CHARS && BUILTIN_OPENINGS.some((opening) => text.startsWith(opening))) return true
    return compiled.some((pattern) => pattern.test(text))
  }
}

/**
 * Prompts OpenCode or another plugin generated rather than the user typed carry metadata naming
 * their source: `{ source: "goal" }` from the goal plugin, `{ schedule }` from scheduled runs, and
 * `{ source: "command" }` from slash commands once OpenCode tags them.
 */
export const isGeneratedPrompt = (metadata: unknown) =>
  isRecord(metadata) && ((typeof metadata.source === "string" && metadata.source !== "") || metadata.schedule !== undefined)
