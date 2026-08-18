import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

let writeQueue: Promise<void> = Promise.resolve()

export const atomicWriteJson = async (filePath: string, data: unknown): Promise<void> => {
  const dir = path.dirname(filePath)
  const tmpFile = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}`)
  const payload = `${JSON.stringify(data, null, 2)}\n`

  const current = writeQueue
    .then(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(tmpFile, payload, "utf-8")
      await rename(tmpFile, filePath)
    })
    .catch(async (error) => {
      try {
        const { unlink } = await import("node:fs/promises")
        await unlink(tmpFile)
      } catch {
        // ignore cleanup failure
      }
      throw error
    })

  writeQueue = current.catch(() => {
    // swallow so the queue keeps moving
  })

  await current
}
