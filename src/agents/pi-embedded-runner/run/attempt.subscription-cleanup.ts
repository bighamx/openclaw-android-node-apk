import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";

export function buildEmbeddedSubscriptionParams(
  params: SubscribeEmbeddedPiSessionParams,
): SubscribeEmbeddedPiSessionParams {
  return params;
}

export async function cleanupEmbeddedAttemptResources(params: {
  removeToolResultContextGuard?: () => void;
  flushPendingToolResultsAfterIdle: (params: {
    agent: unknown;
    sessionManager: unknown;
    clearPendingOnTimeout: boolean;
  }) => Promise<void>;
  session?: { agent?: unknown; dispose(): void };
  sessionManager: unknown;
  releaseWsSession: (sessionId: string) => void;
  sessionId: string;
  bundleLspRuntime?: { dispose(): Promise<void> | void };
  sessionLock: { release(): Promise<void> | void };
}): Promise<void> {
  try {
    try {
      params.removeToolResultContextGuard?.();
    } catch {
      /* best-effort */
    }
    try {
      await params.flushPendingToolResultsAfterIdle({
        agent: params.session?.agent,
        sessionManager: params.sessionManager,
        clearPendingOnTimeout: true,
      });
    } catch {
      /* best-effort */
    }
    try {
      params.session?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      params.releaseWsSession(params.sessionId);
    } catch {
      /* best-effort */
    }
    try {
      await params.bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    }
  } finally {
    await params.sessionLock.release();
  }
}
