import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type VllmQwenThinkingFormat = "chat-template" | "top-level";

function isVllmProviderId(providerId: string): boolean {
  return normalizeProviderId(providerId) === "vllm";
}

function normalizeQwenThinkingFormat(value: unknown): VllmQwenThinkingFormat | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "chat-template" ||
    normalized === "chat-template-kwargs" ||
    normalized === "chat-template-kwarg" ||
    normalized === "chat-template-arguments"
  ) {
    return "chat-template";
  }
  if (
    normalized === "top-level" ||
    normalized === "enable-thinking" ||
    normalized === "request-body"
  ) {
    return "top-level";
  }
  return undefined;
}

function resolveVllmQwenThinkingFormat(
  extraParams: ProviderWrapStreamFnContext["extraParams"],
): VllmQwenThinkingFormat | undefined {
  return normalizeQwenThinkingFormat(
    extraParams?.qwenThinkingFormat ?? extraParams?.qwen_thinking_format,
  );
}

function resolveOpenAICompatibleThinkingEnabled(params: {
  thinkingLevel: VllmThinkingLevel;
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

function setQwenChatTemplateThinking(payload: Record<string, unknown>, enabled: boolean): void {
  const existing = payload.chat_template_kwargs;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const next: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
      enable_thinking: enabled,
    };
    if (!Object.hasOwn(next, "preserve_thinking")) {
      next.preserve_thinking = true;
    }
    payload.chat_template_kwargs = next;
    return;
  }
  payload.chat_template_kwargs = {
    enable_thinking: enabled,
    preserve_thinking: true,
  };
}

export function createVllmQwenThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  format: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  const underlying = params.baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions" || !model.reasoning) {
      return underlying(model, context, options);
    }
    const enableThinking = resolveOpenAICompatibleThinkingEnabled({
      thinkingLevel: params.thinkingLevel,
      options,
    });
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (params.format === "chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
      } else {
        payloadObj.enable_thinking = enableThinking;
      }
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    });
  };
}

export function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isVllmProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const format = resolveVllmQwenThinkingFormat(ctx.extraParams);
  if (!format) {
    return undefined;
  }
  return createVllmQwenThinkingWrapper({
    baseStreamFn: ctx.streamFn,
    format,
    thinkingLevel: ctx.thinkingLevel,
  });
}
