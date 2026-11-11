import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

export const LOG_FILE_NAME = "opencode-honcho.log"
const MAX_LOG_BYTES = 1_000_000

/**
 * Always-on JSON-lines log next to the config file. Past 1 MB it keeps the newer half.
 * Best effort: a logging failure never reaches the caller.
 */
export const createFileLog = (configPath: string) => {
  const file = path.join(path.dirname(configPath), LOG_FILE_NAME)
  const write = (level: string, message: string, extra: Record<string, unknown> = {}) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (statSync(file).size > MAX_LOG_BYTES) {
          const tail = readFileSync(file, "utf-8").slice(-MAX_LOG_BYTES / 2)
          writeFileSync(file, tail.slice(tail.indexOf("\n") + 1))
        }
      } catch {
        // no file yet
      }
      appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), level, message, ...extra })}\n`)
    } catch {
      // ignore
    }
  }
  return Object.assign(write, { file })
}
