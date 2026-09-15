import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { releaseDisplacedChatAttachmentPayloads } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { chatCommentLineEnd, resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";
import { showChatAnnotationEditor } from "./chat-selection-popup.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();
type CommentAttachment = ChatAttachment & { selectionAnnotation: ChatSelectionAnnotation };

/** Draft attachments own the data; this transcript-local view owns source pins. */
class ChatCommentPins extends OpenClawLightDomElement {
  @property({ attribute: false }) props!: ChatAttachmentControlsProps;
  @property() sessionKey = "";
  private root: HTMLElement | null = null;
  private resizeObserver?: ResizeObserver;
  private mutationObserver?: MutationObserver;
  private frame?: number;
  private editorOwner?: AbortController;
  private editingId?: string;
  private observedInner?: Element;
  private focusCommentId?: string;
  private positionEditor?: () => void;
  private actionRoot: Element | null = null;

  private currentAttachments() {
    return this.props.getAttachments?.() ?? this.props.attachments ?? [];
  }

  private comments(): CommentAttachment[] {
    return this.currentAttachments().filter((item): item is CommentAttachment =>
      Boolean(
        item.selectionAnnotation &&
        areUiSessionKeysEquivalent(item.selectionAnnotation.sessionKey, this.sessionKey),
      ),
    );
  }

  private readonly retireEditor = () => {
    this.editorOwner?.abort();
    this.editorOwner = undefined;
    this.editingId = undefined;
    this.positionEditor = undefined;
  };

  protected override willUpdate(changed: PropertyValues<this>) {
    const previous = changed.get("props");
    if (changed.has("props") && previous?.readSignal !== this.props.readSignal) {
      previous?.readSignal?.removeEventListener("abort", this.retireEditor);
      this.props.readSignal?.addEventListener("abort", this.retireEditor, { once: true });
      this.retireEditor();
    }
    if (
      changed.has("sessionKey") ||
      this.props.disabled ||
      (this.editingId && !this.comments().some((item) => item.id === this.editingId))
    ) {
      this.retireEditor();
    }
  }

  protected override updated() {
    if (!this.actionRoot) {
      this.actionRoot = this.closest(".card.chat");
      this.actionRoot?.addEventListener("openclaw-comment-action", this.handleCommentAction);
    }
    if (!this.root) {
      this.root = this.closest(".chat-thread");
      if (this.root) {
        this.resizeObserver = new ResizeObserver(this.scheduleLayout);
        this.resizeObserver.observe(this.root);
        this.mutationObserver = new MutationObserver((records) => {
          if (records.some((record) => !this.contains(record.target))) {
            this.scheduleLayout();
          }
        });
        this.mutationObserver.observe(this.root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        this.root.addEventListener("scroll", this.scheduleLayout, { passive: true });
      }
    }
    this.scheduleLayout();
  }

  override disconnectedCallback() {
    this.actionRoot?.removeEventListener("openclaw-comment-action", this.handleCommentAction);
    this.actionRoot = null;
    this.retireEditor();
    this.props.readSignal?.removeEventListener("abort", this.retireEditor);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.root?.removeEventListener("scroll", this.scheduleLayout);
    this.root = null;
    this.observedInner = undefined;
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    super.disconnectedCallback();
  }

  private readonly scheduleLayout = () => {
    if (this.frame !== undefined || !this.isConnected) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.layoutPins();
    });
  };

  private layoutPins() {
    if (!this.root) {
      return;
    }
    const inner = this.root.querySelector(".chat-thread-inner");
    if (inner && inner !== this.observedInner) {
      if (this.observedInner) {
        this.resizeObserver?.unobserve(this.observedInner);
      }
      this.resizeObserver?.observe(inner);
      this.observedInner = inner;
    }
    const origin = this.getBoundingClientRect();
    const edge = this.root.getBoundingClientRect().right - 28;
    const occupied: Array<{ left: number; top: number }> = [];
    for (const attachment of this.comments()) {
      const pin = Array.from(this.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.dataset.attachmentId === attachment.id,
      );
      if (!pin) {
        continue;
      }
      const anchor = resolveChatCommentAnchor(this.root, attachment.selectionAnnotation);
      const line = anchor && chatCommentLineEnd(anchor);
      pin.hidden = !line;
      if (!line) {
        if (this.editingId === attachment.id) {
          this.retireEditor();
        }
        continue;
      }
      let left = Math.min(line.right + 4, edge) - origin.left;
      let top = line.top + (line.height - 24) / 2 - origin.top;
      while (
        occupied.some((item) => Math.abs(item.left - left) < 24 && Math.abs(item.top - top) < 24)
      ) {
        if (left + 48 <= edge - origin.left) {
          left += 24;
        } else {
          top += 24;
        }
      }
      occupied.push({ left, top });
      pin.style.left = `${left}px`;
      pin.style.top = `${top}px`;
      if (attachment.id === this.focusCommentId) {
        pin.focus({ preventScroll: true });
        this.focusCommentId = undefined;
      }
    }
    this.positionEditor?.();
  }

  private canChange(signal: AbortSignal | undefined) {
    return (
      this.isConnected &&
      !this.props.disabled &&
      !signal?.aborted &&
      this.props.readSignal === signal &&
      Boolean(this.props.onAttachmentsChange)
    );
  }

  private changeAttachments(current: ChatAttachment[], next: ChatAttachment[]) {
    this.props.onAttachmentsChange?.(next);
    releaseDisplacedChatAttachmentPayloads(current, [next]);
    this.props.onRequestUpdate?.();
  }

  private readonly handleCommentAction = (event: Event) => {
    if (!(event instanceof CustomEvent) || !this.canChange(this.props.readSignal)) {
      return;
    }
    const attachment = this.comments().find((item) => item.id === event.detail?.id);
    if (!attachment) {
      return;
    }
    event.stopPropagation();
    if (event.detail.action === "delete") {
      this.deleteComment(attachment.id);
    } else if (event.detail.action === "edit" && event.target instanceof HTMLElement) {
      const pin = Array.from(this.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.dataset.attachmentId === attachment.id && !item.hidden,
      );
      pin?.scrollIntoView({ block: "nearest" });
      this.editComment(attachment, pin ?? event.target);
    }
  };

  private deleteComment(id: string) {
    const current = this.currentAttachments();
    this.changeAttachments(
      current,
      current.filter((item) => item.id !== id),
    );
    this.closest(".card.chat")
      ?.querySelector<HTMLElement>(".agent-chat__composer-combobox > textarea")
      ?.focus({ preventScroll: true });
  }

  private editComment(attachment: CommentAttachment, pin: HTMLElement) {
    const signal = this.props.readSignal;
    if (!this.canChange(signal)) {
      return;
    }
    this.retireEditor();
    this.editorOwner = new AbortController();
    this.editingId = attachment.id;
    this.positionEditor = showChatAnnotationEditor({
      anchorRect: pin.getBoundingClientRect(),
      anchorElement: pin,
      sourceRange: this.root
        ? resolveChatCommentAnchor(this.root, attachment.selectionAnnotation)?.range
        : undefined,
      comment: attachment.selectionAnnotation.comment,
      expanded: true,
      readSignal: this.editorOwner.signal,
      onSave: (comment) => {
        if (!this.canChange(signal)) {
          return true;
        }
        const current = this.currentAttachments();
        const selected = current.find((item) => item.id === attachment.id);
        if (!selected?.selectionAnnotation) {
          return true;
        }
        const replacement = createChatSelectionAttachment(
          { ...selected.selectionAnnotation, comment },
          this.props.attachmentLimits,
        );
        if (!replacement) {
          return false;
        }
        this.focusCommentId = replacement.id;
        this.changeAttachments(
          current,
          current.map((item) => (item.id === attachment.id ? replacement : item)),
        );
        return true;
      },
      onDelete: () => {
        if (this.canChange(signal)) {
          this.deleteComment(attachment.id);
        }
      },
      onCancel: () => pin.focus({ preventScroll: true }),
    });
  }

  protected override render() {
    return repeat(
      this.comments(),
      (item) => item.id,
      (attachment, index) => html` <button
        type="button"
        class="btn primary chat-comment-pin"
        data-attachment-id=${attachment.id}
        aria-label=${t("chat.messages.editAnnotation", { number: String(index + 1) })}
        title=${attachment.selectionAnnotation.comment || attachment.selectionAnnotation.text}
        ?disabled=${this.props.disabled || this.props.readSignal?.aborted}
        @pointerup=${(event: PointerEvent) => event.stopPropagation()}
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          if (event.currentTarget instanceof HTMLElement) {
            this.editComment(attachment, event.currentTarget);
          }
        }}
      >
        ${icons.messageSquare}
      </button>`,
    );
  }
}

customElements.define("openclaw-chat-comment-pins", ChatCommentPins);
