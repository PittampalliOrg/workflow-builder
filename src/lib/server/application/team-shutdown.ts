import type {
  SessionLifecycleController,
  SessionLifecycleStopResult,
  TeamStore,
} from "$lib/server/application/ports";

export type TeamShutdownResult =
  | {
      status: "confirmed";
      name: string;
      stop: SessionLifecycleStopResult;
    }
  | {
      status: "confirmed";
      name: string;
      terminalEvidence: "member_already_terminal";
    }
  | {
      status: "stopping";
      name: string;
      stop: SessionLifecycleStopResult;
    }
  | {
      status: "not_found";
      message: string;
      stop?: SessionLifecycleStopResult;
    }
  | { status: "unavailable"; message: string }
  | { status: "invalid"; message: string };

/**
 * Stops one teammate without claiming the member is terminal before the durable
 * runtime confirms it. Persistence and lifecycle effects stay behind ports so
 * the HTTP route only translates the typed outcome.
 */
export class ApplicationTeamShutdownService {
  constructor(
    private readonly deps: {
      teams: Pick<TeamStore, "getMemberByName" | "finalizeMemberShutdown">;
      lifecycle: Pick<SessionLifecycleController, "stopSession">;
    },
  ) {}

  async shutdownMember(input: {
    teamId: string;
    name: string;
  }): Promise<TeamShutdownResult> {
    const member = await this.deps.teams.getMemberByName(
      input.teamId,
      input.name,
    );
    if (!member) {
      return {
        status: "not_found",
        message: `no teammate '${input.name}' in this team`,
      };
    }
    if (member.role === "lead") {
      return { status: "invalid", message: "cannot shut down the team lead" };
    }

    const stop = await this.deps.lifecycle.stopSession(member.session_id, {
      mode: "purge",
      reason: "team shutdown",
    });
    if (stop.notFound || stop.state === "notFound") {
      // Whole-team shutdown is replayed idempotently. A terminal member may have
      // already had its session row purged by the first pass; absence then confirms
      // the requested end state. For an active member it remains a hard mismatch.
      if (member.status === "shutdown" || member.status === "failed") {
        return {
          status: "confirmed",
          name: member.name,
          terminalEvidence: "member_already_terminal",
        };
      }
      return {
        status: "not_found",
        message: `durable run for teammate '${member.name}' was not found`,
        stop,
      };
    }
    if (stop.retryable && stop.requested === false) {
      return {
        status: "unavailable",
        message: `stop intent for teammate '${member.name}' could not be persisted`,
      };
    }

    // Require both signals. A malformed or partial adapter result must fail
    // closed and leave the member non-terminal for the next confirmation pass.
    if (stop.confirmed !== true || stop.state !== "confirmed") {
      return { status: "stopping", name: member.name, stop };
    }

    const finalized = await this.deps.teams.finalizeMemberShutdown({
      memberId: member.id,
      sessionId: member.session_id,
    });
    // The member may have been revived onto a new session while the old durable
    // run was stopping. Do not report the current teammate as shut down; the
    // caller retries, resolves the new session, and stops that exact run.
    if (finalized === "stale") {
      return { status: "stopping", name: member.name, stop };
    }
    return { status: "confirmed", name: member.name, stop };
  }
}
