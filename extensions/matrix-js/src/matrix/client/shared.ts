import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { LogService } from "../sdk/logger.js";
import { resolveMatrixAuth } from "./config.js";
import { createMatrixClient } from "./create-client.js";
import { DEFAULT_ACCOUNT_KEY } from "./storage.js";
import type { MatrixAuth } from "./types.js";

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
  startPromise: Promise<void> | null;
};

const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();

function buildSharedClientKey(auth: MatrixAuth, accountId?: string | null): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    accountId ?? DEFAULT_ACCOUNT_KEY,
  ].join("|");
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
  accountId?: string | null;
}): Promise<SharedMatrixClientState> {
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    password: params.auth.password,
    deviceId: params.auth.deviceId,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    initialSyncLimit: params.auth.initialSyncLimit,
    accountId: params.accountId,
  });
  return {
    client,
    key: buildSharedClientKey(params.auth, params.accountId),
    started: false,
    cryptoReady: false,
    startPromise: null,
  };
}

async function ensureSharedClientStarted(params: {
  state: SharedMatrixClientState;
  timeoutMs?: number;
  initialSyncLimit?: number;
  encryption?: boolean;
}): Promise<void> {
  if (params.state.started) {
    return;
  }
  if (params.state.startPromise) {
    await params.state.startPromise;
    return;
  }

  params.state.startPromise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await client.crypto.prepare(joinedRooms);
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start();
    params.state.started = true;
  })();

  try {
    await params.state.startPromise;
  } finally {
    params.state.startPromise = null;
  }
}

export async function resolveSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
  } = {},
): Promise<MatrixClient> {
  const auth =
    params.auth ??
    (await resolveMatrixAuth({
      cfg: params.cfg,
      env: params.env,
      accountId: params.accountId,
    }));
  const key = buildSharedClientKey(auth, params.accountId);
  const shouldStart = params.startClient !== false;

  const existingState = sharedClientStates.get(key);
  if (existingState) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existingState,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return existingState.client;
  }

  const existingPromise = sharedClientPromises.get(key);
  if (existingPromise) {
    const pending = await existingPromise;
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: pending,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return pending.client;
  }

  const creationPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  sharedClientPromises.set(key, creationPromise);

  try {
    const created = await creationPromise;
    sharedClientStates.set(key, created);
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return created.client;
  } finally {
    sharedClientPromises.delete(key);
  }
}

export async function waitForMatrixSync(_params: {
  client: MatrixClient;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  // matrix-js-sdk handles sync lifecycle in start() for this integration.
  // This is kept for API compatibility but is essentially a no-op now
}

export function stopSharedClient(): void {
  for (const state of sharedClientStates.values()) {
    state.client.stop();
  }
  sharedClientStates.clear();
  sharedClientPromises.clear();
}

export function stopSharedClientForAccount(auth: MatrixAuth, accountId?: string | null): void {
  const key = buildSharedClientKey(auth, accountId);
  const state = sharedClientStates.get(key);
  if (!state) {
    return;
  }
  state.client.stop();
  sharedClientStates.delete(key);
  sharedClientPromises.delete(key);
}
