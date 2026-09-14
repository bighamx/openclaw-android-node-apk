import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { slackPlugin } from "../extensions/slack/api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "../src/gateway/server-methods/agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

const endpointPreparation = vi.hoisted(() => ({
  beforeLookup: undefined as (() => void) | undefined,
}));
vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) => {
      endpointPreparation.beforeLookup?.();
      return actual.lookup(...args);
    },
  };
});

function createOriginatingRun(channel: string, mode: string) {
  const sessionKey = `agent:main:${channel}:channel:origin`;
  const operationalRunInstance = createOperationalRunInstanceRef(`read-${channel}-${mode}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const toolContext = {
    currentChannelProvider: channel,
    currentChannelId: channel === "discord" ? current : "C9876543210",
    currentChatType: "channel" as const,
  };
  const turnCapability = mintMessageActionTurnCapability({
    agentId: "main",
    runId: operationalRunInstance.runId,
    sessionKey,
    requesterAccountId: "default",
    requesterSenderId: "synthetic-requester",
    toolContext,
  });
  const runGuard = createAgentRuntimeAuthorityGuard(
    {
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          delegatedAuthority: { kind: "local", ...delegatedAuthority },
          messageActionContext: { expiresAtMs: Date.now() + 60_000, turnCapability },
        },
      },
    } as GatewayClient,
    {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext,
    () => {},
  ).commitGuard;
  if (!runGuard) {
    throw new Error("Expected originating run authority");
  }
  runGuard();
  return {
    wrapTool: (tool: ReturnType<typeof createMessageTool>) =>
      wrapToolWithGatewayCallerIdentity(tool, {
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(delegatedAuthority),
      }),
    toolOptions: {
      agentId: "main",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId: operationalRunInstance.runId,
      messageActionTurnCapability: turnCapability,
      ...toolContext,
    },
    assert: runGuard,
    revoke: () =>
      mode.includes("claim")
        ? releaseAgentRunDelegatedAuthority(delegatedAuthority)
        : revokeMessageActionTurnCapability(turnCapability),
    dispose: () => {
      revokeMessageActionTurnCapability(turnCapability);
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

const guild = "100000000000000001";
const parent = "100000000000000002";
const current = "100000000000000003";
const sibling = "100000000000000004";
const slackTarget = "C0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  endpointPreparation.beforeLookup = undefined;
});

// Registrar trust is a fixture here; installer/loader provenance has separate coverage.
// Responses and the terminal request log come from a real loopback HTTP server.
describe.each(["discord", "slack"] as const)("official %s provider read boundary", (channel) => {
  const modes = [
    "allowed",
    "denied",
    "account",
    "revoked",
    "result-revoked",
    "legacy",
    "run-revoked-direct",
    "run-result-revoked-direct",
    "bundled-allowed",
    "bundled-revoked",
    "bundled-run-revoked-direct",
    "bundled-run-result-revoked-direct",
  ] as const;
  const cases =
    channel === "discord"
      ? [
          ...modes,
          "endpoint-allowed" as const,
          "endpoint-lookup-revoked" as const,
          "endpoint-content-lookup-revoked" as const,
        ]
      : [
          ...modes,
          "tool-allowed" as const,
          "tool-run-preparation-revoked" as const,
          "tool-run-revoked" as const,
          "tool-run-claim-revoked" as const,
          "tool-run-result-revoked" as const,
          "tool-run-retry-revoked" as const,
          "bundled-tool-allowed" as const,
          "bundled-tool-run-claim-revoked" as const,
        ];
  it.each(cases)("routes a cross-conversation read through the provider (%s)", async (mode) => {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const bundledRegistration = mode.startsWith("bundled-");
    const record = createPluginRecord({
      id: channel,
      origin: bundledRegistration ? "bundled" : "global",
      trustedOfficialInstall: !bundledRegistration,
    });
    const provider = channel === "discord" ? discordPlugin : slackPlugin;
    const plugin = {
      ...provider,
      // Status probes have provider-specific generics and are not part of message dispatch.
      status: undefined,
      actions: {
        ...provider.actions!,
        readAuthorityActions:
          mode === "legacy" ? undefined : provider.actions?.readAuthorityActions,
      },
    };
    owner.registry.plugins.push(record);
    owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
    setActivePluginRegistry(owner.registry);
    const usesMessageTool = mode.includes("tool-");
    const runRevocation = mode.includes("run-");
    const resultRevocation = mode.includes("result");
    const run = runRevocation || usesMessageTool ? createOriginatingRun(channel, mode) : undefined;
    const requests: string[] = [];
    const isContent = (url: string) =>
      url.includes("/messages") || url.includes("conversations.history");
    const server = createServer((request, response) => {
      const url = request.url!;
      requests.push(url);
      request.resume();
      let body: unknown;
      if (isContent(url)) {
        if (mode === "result-revoked") {
          record.enabled = false;
        }
        if (runRevocation && resultRevocation) {
          run?.revoke();
        }
        body = channel === "discord" ? [] : { ok: true, messages: [], has_more: false };
      } else {
        if (runRevocation && !resultRevocation) {
          run?.revoke();
        }
        if (mode === "revoked" || mode === "bundled-revoked") {
          record.enabled = false;
        }
        if (channel === "slack" && url.startsWith("/api/conversations.info")) {
          body = {
            ok: true,
            channel: {
              id: slackTarget,
              name: mode === "denied" ? "forbidden" : "allowed",
              is_channel: true,
            },
          };
        } else if (url.endsWith(`/channels/${sibling}`)) {
          body = { id: sibling, type: 11, parent_id: parent, guild_id: guild, name: "sibling" };
        } else if (url.endsWith(`/channels/${parent}`)) {
          body = { id: parent, type: 0, guild_id: guild, name: "discussion" };
        } else {
          response.writeHead(404);
          response.end();
          return;
        }
      }
      const retryMetadata =
        mode === "tool-run-retry-revoked" && !isContent(url) && requests.length === 1;
      response.writeHead(retryMetadata ? 429 : 200, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let endpointLookups = 0;
    if (mode.startsWith("endpoint-")) {
      vi.stubEnv("DISCORD_API_URL", `${baseUrl}/api/v10`);
      endpointPreparation.beforeLookup = () => {
        endpointLookups += 1;
        if (
          mode === "endpoint-lookup-revoked" ||
          (mode === "endpoint-content-lookup-revoked" &&
            requests.some((url) => url.endsWith(`/channels/${parent}`)))
        ) {
          record.enabled = false;
        }
      };
    }
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // No synthetic credential can escape to a real provider.
      if (channel === "discord") {
        if (url.origin === baseUrl) {
          return realFetch(input, init);
        }
        expect(url.origin).toBe("https://discord.com");
        expect(url.pathname).toMatch(/^\/api\/v10\//);
        return realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
      }
      expect(url.origin).toBe(baseUrl);
      return realFetch(input, init);
    });
    vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
    for (const key of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      vi.stubEnv(key, undefined);
    }
    try {
      const actionContext: ChannelMessageActionContext = {
        cfg: {
          channels: {
            discord: {
              enabled: true,
              token: "synthetic-provider-fixture",
              groupPolicy: "allowlist",
              guilds: { [guild]: { channels: { [parent]: { enabled: mode !== "denied" } } } },
            },
            slack: {
              enabled: true,
              botToken: "synthetic-provider-fixture",
              groupPolicy: "allowlist",
              dangerouslyAllowNameMatching: true,
              channels: { "#allowed": { enabled: true } },
            },
          },
        },
        channel,
        action: "read" as const,
        params: { channelId: channel === "discord" ? sibling : slackTarget, limit: 1 },
        accountId: "default",
        requesterAccountId: mode === "account" ? "other" : "default",
        conversationReadOrigin: "delegated" as const,
        assertDirectAdapterHandoff: run?.assert,
        toolContext: {
          currentChannelProvider: channel,
          currentChannelId: channel === "discord" ? current : "C9876543210",
        },
      };
      if (usesMessageTool) {
        setRuntimeConfigSnapshot(actionContext.cfg, actionContext.cfg);
      }
      const messageTool = usesMessageTool
        ? run!.wrapTool(
            createMessageTool({
              ...run!.toolOptions,
              config: actionContext.cfg,
              getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
              resolveCommandSecretRefsViaGateway: async ({ config }) => {
                if (mode === "tool-run-preparation-revoked") {
                  run!.revoke();
                }
                return {
                  resolvedConfig: config,
                  diagnostics: [],
                  targetStatesByPath: {},
                  hadUnresolvedTargets: false,
                };
              },
            }),
          )
        : undefined;
      const invocation = messageTool
        ? messageTool.execute("read-context", {
            action: "read",
            channel,
            target: `channel:${slackTarget}`,
            limit: 1,
          })
        : dispatchChannelMessageAction(actionContext);
      if (mode.endsWith("allowed")) {
        expect(await invocation).not.toBeNull();
        expect(requests.filter(isContent)).toHaveLength(1);
      } else {
        const outcome = await invocation.then(
          () => ({ rejected: false, message: "" }),
          (error: unknown) => ({
            rejected: true,
            message: error instanceof Error ? error.message : "non-Error rejection",
          }),
        );
        expect(outcome.rejected).toBe(true);
        expect(outcome.message).toContain(
          mode === "legacy"
            ? "exact current conversation"
            : mode === "account"
              ? "current provider and account"
              : mode === "denied"
                ? "not allowed"
                : "no longer active",
        );
        expect(requests.filter(isContent)).toHaveLength(
          mode === "result-revoked" || (runRevocation && resultRevocation) ? 1 : 0,
        );
        if (mode === "legacy" || mode === "account" || mode === "tool-run-preparation-revoked") {
          expect(requests).toEqual([]);
        }
        if (
          mode === "revoked" ||
          mode === "bundled-revoked" ||
          mode === "tool-run-revoked" ||
          mode === "tool-run-claim-revoked" ||
          mode === "bundled-tool-run-claim-revoked" ||
          mode === "tool-run-retry-revoked"
        ) {
          expect(requests).toHaveLength(1);
        }
        if (mode === "endpoint-lookup-revoked") {
          expect(endpointLookups).toBeGreaterThan(0);
          expect(requests).toEqual([]);
        }
        if (mode === "endpoint-content-lookup-revoked") {
          expect(endpointLookups).toBeGreaterThan(1);
          expect(requests.filter(isContent)).toEqual([]);
        }
      }
    } finally {
      run?.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
