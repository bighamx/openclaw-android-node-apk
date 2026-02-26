import { describe, expect, it, vi } from "vitest";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("matrix monitor handler pairing account scope", () => {
  it("uses account-scoped pairing store reads and upserts for dm pairing", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "ABCDEFGH", created: false }));

    const handler = createMatrixRoomMessageHandler({
      client: {
        getUserId: async () => "@bot:example.org",
      } as never,
      core: {
        channel: {
          pairing: {
            readAllowFromStore,
            upsertPairingRequest,
          },
        },
      } as never,
      cfg: {} as never,
      accountId: "poe",
      runtime: {} as never,
      logger: {
        info: () => {},
        warn: () => {},
      } as never,
      logVerboseMessage: () => {},
      allowFrom: [],
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "off",
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "pairing",
      textLimit: 8_000,
      mediaMaxBytes: 10_000_000,
      startupMs: 0,
      startupGraceMs: 0,
      directTracker: {
        isDirectMessage: async () => true,
      },
      getRoomInfo: async () => ({ altAliases: [] }),
      getMemberDisplayName: async () => "sender",
    });

    await handler("!room:example.org", {
      type: EventType.RoomMessage,
      sender: "@user:example.org",
      event_id: "$event1",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
        "m.mentions": { room: true },
      },
    } as MatrixRawEvent);

    expect(readAllowFromStore).toHaveBeenCalledWith("matrix-js", process.env, "poe");
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "matrix-js",
      id: "@user:example.org",
      accountId: "poe",
      meta: { name: "sender" },
    });
  });

  it("passes accountId into route resolution for inbound dm messages", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "poe",
      channel: "matrix-js",
      accountId: "poe",
      sessionKey: "agent:poe:main",
      mainSessionKey: "agent:poe:main",
      matchedBy: "binding.account",
    }));

    const handler = createMatrixRoomMessageHandler({
      client: {
        getUserId: async () => "@bot:example.org",
      } as never,
      core: {
        channel: {
          pairing: {
            readAllowFromStore: async () => [] as string[],
            upsertPairingRequest: async () => ({ code: "ABCDEFGH", created: false }),
          },
          commands: {
            shouldHandleTextCommands: () => false,
          },
          text: {
            hasControlCommand: () => false,
          },
          routing: {
            resolveAgentRoute,
          },
        },
      } as never,
      cfg: {} as never,
      accountId: "poe",
      runtime: {
        error: () => {},
      } as never,
      logger: {
        info: () => {},
        warn: () => {},
      } as never,
      logVerboseMessage: () => {},
      allowFrom: [],
      mentionRegexes: [],
      groupPolicy: "open",
      replyToMode: "off",
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 8_000,
      mediaMaxBytes: 10_000_000,
      startupMs: 0,
      startupGraceMs: 0,
      directTracker: {
        isDirectMessage: async () => true,
      },
      getRoomInfo: async () => ({ altAliases: [] }),
      getMemberDisplayName: async () => "sender",
    });

    await handler("!room:example.org", {
      type: EventType.RoomMessage,
      sender: "@user:example.org",
      event_id: "$event2",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
        "m.mentions": { room: true },
      },
    } as MatrixRawEvent);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix-js",
        accountId: "poe",
      }),
    );
  });
});
