import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";

const {
  collectChannelSecurityFindingsMock,
  collectEnabledInsecureOrDangerousFlagsMock,
  listReadOnlyChannelPluginsForConfigMock,
  hasConfiguredChannelsForReadOnlyScopeMock,
} = vi.hoisted(() => ({
  collectChannelSecurityFindingsMock: vi.fn(async () => [
    {
      checkId: "channels.telegram.setup_fallback_audited",
      severity: "warn",
      title: "Telegram setup fallback audited",
    },
  ]),
  collectEnabledInsecureOrDangerousFlagsMock: vi.fn((_config: OpenClawConfig): string[] => []),
  listReadOnlyChannelPluginsForConfigMock: vi.fn(),
  hasConfiguredChannelsForReadOnlyScopeMock: vi.fn(),
}));

vi.mock("./dangerous-config-flags.js", () => ({
  collectEnabledInsecureOrDangerousFlags: (config: OpenClawConfig) =>
    collectEnabledInsecureOrDangerousFlagsMock(config),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: (...args: unknown[]) =>
    (listReadOnlyChannelPluginsForConfigMock as (...params: unknown[]) => unknown)(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: (...args: unknown[]) =>
    (hasConfiguredChannelsForReadOnlyScopeMock as (...params: unknown[]) => unknown)(...args),
  resolveConfiguredChannelPluginIds: () => [],
}));

vi.mock("./audit-channel.collect.runtime.js", () => ({
  collectChannelSecurityFindings: (...args: unknown[]) =>
    (collectChannelSecurityFindingsMock as (...params: unknown[]) => unknown)(...args),
}));

const collectNoFindings = vi.hoisted(() => vi.fn(() => []));
vi.mock("./audit.nondeep.runtime.js", () => ({
  collectAttackSurfaceSummaryFindings: collectNoFindings,
  collectExposureMatrixFindings: collectNoFindings,
  collectGatewayHttpNoAuthFindings: collectNoFindings,
  collectGatewayHttpSessionKeyOverrideFindings: collectNoFindings,
  collectHooksHardeningFindings: collectNoFindings,
  collectLikelyMultiUserSetupFindings: collectNoFindings,
  collectMinimalProfileOverrideFindings: collectNoFindings,
  collectModelHygieneFindings: collectNoFindings,
  collectNodeDangerousAllowCommandFindings: collectNoFindings,
  collectNodeDenyCommandPatternFindings: collectNoFindings,
  collectSandboxDangerousConfigFindings: collectNoFindings,
  collectSandboxDockerNoopFindings: collectNoFindings,
  collectSecretsInConfigFindings: collectNoFindings,
  collectSmallModelRiskFindings: collectNoFindings,
  collectSyncedFolderFindings: collectNoFindings,
  readConfigSnapshotForAudit: vi.fn(async () => null),
}));

const { runSecurityAudit } = await import("./audit.js");

describe("security audit channel read-only setup fallback", () => {
  it("passes setup fallback plugins to channel security collection", async () => {
    const plugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Test",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => ({ enabled: true, configured: true }),
        resolveAccount: () => ({}),
        isEnabled: () => true,
        isConfigured: () => true,
      },
      security: {
        resolveDmPolicy: () => ({
          policy: "open",
          allowFrom: ["*"],
          policyPath: "channels.telegram.dmPolicy",
          allowFromPath: "channels.telegram.",
          approveHint: "approve",
        }),
      },
    } satisfies ChannelPlugin;
    const cfg = {
      session: { dmScope: "main" },
      channels: { telegram: { enabled: true } },
    } satisfies OpenClawConfig;

    hasConfiguredChannelsForReadOnlyScopeMock.mockReturnValue(true);
    listReadOnlyChannelPluginsForConfigMock.mockReturnValue([plugin]);

    const report = await runSecurityAudit({
      config: cfg,
      sourceConfig: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });

    expect(listReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        includePersistedAuthState: true,
        includeSetupFallbackPlugins: true,
      }),
    );
    expect(collectChannelSecurityFindingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        sourceConfig: cfg,
        plugins: [plugin],
      }),
    );
    expect(report.findings.map((finding) => finding.checkId)).toContain(
      "channels.telegram.setup_fallback_audited",
    );
  });
});
