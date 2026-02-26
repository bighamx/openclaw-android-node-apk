import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
}));

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

import {
  resolveSharedMatrixClient,
  stopSharedClient,
  stopSharedClientForAccount,
} from "./shared.js";

function authFor(accountId: string): MatrixAuth {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@${accountId}:example.org`,
    accessToken: `token-${accountId}`,
    password: "secret",
    deviceId: `${accountId.toUpperCase()}-DEVICE`,
    deviceName: `${accountId} device`,
    initialSyncLimit: undefined,
    encryption: false,
  };
}

function createMockClient(name: string) {
  const client = {
    name,
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
  return client;
}

describe("resolveSharedMatrixClient", () => {
  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    createMatrixClientMock.mockReset();
  });

  afterEach(() => {
    stopSharedClient();
    vi.clearAllMocks();
  });

  it("keeps account clients isolated when resolves are interleaved", async () => {
    const mainAuth = authFor("main");
    const poeAuth = authFor("poe");
    const mainClient = createMockClient("main");
    const poeClient = createMockClient("poe");

    resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "poe" ? poeAuth : mainAuth,
    );
    createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) => {
      if (accountId === "poe") {
        return poeClient;
      }
      return mainClient;
    });

    const firstMain = await resolveSharedMatrixClient({ accountId: "main", startClient: false });
    const firstPoe = await resolveSharedMatrixClient({ accountId: "poe", startClient: false });
    const secondMain = await resolveSharedMatrixClient({ accountId: "main" });

    expect(firstMain).toBe(mainClient);
    expect(firstPoe).toBe(poeClient);
    expect(secondMain).toBe(mainClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    expect(mainClient.start).toHaveBeenCalledTimes(1);
    expect(poeClient.start).toHaveBeenCalledTimes(0);
  });

  it("stops only the targeted account client", async () => {
    const mainAuth = authFor("main");
    const poeAuth = authFor("poe");
    const mainClient = createMockClient("main");
    const poeClient = createMockClient("poe");

    resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "poe" ? poeAuth : mainAuth,
    );
    createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) => {
      if (accountId === "poe") {
        return poeClient;
      }
      return mainClient;
    });

    await resolveSharedMatrixClient({ accountId: "main", startClient: false });
    await resolveSharedMatrixClient({ accountId: "poe", startClient: false });

    stopSharedClientForAccount(mainAuth, "main");

    expect(mainClient.stop).toHaveBeenCalledTimes(1);
    expect(poeClient.stop).toHaveBeenCalledTimes(0);

    stopSharedClient();

    expect(poeClient.stop).toHaveBeenCalledTimes(1);
  });
});
