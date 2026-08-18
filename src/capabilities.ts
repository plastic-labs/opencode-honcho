export const HOST_CAPABILITIES = {
  hard_command_interception: "unsupported",
  pre_model_command_execute: "supported",
  structured_question_ui: "supported",
  persistent_background_runtime: "supported",
} as const

export const HOST_CAPABILITIES_VERSION = "2"

export type HostCapabilityStatus = (typeof HOST_CAPABILITIES)[keyof typeof HOST_CAPABILITIES]
