import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("extractCompletedAssistantMessage uses current-turn parts and completion timestamp", () => {
  const partState = new Map()

  __testing.upsertAssistantMessagePart(partState, {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-reasoning",
          sessionID: "ses-123",
          messageID: "msg-123",
          type: "reasoning",
          text: "internal",
          time: { start: 1710000000000 },
        },
      },
    },
  })
  __testing.upsertAssistantMessagePart(partState, {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-visible",
          sessionID: "ses-123",
          messageID: "msg-123",
          type: "text",
          text: "Final reply",
          time: { start: 1710000000001 },
        },
      },
    },
  })

  expect(
    __testing.extractCompletedAssistantMessage(
      {
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-123",
              sessionID: "ses-123",
              role: "assistant",
              time: {
                created: 1710000000000,
                completed: 1710000004321,
              },
            },
          },
        },
      },
      partState,
    ),
  ).toEqual({
    messageId: "msg-123",
    sessionID: "ses-123",
    text: "Final reply",
    createdAt: "2024-03-09T16:00:04.321Z",
  })
})

test("extractSessionId reads session id from nested event info", () => {
  expect(
    __testing.extractSessionId({
      event: {
        type: "message.updated",
        properties: {
          info: { role: "assistant", sessionID: "ses-789" },
        },
      },
    }),
  ).toBe("ses-789")
})

test("extractSessionId reads session id from message.part.updated payloads", () => {
  expect(
    __testing.extractSessionId({
      event: {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-456" },
        },
      },
    }),
  ).toBe("ses-456")
})

test("extractSessionId prefers top-level ids and falls back across casing variants", () => {
  expect(__testing.extractSessionId({ session_id: "ses-snake" })).toBe("ses-snake")
  expect(
    __testing.extractSessionId({
      sessionId: "ses-top",
      event: { sessionID: "ses-nested" },
    }),
  ).toBe("ses-top")
})

test("markAssistantMessageCaptured only marks the message after persistence succeeds", async () => {
  const state = __testing.createSessionState()
  state.assistantMessageParts.set("msg-123", {
    sessionID: "ses-123",
    parts: new Map([["part-visible", "Final reply"]]),
  })

  let attempts = 0
  await expect(
    __testing.markAssistantMessageCaptured(state, { messageId: "msg-123" }, async () => {
      attempts += 1
      throw new Error("transient write failure")
    }),
  ).rejects.toThrow(/transient write failure/)

  expect(attempts).toBe(1)
  expect(state.capturedAssistantMessageIds.has("msg-123")).toBe(false)
  expect(state.assistantMessageParts.has("msg-123")).toBe(true)

  const captured = await __testing.markAssistantMessageCaptured(state, { messageId: "msg-123" }, async () => {
    attempts += 1
  })

  expect(captured).toBe(true)
  expect(attempts).toBe(2)
  expect(state.capturedAssistantMessageIds.has("msg-123")).toBe(true)
  expect(state.assistantMessageParts.has("msg-123")).toBe(false)
})

test("markAssistantMessageCaptured deduplicates concurrent writes for the same assistant message", async () => {
  const state = __testing.createSessionState()
  state.assistantMessageParts.set("msg-123", {
    sessionID: "ses-123",
    parts: new Map([["part-visible", "Final reply"]]),
  })

  let release
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  let attempts = 0

  const first = __testing.markAssistantMessageCaptured(state, { messageId: "msg-123" }, async () => {
    attempts += 1
    await barrier
  })
  const second = __testing.markAssistantMessageCaptured(state, { messageId: "msg-123" }, async () => {
    attempts += 1
    await barrier
  })

  release()

  await expect(first).resolves.toBe(true)
  await expect(second).resolves.toBe(false)
  expect(attempts).toBe(1)
  expect(state.capturedAssistantMessageIds.has("msg-123")).toBe(true)
  expect(state.assistantMessageParts.has("msg-123")).toBe(false)
})
