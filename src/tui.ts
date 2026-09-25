import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { sharedGlobalSettingsPath } from "./core.js"
import {
  modeEditableFieldPaths,
  normalizeSettings,
  readSharedConfig,
  resolveSharedConfigField,
  saveSettings,
  settingsMessage,
  sharedConfigPresetOptions,
  statusMessage,
  validateCloudApiKey,
} from "./tui/commands.js"
import { buildCommands, deriveLiveStatus, tui } from "./tui/v1.js"
import { buildCommandsV2, setup } from "./tui/v2.js"

const PACKAGE_ID = "@honcho-ai/opencode-honcho"

/** One default export for both generations: 1.x calls `tui()`, 2.x calls `setup()`. */
const plugin: TuiPluginModule & { id: string; setup: typeof setup } = {
  id: PACKAGE_ID,
  tui,
  setup,
}

export const __testing = {
  buildCommands,
  buildCommandsV2,
  deriveLiveStatus,
  normalizeSettings,
  modeEditableFieldPaths,
  readSharedConfig,
  resolveSharedConfigField,
  saveSettings,
  settingsMessage,
  sharedConfigPath: sharedGlobalSettingsPath,
  sharedConfigPresetOptions,
  statusMessage,
  validateCloudApiKey,
}

export default plugin
