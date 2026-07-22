import type {
  SessionAgentResolver,
  SessionCommandAgent,
  SessionRepository,
  TeamMailboxRuntimeEligibility,
  TeamMailboxRuntimeEligibilityPort,
} from "$lib/server/application/ports";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";

function resolveVersionRuntime(agent: SessionCommandAgent): string {
  const configRuntime = (agent.config as { runtime?: unknown }).runtime;
  if (configRuntime === undefined) {
    // Versions published before config.runtime was stamped only have the row value.
    return agent.runtime;
  }
  return typeof configRuntime === "string" ? configRuntime.trim() : "";
}

export class RegistryTeamMailboxRuntimeEligibilityAdapter implements TeamMailboxRuntimeEligibilityPort {
  constructor(
    private readonly deps: {
      sessions: Pick<SessionRepository, "getSession">;
      agents: Pick<SessionAgentResolver, "resolveSessionAgent">;
    },
  ) {}

  async evaluateAgent(input: {
    agentId: string;
    agentVersion?: number | null;
  }): Promise<TeamMailboxRuntimeEligibility> {
    const agent = await this.deps.agents.resolveSessionAgent(input);
    if (!agent) {
      return {
        status: "ineligible",
        reason: "agent_not_found",
        runtimeId: null,
        agentVersion: null,
      };
    }
    const runtimeId = resolveVersionRuntime(agent);
    if (input.agentVersion != null && agent.version !== input.agentVersion) {
      return {
        status: "ineligible",
        reason: "agent_version_mismatch",
        runtimeId,
        agentVersion: agent.version,
      };
    }
    const supported =
      getRuntimeDescriptor(runtimeId)?.capabilities
        .supportsTeamMailboxReceipts === true;
    return supported
      ? {
          status: "eligible",
          runtimeId,
          agentVersion: agent.version,
        }
      : {
          status: "ineligible",
          reason: "runtime_unsupported",
          runtimeId,
          agentVersion: agent.version,
        };
  }

  async evaluateSession(input: {
    sessionId: string;
  }): Promise<TeamMailboxRuntimeEligibility> {
    const session = await this.deps.sessions.getSession(input.sessionId);
    if (!session) {
      return {
        status: "ineligible",
        reason: "session_not_found",
        runtimeId: null,
        agentVersion: null,
      };
    }
    return this.evaluateAgent({
      agentId: session.agentId,
      agentVersion: session.agentVersion,
    });
  }
}
