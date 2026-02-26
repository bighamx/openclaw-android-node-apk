import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { migrateMatrixLegacyCredentialsToDefaultAccount } from "./config-migration.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix directory", () => {
  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };

  beforeEach(() => {
    setMatrixRuntime({
      state: {
        resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
      },
    } as PluginRuntime);
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        "matrix-js": {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.directory).toBeTruthy();
    expect(matrixPlugin.directory?.listPeers).toBeTruthy();
    expect(matrixPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      matrixPlugin.directory!.listPeers!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:@alice:example.org" },
        { kind: "user", id: "bob", name: "incomplete id; expected @user:server" },
        { kind: "user", id: "user:@carol:example.org" },
        { kind: "user", id: "user:@dana:example.org" },
      ]),
    );

    await expect(
      matrixPlugin.directory!.listGroups!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });

  it("resolves replyToMode from account config", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          replyToMode: "off",
          accounts: {
            Assistant: {
              replyToMode: "all",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.threading?.resolveReplyToMode).toBeTruthy();
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "assistant",
        chatType: "direct",
      }),
    ).toBe("all");
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "default",
        chatType: "direct",
      }),
    ).toBe("off");
  });

  it("resolves group mention policy from account config", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          groups: {
            "!room:example.org": { requireMention: true },
          },
          accounts: {
            Assistant: {
              groups: {
                "!room:example.org": { requireMention: false },
              },
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.groups!.resolveRequireMention!({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "!room:example.org",
      }),
    ).toBe(false);
  });

  it("writes matrix-js non-default account credentials under channels.matrix-js.accounts", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          homeserver: "https://default.example.org",
          accessToken: "default-token",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix-js"]?.accessToken).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.accounts?.default).toMatchObject({
      accessToken: "default-token",
      homeserver: "https://default.example.org",
    });
    expect(updated.channels?.["matrix-js"]?.accounts?.ops).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
  });

  it("writes default matrix-js account credentials under channels.matrix-js.accounts.default", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "bot-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix-js"]?.homeserver).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.accounts?.default).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "bot-token",
    });
  });

  it("migrates legacy top-level matrix-js credentials into accounts.default", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          name: "pinguini",
          homeserver: "https://legacy.example.org",
          userId: "@legacy:example.org",
          accessToken: "legacy-token",
          deviceName: "Legacy Device",
          encryption: true,
          groupPolicy: "allowlist",
          groups: {
            "!legacy-room:example.org": { allow: true },
          },
          register: false,
        },
      },
    } as unknown as CoreConfig;

    const updated = migrateMatrixLegacyCredentialsToDefaultAccount(cfg);
    expect(updated.channels?.["matrix-js"]?.homeserver).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.accessToken).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.deviceName).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.encryption).toBeUndefined();
    expect((updated.channels?.["matrix-js"] as Record<string, unknown>)?.register).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.accounts?.default).toMatchObject({
      name: "pinguini",
      homeserver: "https://legacy.example.org",
      userId: "@legacy:example.org",
      accessToken: "legacy-token",
      deviceName: "Legacy Device",
      encryption: true,
      groupPolicy: "allowlist",
      groups: {
        "!legacy-room:example.org": { allow: true },
      },
    });
  });

  it("merges top-level object defaults into accounts.default during migration", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          dm: {
            policy: "allowlist",
            allowFrom: ["@legacy:example.org"],
          },
          accounts: {
            default: {
              dm: {
                policy: "pairing",
              },
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = migrateMatrixLegacyCredentialsToDefaultAccount(cfg);
    expect(updated.channels?.["matrix-js"]?.dm).toBeUndefined();
    expect(updated.channels?.["matrix-js"]?.accounts?.default?.dm).toMatchObject({
      policy: "pairing",
      allowFrom: ["@legacy:example.org"],
    });
  });

  it("requires account-scoped env vars when --use-env is set for non-default accounts", () => {
    const envKeys = [
      "MATRIX_OPS_HOMESERVER",
      "MATRIX_OPS_USER_ID",
      "MATRIX_OPS_ACCESS_TOKEN",
      "MATRIX_OPS_PASSWORD",
    ] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    for (const key of envKeys) {
      delete process.env[key];
    }
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        cfg: {} as CoreConfig,
        accountId: "ops",
        input: { useEnv: true },
      });
      expect(error).toBe(
        'Set per-account env vars for "ops" (for example MATRIX_OPS_HOMESERVER + MATRIX_OPS_ACCESS_TOKEN or MATRIX_OPS_USER_ID + MATRIX_OPS_PASSWORD).',
      );
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
    }
  });

  it("accepts --use-env for non-default account when scoped env vars are present", () => {
    const envKeys = {
      MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
      MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
    };
    process.env.MATRIX_OPS_HOMESERVER = "https://ops.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-token";
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        cfg: {} as CoreConfig,
        accountId: "ops",
        input: { useEnv: true },
      });
      expect(error).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(envKeys)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("resolves account id from input name when explicit account id is missing", () => {
    const accountId = matrixPlugin.setup!.resolveAccountId?.({
      cfg: {} as CoreConfig,
      accountId: undefined,
      input: { name: "Main Bot" },
    });
    expect(accountId).toBe("main-bot");
  });

  it("resolves binding account id from agent id when omitted", () => {
    const accountId = matrixPlugin.setup!.resolveBindingAccountId?.({
      cfg: {} as CoreConfig,
      agentId: "Ops",
      accountId: undefined,
    });
    expect(accountId).toBe("ops");
  });

  it("clears stale access token when switching an account to password auth", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              accessToken: "old-token",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "new-password",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix-js"]?.accounts?.default?.password).toBe("new-password");
    expect(updated.channels?.["matrix-js"]?.accounts?.default?.accessToken).toBeUndefined();
  });

  it("clears stale password when switching an account to token auth", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              password: "old-password",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "new-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix-js"]?.accounts?.default?.accessToken).toBe("new-token");
    expect(updated.channels?.["matrix-js"]?.accounts?.default?.password).toBeUndefined();
  });
});
