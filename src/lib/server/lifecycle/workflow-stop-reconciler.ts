import type { DurableStopMode } from "./resolvers";

export type WorkflowStopReconcileCandidate = {
  id: string;
  mode: DurableStopMode;
};

export type WorkflowStopReconcilerDeps = {
  listCandidates(input: {
    limit: number;
  }): Promise<WorkflowStopReconcileCandidate[]>;
  redriveStop(id: string, mode: DurableStopMode): Promise<void>;
};

export type WorkflowStopReconcileResult = {
  scanned: number;
  redriven: string[];
  failed: Array<{ id: string; error: string }>;
  dryRun: boolean;
};

/**
 * Re-drive persisted workflow stop intents oldest-first. The database adapter
 * supplies only nonterminal rows, so successful lifecycle finalization removes
 * a candidate from the next tick without a second acknowledgement column.
 */
export async function reconcileWorkflowStops(
  deps: WorkflowStopReconcilerDeps,
  opts: { dryRun: boolean; limit: number; maxActionsPerRun: number },
): Promise<WorkflowStopReconcileResult> {
  const candidates = await deps.listCandidates({ limit: opts.limit });
  const redriven: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  if (!opts.dryRun) {
    for (const candidate of candidates.slice(0, opts.maxActionsPerRun)) {
      try {
        await deps.redriveStop(candidate.id, candidate.mode);
        redriven.push(candidate.id);
      } catch (error) {
        failed.push({
          id: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { scanned: candidates.length, redriven, failed, dryRun: opts.dryRun };
}
