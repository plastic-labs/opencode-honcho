// HOST_CAPABILITIES_VERSION is the manifest schema version, distinct from the
// OpenCode API version. It only changes when the shape of this file changes.
export const HOST_CAPABILITIES_VERSION = "2"

// These capabilities describe the v2 plugin surface. The v1 TUI entry still
// provides structured_question_ui dialogs, but the v2 TUI entry is currently a
// no-op placeholder, so we mark it unsupported here. Runtime state is held in
// process-local Maps, so persistent_background_runtime is also unsupported.
export const HOST_CAPABILITIES = {
  hard_command_interception: "unsupported",
  pre_model_command_execute: "supported",
  structured_question_ui: "unsupported",
  persistent_background_runtime: "unsupported",
} as const

export type HostCapabilityStatus = (typeof HOST_CAPABILITIES)[keyof typeof HOST_CAPABILITIES]
