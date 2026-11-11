import type { TranscriptSource } from "../import.js"

export type DialogOption<T = string> = {
  title: string
  value: T
  description?: string
}

/** Promise dialogs. Matches OpenCode 2.x; 1.x is adapted up to this shape. `undefined` means the user bailed. */
export type Dialogs = {
  alert(input: { title: string; message: string }): Promise<void>
  confirm(input: {
    title: string
    message: string
    label?: { confirm?: string; cancel?: string }
  }): Promise<boolean | undefined>
  select<T>(input: { title: string; options: DialogOption<T>[]; current?: T }): Promise<T | undefined>
  prompt(input: { title: string; value?: string; placeholder?: string }): Promise<string | undefined>
}

export type LiveStatus = {
  openCodeSessionId?: string
}

export type TuiSession = {
  dialogs: Dialogs
  liveStatus: () => LiveStatus
  transcripts: TranscriptSource
}

export type TuiCommandSpec = {
  id: string
  title: string
  description: string
  slash: string
  run: (session: TuiSession) => Promise<void>
}
