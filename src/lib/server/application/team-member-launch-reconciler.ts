import type {
  SessionLifecycleController,
  StaleTeamMemberLaunch,
  TeamStore,
} from "$lib/server/application/ports";

export type TeamMemberLaunchReconcileDecision = {
  memberId: string;
  sessionId: string;
  operationId: string;
  kind: "spawn" | "revival";
  action:
    | "dry_run"
    | "promoted"
    | "pending"
    | "cleanup_completed"
    | "cleanup_pending"
    | "stale"
    | "failed"
    | "capped";
  executed: boolean;
  error?: string;
};

export type TeamMemberLaunchReconcileRunResult = {
  scanned: number;
  actionsTaken: number;
  dryRun: boolean;
  decisions: TeamMemberLaunchReconcileDecision[];
};

export type TeamMemberLaunchReconcilerDeps = {
  teams: Pick<
    TeamStore,
    | "listStaleMemberLaunches"
    | "reconcileStaleMemberLaunch"
    | "completeMemberLaunchCleanup"
  >;
  lifecycle: Pick<SessionLifecycleController, "stopSession">;
  now: () => number;
};

export type TeamMemberLaunchReconcileOptions = {
  dryRun: boolean;
  limit: number;
  maxActionsPerRun: number;
  staleSeconds: number;
};

/**
 * Repairs the database-to-Dapr teammate launch handoff after a process crash.
 * The store owns the atomic proof/cleanup fence; this application service owns
 * lifecycle compensation and never removes a reservation before purge is
 * confirmed (or the child is already absent).
 */
export async function reconcileTeamMemberLaunches(
  deps: TeamMemberLaunchReconcilerDeps,
  opts: TeamMemberLaunchReconcileOptions,
): Promise<TeamMemberLaunchReconcileRunResult> {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit || 20), 200));
  const maxActions = Math.max(
    1,
    Math.min(Math.trunc(opts.maxActionsPerRun || 10), 200),
  );
  const staleBefore = new Date(
    deps.now() - Math.max(30, opts.staleSeconds) * 1_000,
  );
  const candidates = await deps.teams.listStaleMemberLaunches({
    staleBefore,
    limit,
  });
  const decisions: TeamMemberLaunchReconcileDecision[] = [];
  let actionsTaken = 0;

  for (const candidate of candidates) {
    const base = decisionBase(candidate);
    if (opts.dryRun) {
      decisions.push({ ...base, action: "dry_run", executed: false });
      continue;
    }
    if (actionsTaken >= maxActions) {
      decisions.push({ ...base, action: "capped", executed: false });
      continue;
    }

    let actionCounted = false;
    try {
      const resolution = await deps.teams.reconcileStaleMemberLaunch(candidate);
      if (resolution.status === "promoted") {
        actionsTaken++;
        actionCounted = true;
        decisions.push({ ...base, action: "promoted", executed: true });
        continue;
      }
      if (resolution.status === "pending") {
        decisions.push({ ...base, action: "pending", executed: false });
        continue;
      }
      if (resolution.status === "stale") {
        decisions.push({ ...base, action: "stale", executed: false });
        continue;
      }

      // `cleanup` is a durable, exact operation fence. A crash from here is
      // harmless: the next sweep re-drives the persisted purge/unwind action
      // before restoring/deleting the member reservation.
      actionsTaken++;
      actionCounted = true;
      if (resolution.action === "purge") {
        const stopped = await deps.lifecycle.stopSession(candidate.sessionId, {
          mode: "purge",
          reason: `Stale teammate ${candidate.kind} launch ${candidate.operationId}`,
          graceMs: 0,
        });
        if (!stopped.confirmed && !stopped.notFound) {
          decisions.push({
            ...base,
            action: "cleanup_pending",
            executed: true,
          });
          continue;
        }
      }
      const completed = await deps.teams.completeMemberLaunchCleanup({
        memberId: candidate.memberId,
        sessionId: candidate.sessionId,
        operationId: candidate.operationId,
      });
      decisions.push({
        ...base,
        action: completed ? "cleanup_completed" : "stale",
        executed: completed,
      });
    } catch (error) {
      if (!actionCounted) actionsTaken++;
      decisions.push({
        ...base,
        action: "failed",
        executed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: candidates.length,
    actionsTaken,
    dryRun: opts.dryRun,
    decisions,
  };
}

function decisionBase(candidate: StaleTeamMemberLaunch) {
  return {
    memberId: candidate.memberId,
    sessionId: candidate.sessionId,
    operationId: candidate.operationId,
    kind: candidate.kind,
  };
}
