import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "./types.js";

type LegacyAccountField =
  | "name"
  | "homeserver"
  | "userId"
  | "accessToken"
  | "password"
  | "deviceId"
  | "deviceName"
  | "initialSyncLimit"
  | "encryption"
  | "allowlistOnly"
  | "groupPolicy"
  | "groupAllowFrom"
  | "replyToMode"
  | "threadReplies"
  | "textChunkLimit"
  | "chunkMode"
  | "responsePrefix"
  | "mediaMaxMb"
  | "autoJoin"
  | "autoJoinAllowlist"
  | "dm"
  | "groups"
  | "rooms"
  | "actions";

const LEGACY_ACCOUNT_FIELDS: ReadonlyArray<LegacyAccountField> = [
  "name",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
  "initialSyncLimit",
  "encryption",
  "allowlistOnly",
  "groupPolicy",
  "groupAllowFrom",
  "replyToMode",
  "threadReplies",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "mediaMaxMb",
  "autoJoin",
  "autoJoinAllowlist",
  "dm",
  "groups",
  "rooms",
  "actions",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeLegacyFieldIntoDefault(
  current: MatrixAccountConfig[LegacyAccountField] | undefined,
  legacy: MatrixAccountConfig[LegacyAccountField],
): MatrixAccountConfig[LegacyAccountField] {
  if (current === undefined) {
    return legacy;
  }
  if (isRecord(current) && isRecord(legacy)) {
    return {
      ...legacy,
      ...current,
    } as MatrixAccountConfig[LegacyAccountField];
  }
  return current;
}

function clearLegacyOnlyFields(nextMatrix: MatrixConfig): void {
  // Legacy matrix-bot-sdk onboarding toggle; not used by matrix-js config.
  delete (nextMatrix as Record<string, unknown>).register;
}

export function migrateMatrixLegacyCredentialsToDefaultAccount(cfg: CoreConfig): CoreConfig {
  const matrix = cfg.channels?.["matrix-js"];
  if (!matrix) {
    return cfg;
  }

  const defaultAccount = {
    ...(matrix.accounts?.[DEFAULT_ACCOUNT_ID] ?? {}),
  } as MatrixAccountConfig;
  let changed = false;

  for (const field of LEGACY_ACCOUNT_FIELDS) {
    const legacyValue = matrix[field] as MatrixAccountConfig[LegacyAccountField] | undefined;
    if (legacyValue === undefined) {
      continue;
    }
    (
      defaultAccount as Record<
        LegacyAccountField,
        MatrixAccountConfig[LegacyAccountField] | undefined
      >
    )[field] = mergeLegacyFieldIntoDefault(defaultAccount[field], legacyValue);
    changed = true;
  }

  const registerPresent = (matrix as Record<string, unknown>).register !== undefined;
  if (registerPresent) {
    changed = true;
  }

  if (!changed) {
    return cfg;
  }

  const nextMatrix = { ...matrix } as MatrixConfig;
  for (const field of LEGACY_ACCOUNT_FIELDS) {
    delete nextMatrix[field];
  }
  clearLegacyOnlyFields(nextMatrix);
  nextMatrix.accounts = {
    ...matrix.accounts,
    [DEFAULT_ACCOUNT_ID]: defaultAccount,
  };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "matrix-js": nextMatrix,
    },
  };
}
