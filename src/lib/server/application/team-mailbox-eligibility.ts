import type { TeamMailboxRuntimeEligibilityPort } from "$lib/server/application/ports";

export type TeamMailboxEligibilityResult =
  | { status: "ok"; runtimeId: string; agentVersion: number }
  | { status: "error"; httpStatus: number; message: string };

/**
 * Application gate for every participant that can receive durable team events.
 * Callers must pass this check before creating team state or dispatching a
 * teammate runtime.
 */
export class ApplicationTeamMailboxEligibilityService {
  constructor(
    private readonly eligibility: TeamMailboxRuntimeEligibilityPort,
  ) {}

  async checkAgent(input: {
    agentId: string;
    agentVersion?: number | null;
  }): Promise<TeamMailboxEligibilityResult> {
    try {
      const result = await this.eligibility.evaluateAgent(input);
      if (result.status === "eligible") {
        return {
          status: "ok",
          runtimeId: result.runtimeId,
          agentVersion: result.agentVersion,
        };
      }
      if (result.reason === "agent_not_found") {
        return {
          status: "error",
          httpStatus: 404,
          message: `agent '${input.agentId}' could not be resolved for team delivery`,
        };
      }
      if (result.reason === "agent_version_mismatch") {
        return {
          status: "error",
          httpStatus: 409,
          message: `agent '${input.agentId}' changed version while team eligibility was being checked`,
        };
      }
      return unsupportedRuntime(result.runtimeId, "agent", 400);
    } catch {
      return eligibilityUnavailable();
    }
  }

  async checkSession(input: {
    sessionId: string;
  }): Promise<TeamMailboxEligibilityResult> {
    try {
      const result = await this.eligibility.evaluateSession(input);
      if (result.status === "eligible") {
        return {
          status: "ok",
          runtimeId: result.runtimeId,
          agentVersion: result.agentVersion,
        };
      }
      if (result.reason === "session_not_found") {
        return {
          status: "error",
          httpStatus: 404,
          message: `session '${input.sessionId}' could not be resolved for team delivery`,
        };
      }
      if (result.reason === "agent_not_found") {
        return {
          status: "error",
          httpStatus: 409,
          message: `session '${input.sessionId}' has no resolvable agent for team delivery`,
        };
      }
      if (result.reason === "agent_version_mismatch") {
        return {
          status: "error",
          httpStatus: 409,
          message: `session '${input.sessionId}' no longer resolves its pinned agent version`,
        };
      }
      return unsupportedRuntime(result.runtimeId, "session", 409);
    } catch {
      return eligibilityUnavailable();
    }
  }

  async checkParticipants(input: {
    leadSessionId: string;
    memberAgentId: string;
    memberAgentVersion?: number | null;
  }): Promise<TeamMailboxEligibilityResult> {
    const lead = await this.checkSession({ sessionId: input.leadSessionId });
    if (lead.status === "error") return lead;
    return this.checkAgent({
      agentId: input.memberAgentId,
      agentVersion: input.memberAgentVersion,
    });
  }
}

function unsupportedRuntime(
  runtimeId: string | null,
  subject: "agent" | "session",
  httpStatus: number,
): TeamMailboxEligibilityResult {
  const runtime = runtimeId?.trim() || "unknown";
  return {
    status: "error",
    httpStatus,
    message: `${subject} runtime '${runtime}' does not support durable team mailbox receipts`,
  };
}

function eligibilityUnavailable(): TeamMailboxEligibilityResult {
  return {
    status: "error",
    httpStatus: 503,
    message: "team mailbox runtime eligibility could not be verified",
  };
}
