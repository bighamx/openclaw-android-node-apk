import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import remend from "remend";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { isActiveTask, sortTasks, taskTimestampMs } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";

const SUBAGENT_ACTIVITY_LIMIT = 5;
const SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS = 60_000;

export type SubagentActivityPresentation = {
  rows: TaskSummary[];
  overflowWorking: number;
  taskIds: ReadonlySet<string>;
  nextExpiryAt: number | null;
};

export function deriveSubagentActivity(params: {
  tasks: readonly TaskSummary[];
  sessionKey: string;
  terminalObservedAtByTask: ReadonlyMap<string, number>;
  canonicalizeSessionKey: (sessionKey: string | undefined) => string;
  now?: number;
}): SubagentActivityPresentation {
  const now = params.now ?? Date.now();
  const requesterSessionKey = params.canonicalizeSessionKey(params.sessionKey);
  const matching = sortTasks(
    params.tasks.filter((task) => {
      const taskRequesterSessionKey = params.canonicalizeSessionKey(task.sessionKey);
      return (
        task.runtime === "subagent" &&
        Boolean(requesterSessionKey) &&
        taskRequesterSessionKey === requesterSessionKey
      );
    }),
  );
  const active = matching.filter(isActiveTask);
  const recentTerminal: TaskSummary[] = [];
  let nextExpiryAt: number | null = null;
  for (const task of matching) {
    if (isActiveTask(task)) {
      continue;
    }
    const terminalAt =
      params.terminalObservedAtByTask.get(task.id) ??
      taskTimestampMs(task.endedAt ?? task.updatedAt);
    const expiresAt = terminalAt + SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS;
    if (terminalAt <= 0 || expiresAt <= now) {
      continue;
    }
    recentTerminal.push(task);
    nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
  }
  // Active children stay visible ahead of retained completions so a burst of
  // terminal events cannot displace work that is still progressing.
  const eligible = [...active, ...recentTerminal];
  const rows = eligible.slice(0, SUBAGENT_ACTIVITY_LIMIT);
  const overflowWorking = eligible
    .slice(SUBAGENT_ACTIVITY_LIMIT)
    .filter((task) => task.status === "running").length;
  return {
    rows,
    overflowWorking,
    taskIds: new Set(eligible.map((task) => task.id)),
    nextExpiryAt,
  };
}

function subagentStatusDescription(task: TaskSummary): string {
  const keys = {
    queued: "chat.backgroundTasks.subagentActivity.queuedDescription",
    running: "chat.backgroundTasks.subagentActivity.runningDescription",
    completed: "chat.backgroundTasks.subagentActivity.completedDescription",
    failed: "chat.backgroundTasks.subagentActivity.failedDescription",
    cancelled: "chat.backgroundTasks.subagentActivity.cancelledDescription",
    timed_out: "chat.backgroundTasks.subagentActivity.timedOutDescription",
  } as const;
  return t(keys[task.status]);
}

function subagentActivitySnippet(task: TaskSummary): string | undefined {
  if (!isActiveTask(task) && task.terminalSummary?.trim()) {
    return task.terminalSummary.trim();
  }
  return (
    task.lastActivity?.trim() ||
    task.progressSummary?.trim() ||
    task.lastToolName?.trim() ||
    undefined
  );
}

function renderSubagentActivityIndicator(task: TaskSummary): TemplateResult {
  return html`<span
    class="chat-subagent-activity__indicator chat-subagent-activity__indicator--${task.status}"
    aria-hidden="true"
  >
    <span
      class="chat-subagent-activity__claw ${task.status === "running" ? "chat-reading-indicator" : ""}"
      >${icons.claw}</span
    >
    ${
      task.status === "failed" || task.status === "timed_out"
        ? html`<span class="chat-subagent-activity__badge"
            >${task.status === "failed" ? icons.alertTriangle : icons.clock}</span
          >`
        : nothing
    }
  </span>`;
}

function renderSubagentActivityRow(
  task: TaskSummary,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult {
  const rawSnippet = subagentActivitySnippet(task);
  // Previews can end mid-emphasis. Repair delimiters without adding escapes
  // intended for a Markdown renderer; the row and tooltip stay plain text.
  const snippet = rawSnippet
    ? flattenMarkdownToPlainText(
        remend(rawSnippet, {
          katex: false,
          links: false,
          images: false,
          comparisonOperators: false,
          singleTilde: false,
          setextHeadings: false,
          htmlTags: false,
        }),
      )
    : undefined;
  const title = task.title?.trim();
  const label = title || t("chat.backgroundTasks.subagentActivity.untitled");
  const statusDescription = subagentStatusDescription(task);
  const content = html`
    ${renderSubagentActivityIndicator(task)}
    <span class="chat-subagent-activity__label">${label}</span>
    ${keyed(
      `${task.status}:${snippet ?? ""}`,
      html`<span class="chat-subagent-activity__snippet chat-subagent-activity__snippet--updated"
        >${snippet ?? ""}</span
      >`,
    )}
  `;
  const row = !onOpenTaskDetail
    ? html`<div
        class="chat-subagent-activity__row"
        data-subagent-task-id=${task.id}
        role="status"
        aria-live="off"
        aria-label=${`${label}. ${statusDescription}`}
      >
        ${content}
      </div>`
    : html`<button
        class="chat-subagent-activity__row chat-subagent-activity__row--interactive"
        data-subagent-task-id=${task.id}
        type="button"
        aria-label=${`${t("chat.backgroundTasks.subagentActivity.openDetails", { title: label })}. ${statusDescription}`}
        @click=${() => onOpenTaskDetail(task)}
      >
        ${content}
      </button>`;
  return html`<openclaw-tooltip
    class="chat-subagent-activity__tooltip"
    .content=${[label, statusDescription, snippet].filter(Boolean).join("\n")}
    .describe=${false}
    >${row}</openclaw-tooltip
  >`;
}

export function renderSubagentActivity(
  presentation: SubagentActivityPresentation,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult | typeof nothing {
  if (presentation.rows.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-subagent-activity"
      aria-label=${t("chat.backgroundTasks.subagentActivity.label")}
    >
      ${repeat(
        presentation.rows,
        (task) => task.id,
        (task) => renderSubagentActivityRow(task, onOpenTaskDetail),
      )}
      ${
        presentation.overflowWorking > 0
          ? html`<div class="chat-subagent-activity__overflow">
              ${t("chat.backgroundTasks.subagentActivity.moreWorking", {
                count: String(presentation.overflowWorking),
              })}
            </div>`
          : nothing
      }
    </div>
  `;
}
