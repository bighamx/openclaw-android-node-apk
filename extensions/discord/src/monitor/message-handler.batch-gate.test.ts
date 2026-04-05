import { describe, expect, it } from "vitest";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";

describe("applyImplicitReplyBatchGate", () => {
  it("leaves context unchanged when replyToMode is not batched", () => {
    const ctx: Record<string, unknown> = {};
    applyImplicitReplyBatchGate(ctx, "first", true);
    expect(ctx.AllowImplicitReplyToCurrentMessage).toBeUndefined();
  });

  it("marks single-message turns as not eligible for implicit reply refs", () => {
    const ctx: Record<string, unknown> = {};
    applyImplicitReplyBatchGate(ctx, "batched", false);
    expect(ctx.AllowImplicitReplyToCurrentMessage).toBe(false);
  });

  it("marks batched turns as eligible for implicit reply refs", () => {
    const ctx: Record<string, unknown> = {};
    applyImplicitReplyBatchGate(ctx, "batched", true);
    expect(ctx.AllowImplicitReplyToCurrentMessage).toBe(true);
  });
});
