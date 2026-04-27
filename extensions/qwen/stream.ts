import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === "modelstudio" ||
    normalized === "qwencloud" ||
    normalized === "dashscope"
  );
}

function resolveOpenAICompatibleThinkingEnabled(params: {
  thinkingLevel: QwenThinkingLevel;
  options: Parameters<StreamFn>[2];
}): boolean {
  const options = (params.options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw = options.reasoningEffort ?? options.reasoning ?? params.thinkingLevel ?? "high";
  if (typeof raw !== "string") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "off" && normalized !== "none";
}

export function createQwenThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: QwenThinkingLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions" || !model.reasoning) {
      return underlying(model, context, options);
    }
    const enableThinking = resolveOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.enable_thinking = enableThinking;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    });
  };
}

export function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isQwenProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  return createQwenThinkingWrapper(ctx.streamFn, ctx.thinkingLevel);
}
