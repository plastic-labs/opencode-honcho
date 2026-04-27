import { mkdir, writeFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const DEFAULT_PACKAGE_NAME = "@honcho-ai/opencode-honcho"
const HONCHO_TARBALL_PATTERN = /(?:^|[/\\])honcho-ai-opencode-honcho-[^/\\]+\.tgz$/

type InstallConfigOptions = {
  configDir?: string
  pluginSpec?: string
}

type InstallConfigResult = {
  configDir: string
  opencodeConfigPath: string
  commandNames: string[]
  pluginSpec: string
}

const opencodeCommands = () => ({})

const globalConfigDir = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")

const readJsonFile = async (filePath: string) => {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw error
  }
}

const normalizePluginList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string | [string, Record<string, unknown>] =>
          typeof entry === "string" ||
          (Array.isArray(entry) &&
            entry.length >= 1 &&
            typeof entry[0] === "string" &&
            (entry.length === 1 || typeof entry[1] === "object" || entry[1] === undefined)),
      )
    : []

const stripPackageVersion = (spec: string) => {
  const slashIndex = spec.lastIndexOf("/")
  const atIndex = spec.lastIndexOf("@")
  return atIndex > slashIndex ? spec.slice(0, atIndex) : spec
}

const isHonchoPluginSpec = (spec: string) =>
  stripPackageVersion(spec) === DEFAULT_PACKAGE_NAME || HONCHO_TARBALL_PATTERN.test(spec)

const ensurePluginSpec = (
  plugins: Array<string | [string, Record<string, unknown>]>,
  pluginSpec: string,
) => {
  if (isHonchoPluginSpec(pluginSpec)) {
    const staleHonchoEntryWithOptions = plugins.find((entry) => {
      const spec = typeof entry === "string" ? entry : entry[0]
      return !HONCHO_TARBALL_PATTERN.test(spec) && isHonchoPluginSpec(spec) && Array.isArray(entry) && entry[1]
    })
    const nextHonchoEntry = Array.isArray(staleHonchoEntryWithOptions)
      ? [pluginSpec, staleHonchoEntryWithOptions[1]]
      : pluginSpec
    const pluginsWithoutStaleHoncho = plugins.filter((entry) => {
      const spec = typeof entry === "string" ? entry : entry[0]
      return !isHonchoPluginSpec(spec)
    })
    return [...pluginsWithoutStaleHoncho, nextHonchoEntry]
  }
  const packageName = stripPackageVersion(pluginSpec)
  if (
    plugins.some((entry) => {
      const spec = typeof entry === "string" ? entry : entry[0]
      return spec === pluginSpec || spec === packageName || stripPackageVersion(spec) === packageName
    })
  ) {
    return plugins
  }
  return [...plugins, pluginSpec]
}

export const installGlobalConfig = async ({
  configDir = globalConfigDir(),
  pluginSpec = DEFAULT_PACKAGE_NAME,
}: InstallConfigOptions = {}): Promise<InstallConfigResult> => {
  const absoluteConfigDir = path.resolve(configDir)
  const opencodeConfigPath = path.join(absoluteConfigDir, "opencode.json")
  const current = await readJsonFile(opencodeConfigPath)
  const next: Record<string, unknown> = {
    ...current,
    $schema: typeof current.$schema === "string" ? current.$schema : "https://opencode.ai/config.json",
    plugin: ensurePluginSpec(normalizePluginList(current.plugin), pluginSpec),
    command: {
      ...(typeof current.command === "object" && current.command ? (current.command as Record<string, unknown>) : {}),
      ...opencodeCommands(),
    },
  }

  await mkdir(absoluteConfigDir, { recursive: true })
  await writeFile(opencodeConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8")

  return {
    configDir: absoluteConfigDir,
    opencodeConfigPath,
    commandNames: Object.keys(opencodeCommands()),
    pluginSpec,
  }
}

export const scaffoldTemplates = {
  DEFAULT_PACKAGE_NAME,
  globalConfigDir,
  installGlobalConfig,
  opencodeCommands,
}
