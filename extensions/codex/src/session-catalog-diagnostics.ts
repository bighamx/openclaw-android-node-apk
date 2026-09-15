import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isMainThread, threadId } from "node:worker_threads";
import {
  areDiagnosticsEnabledForProcess,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";

const log = createSubsystemLogger("gateway/session-catalog");
const listScope = new AsyncLocalStorage<CodexCatalogListDiagnostics | undefined>();
let epoch: string | undefined;
let sequence = 0;
let active = 0;
let windowStart = 0;
let emitted = 0;
let omitted = 0;

type Observation<T> = {
  operationId: string;
  fields: T;
  closed: boolean;
  finish(outcome: "resolved" | "rejected"): void;
};

type ListFields = {
  localHostCount?: number;
  controlPageCalls: number;
  coldStarts: number;
  pendingJoins: number;
  freshHits: number;
  staleHits: number;
  refreshStarts: number;
  managedSnapshotMs?: number;
  controlWaitSumMs?: number;
  exclusionMarkCalls: number;
  exclusionMarkSumMs?: number;
  adoptionCalls: number;
  adoptionSumMs?: number;
  mappingMs?: number;
  nodeRegistryCalls?: number;
  nodeRegistryMs?: number;
  pairedNodeCalls?: number;
  pairedNodeSettled?: number;
  nodeWaitSumMs?: number;
};

type PageFields = {
  origin: "cold" | "refresh" | "uncached";
  listOperationId?: string;
  controlRequestCalls: number;
  inclusiveControlRequestWaitMs?: number;
  inclusiveControlRequestWaitMaxMs?: number;
  postResponseMs?: number;
  provenanceChecks: number;
  provenanceCacheHits: number;
  provenanceReadCalls: number;
  provenanceMs?: number;
  stopReason?: "exhausted" | "limit" | "page-bound";
};

export type CodexCatalogListDiagnostics = Observation<ListFields>;
export type CodexCatalogPageDiagnostics = Observation<PageFields>;

function enabled(): boolean {
  return areDiagnosticsEnabledForProcess() && log.isEnabled("warn");
}

function start<
  T extends
    | ListFields
    | PageFields
    | {
        listOperationId?: string;
        producerOperationId?: string;
        producerObserved: boolean;
      },
>(kind: "list phases" | "page producer" | "cache wait", fields: T): Observation<T> | undefined {
  if (!enabled()) {
    return undefined;
  }
  if (active >= 64) {
    omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
    return undefined;
  }
  active++;
  epoch ??= randomUUID();
  const started = performance.now();
  const observation: Observation<T> = {
    operationId: String(++sequence),
    fields,
    closed: false,
    finish(outcome) {
      if (observation.closed) {
        return;
      }
      observation.closed = true;
      active--;
      const elapsedMs = performance.now() - started;
      try {
        if (elapsedMs < 1_000 || !enabled()) {
          return;
        }
        if (performance.now() - windowStart >= 60_000) {
          windowStart = performance.now();
          emitted = 0;
        }
        if (emitted >= 60) {
          omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
          return;
        }
        const metadata = {
          diagnosticEpoch: epoch,
          operationId: observation.operationId,
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: Math.round(elapsedMs),
          outcome,
          omittedObservations: omitted,
          ...Object.fromEntries(
            Object.entries(fields)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, typeof value === "number" ? Math.round(value) : value]),
          ),
        };
        if (
          Object.keys(metadata).length > 28 ||
          Buffer.byteLength(JSON.stringify(metadata)) > 2_048
        ) {
          omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
          return;
        }
        emitted++;
        log.warn(`slow Codex catalog ${kind}`, metadata);
        omitted = 0;
      } catch {
        // A diagnostic sink must not replace the catalog result or error.
      }
    },
  };
  return observation;
}

export function currentCodexCatalogListDiagnostics(): CodexCatalogListDiagnostics | undefined {
  const observation = listScope.getStore();
  return observation?.closed ? undefined : observation;
}

export function runCodexCatalogListDiagnostics<T>(run: () => Promise<T>): Promise<T> {
  const observation = start<ListFields>("list phases", {
    controlPageCalls: 0,
    coldStarts: 0,
    pendingJoins: 0,
    freshHits: 0,
    staleHits: 0,
    refreshStarts: 0,
    exclusionMarkCalls: 0,
    adoptionCalls: 0,
  });
  if (!observation) {
    return run();
  }
  return listScope.run(observation, async () => {
    let outcome: "resolved" | "rejected" = "rejected";
    try {
      const result = await run();
      outcome = "resolved";
      return result;
    } finally {
      observation.finish(outcome);
    }
  });
}

export function startCodexCatalogPageDiagnostics(origin: PageFields["origin"]) {
  return start<PageFields>("page producer", {
    origin,
    listOperationId: currentCodexCatalogListDiagnostics()?.operationId,
    controlRequestCalls: 0,
    provenanceChecks: 0,
    provenanceCacheHits: 0,
    provenanceReadCalls: 0,
  } satisfies PageFields);
}

export function waitForCodexCatalogPage<T>(
  page: Promise<T>,
  producerOperationId?: string,
): Promise<T> {
  const observation = start("cache wait", {
    listOperationId: currentCodexCatalogListDiagnostics()?.operationId,
    producerOperationId,
    producerObserved: producerOperationId !== undefined,
  });
  if (!observation) {
    return page;
  }
  return (async () => {
    let outcome: "resolved" | "rejected" = "rejected";
    try {
      const result = await page;
      outcome = "resolved";
      return result;
    } finally {
      observation.finish(outcome);
    }
  })();
}
