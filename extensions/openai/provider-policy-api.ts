import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-entry";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}
