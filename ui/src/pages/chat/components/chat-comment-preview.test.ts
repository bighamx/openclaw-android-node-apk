/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { parseCommentAttachment } from "./chat-comment-preview.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";

describe("sent comment attachment presentation", () => {
  it.each([
    ["Review the deployment checklist.", ""],
    [
      "🦞 Keep spacing\n\nUser comment:\n  in the selected text.",
      "Another\n\nSource session: literal heading\n\nUser comment:\ninside the comment.",
    ],
  ])(
    "recovers the original selection and optional comment without interpreting their headings",
    (text, comment) => {
      const attachment = createChatSelectionAttachment({
        text,
        comment,
        sessionKey: "agent:main:main",
        start: 7,
        end: 7 + text.length,
      })!;
      try {
        const payload = getChatAttachmentDataUrl(attachment)!;
        expect(
          parseCommentAttachment(Buffer.from(payload.split(",")[1]!, "base64").toString("utf8")),
        ).toEqual({ text, comment });
      } finally {
        releaseChatAttachmentPayload(attachment.id);
      }
    },
  );

  it.each([
    "An ordinary text file.",
    "Selected text:\nvalue\n\nUser comment:\nno provenance",
    "Selected text:\nvalue\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 100)",
  ])("preserves malformed or lookalike text files as attachments", (value) => {
    expect(parseCommentAttachment(value)).toBeNull();
  });
});
