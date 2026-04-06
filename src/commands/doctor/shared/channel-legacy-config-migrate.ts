import type { OpenClawConfig } from "../../../config/types.js";
import { applyPluginDoctorCompatibilityMigrations } from "../../../plugins/doctor-contract-registry.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectRelevantDoctorChannelIds(raw: unknown): string[] {
  const channels = asRecord(asRecord(raw)?.channels);
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .toSorted();
}

export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  const compat = applyPluginDoctorCompatibilityMigrations(cfg as OpenClawConfig, {
    pluginIds: collectRelevantDoctorChannelIds(cfg),
  });
  return {
    next: compat.config as OpenClawConfig & Record<string, unknown>,
    changes: compat.changes,
  };
}
