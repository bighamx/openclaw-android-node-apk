/** Shared legacy-reader grace and inactive update reconciliation threshold. */
export const ABANDONED_UPDATE_RUN_MS = 30 * 60_000;
export const UPDATE_RUN_HEARTBEAT_MS = 30_000;

// Finalization runs several independently bounded Doctor/plugin/service steps.
const FINALIZE_PROCESS_TIMEOUT_FLOOR_MS = 30 * 60_000;
const FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER = 6;

export function resolveUpdateFinalizationTimeoutMs(perStepTimeoutMs?: number): number {
  return Math.max(
    FINALIZE_PROCESS_TIMEOUT_FLOOR_MS,
    (perStepTimeoutMs ?? 0) * FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER,
  );
}
