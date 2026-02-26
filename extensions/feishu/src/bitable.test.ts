import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";

function createApi(config: unknown) {
  const registerTool = vi.fn();
  const api: Partial<OpenClawPluginApi> = {
    config: config as OpenClawPluginApi["config"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool,
  };
  return { api: api as OpenClawPluginApi, registerTool };
}

describe("registerFeishuBitableTools", () => {
  it("registers bitable tools when credentials are configured via accounts.*", () => {
    const { api, registerTool } = createApi({
      channels: {
        feishu: {
          accounts: {
            main: {
              enabled: true,
              appId: "cli_main",
              appSecret: "secret_main",
            },
          },
        },
      },
    });

    registerFeishuBitableTools(api);

    expect(registerTool).toHaveBeenCalled();
    const names = registerTool.mock.calls.map((call) => call[0]?.name);
    expect(names).toContain("feishu_bitable_get_meta");
    expect(names).toContain("feishu_bitable_create_record");
  });

  it("keeps legacy top-level credential registration working", () => {
    const { api, registerTool } = createApi({
      channels: {
        feishu: {
          appId: "cli_legacy",
          appSecret: "legacy_secret",
        },
      },
    });

    registerFeishuBitableTools(api);

    expect(registerTool).toHaveBeenCalled();
  });
});
