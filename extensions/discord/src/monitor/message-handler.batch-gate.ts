import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";

export function applyImplicitReplyBatchGate(
  ctx: Record<string, unknown>,
  replyToMode: ReplyToMode,
  isBatched: boolean,
) {
  if (replyToMode !== "batched") {
    return;
  }
  ctx.AllowImplicitReplyToCurrentMessage = isBatched;
}
