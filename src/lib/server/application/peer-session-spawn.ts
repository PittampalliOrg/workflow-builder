import type {
	PeerAgentDispatchContext,
	PeerSessionRecord,
	SandboxProvisioner,
	SessionRepository,
	SessionWorkflowSpawner,
	WorkflowDataService,
} from "$lib/server/application/ports";
import type {
  WorkflowMcpSessionCapabilities,
  WorkflowMcpSessionTokenSigner,
} from "$lib/server/application/ports/workflow-mcp-auth";

export type PeerSessionSpawnPrincipal = {
  userId: string;
  projectId: string;
  sessionId: string;
  capabilities: WorkflowMcpSessionCapabilities;
};

export type PeerSessionSpawnPolicy =
  | { kind: "call_agent" }
  | { kind: "team"; teamId: string };

export type PeerSessionSpawnResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

export class ApplicationPeerSessionSpawnService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
        | "ensurePeerSession"
        | "resolvePeerAgentDispatchContext"
        | "getSessionDetail"
        | "getSessionFileOwner"
			>;
			workflowSpawner: SessionWorkflowSpawner;
      workflowMcpSessionTokens: WorkflowMcpSessionTokenSigner;
			sandboxProvisioner: SandboxProvisioner;
			sessions: Pick<
				SessionRepository,
				"attachWorkspaceSandbox" | "recordSandboxProvisioningError"
			>;
		},
	) {}

  async spawnPeerSession(
    body: unknown,
    principal: PeerSessionSpawnPrincipal,
    policy: PeerSessionSpawnPolicy,
  ): Promise<PeerSessionSpawnResult> {
		const request = parsePeerSpawnRequest(body);
		if (!request.sessionId) return peerSpawnError(400, "sessionId is required");
    if (!request.peerAgentId)
      return peerSpawnError(400, "peerAgentId is required");
		if (request.sessionId.length > 64) {
			return peerSpawnError(
				400,
				"sessionId must be ≤64 chars (Dapr workflow cap)",
			);
		}
    if (
      !request.parentSessionId ||
      request.parentSessionId !== principal.sessionId
    ) {
      return peerSpawnError(
        403,
        "Peer spawn lineage must match the signed parent session",
      );
    }
    const [parentOwner, parentSession] = await Promise.all([
      this.deps.workflowData.getSessionFileOwner(request.parentSessionId),
      this.deps.workflowData.getSessionDetail({
        sessionId: request.parentSessionId,
      }),
    ]);
    if (
      !parentOwner ||
      !parentSession ||
      parentOwner.userId !== principal.userId ||
      parentOwner.projectId !== principal.projectId
    ) {
      return peerSpawnError(
        403,
        "Peer spawn parent is outside the signed workspace",
      );
    }
    if (policy.kind === "call_agent") {
      const parentDispatch =
        await this.deps.workflowData.resolvePeerAgentDispatchContext({
          agentId: parentSession.agentId,
          agentVersion: parentSession.agentVersion,
        });
      if (
        !parentDispatch?.callableAgents.some(
          (agent) => agent.agentId === request.peerAgentId,
        )
      ) {
        return peerSpawnError(
          403,
          "Peer agent is not in the parent session's callable allowlist",
        );
      }
    } else if (
      principal.capabilities.teamId !== policy.teamId ||
      principal.capabilities.teamRole !== "lead"
    ) {
      return peerSpawnError(403, "Peer spawn requires the signed team lead");
    }

		const ensureResult = await this.deps.workflowData.ensurePeerSession({
			sessionId: request.sessionId,
			peerAgentId: request.peerAgentId,
			prompt: request.prompt,
			parentSessionId: request.parentSessionId,
      // The signed parent session is server-authoritative lineage. A runtime's
      // nested Dapr instance id is caller-controlled and must not become the
      // durable parent pointer.
      parentInstanceId: null,
			title: request.title,
		});
		if (!ensureResult.ok) {
			return peerSpawnError(ensureResult.status, ensureResult.message);
		}

		const session = ensureResult.session;
    const expectedParent = request.parentSessionId ?? null;
    if (
      ensureResult.reused &&
      (session.agentId !== request.peerAgentId ||
        session.parentExecutionId !== expectedParent)
    ) {
      return peerSpawnError(
        409,
        "Existing peer session does not match the requested agent and lineage",
      );
    }
    const childOwner = await this.deps.workflowData.getSessionFileOwner(
      session.id,
    );
    if (
      !childOwner ||
      childOwner.userId !== principal.userId ||
      childOwner.projectId !== principal.projectId
    ) {
      return peerSpawnError(
        403,
        "Peer session is outside the signed workspace",
      );
    }
    const workflowMcpCapabilities: WorkflowMcpSessionCapabilities = {
      scriptDepth: principal.capabilities.scriptDepth,
      teamId: policy.kind === "team" ? policy.teamId : null,
      teamRole: policy.kind === "team" ? "member" : "none",
    };
    const workflowMcpSessionToken = this.deps.workflowMcpSessionTokens.sign({
      userId: principal.userId,
      projectId: principal.projectId,
      sessionId: session.id,
      capabilities: workflowMcpCapabilities,
    });
		const base = baseResponse(session, ensureResult.reused);
		if (ensureResult.reused && !request.skipSpawnOnReplay) {
      return {
        status: "ok",
        body: { ...base, workflowMcpSessionToken },
      };
		}

		if (request.skipSpawn) {
			const dispatch =
				await this.deps.workflowData.resolvePeerAgentDispatchContext({
					agentId: session.agentId,
					agentVersion: session.agentVersion,
					environmentId: session.environmentId,
					environmentVersion: session.environmentVersion,
				});
			if (!dispatch) {
        return peerSpawnError(
          500,
          `could not re-resolve peer ${session.agentId}`,
        );
			}
			return {
				status: "ok",
        body: {
          ...skipSpawnResponse(base, session, dispatch),
          workflowMcpSessionToken,
        },
			};
		}

		// Optional per-peer OpenShell workspace sandbox (opt-in): mirrors
		// maybeProvisionSandbox on the interactive-session path. Without it the
		// child's payload carries sandboxName:null and every filesystem/bash tool
		// fails with "OpenShell sandboxName is required". Team teammates opt in
		// (they do real file work); plain CallAgent delegation stays lean by
		// default. Provision + attach happen BEFORE spawnSessionWorkflow so the
		// dispatch payload (which re-reads the session row) picks the name up.
		// provisionSessionSandbox is idempotent per executionId, so Dapr replay
		// re-invocations are safe. Failure degrades (log + record) rather than
		// blocking the spawn — same posture as the interactive path.
		let sandboxName: string | null = null;
		if (request.provisionSandbox) {
			try {
				const sandbox = await this.deps.sandboxProvisioner.provision({
					executionId: session.id,
					name: request.title ?? `peer-${session.id.slice(0, 8)}`,
					sandboxTemplate: request.sandboxTemplate ?? "base",
					keepAfterRun: true,
				});
				await this.deps.sessions.attachWorkspaceSandbox({
					sessionId: session.id,
					workspaceSandboxName: sandbox.sandboxName,
				});
				sandboxName = sandbox.sandboxName;
			} catch (sandboxErr) {
				console.error("[peer-spawn] sandbox provisioning failed:", sandboxErr);
				try {
					await this.deps.sessions.recordSandboxProvisioningError({
						sessionId: session.id,
						errorMessage:
							sandboxErr instanceof Error
								? sandboxErr.message
								: "sandbox provisioning failed",
					});
				} catch (persistErr) {
					console.error(
						"[peer-spawn] failed to persist sandbox provisioning error:",
						persistErr,
					);
				}
			}
		}

		try {
			const { instanceId, natsSubject } =
        await this.deps.workflowSpawner.spawnSessionWorkflow(session.id, {
          workflowMcpCapabilities,
        });
			return {
				status: "ok",
				body: {
					sessionId: session.id,
					agentId: session.agentId,
					agentVersion: session.agentVersion,
					daprInstanceId: instanceId,
					natsSubject,
					sandboxName,
          workflowMcpSessionToken,
					reused: false,
				},
			};
		} catch (spawnErr) {
			return {
				status: "ok",
				httpStatus: 202,
				body: {
					sessionId: session.id,
					agentId: session.agentId,
					agentVersion: session.agentVersion,
					daprInstanceId: null,
					natsSubject: null,
          workflowMcpSessionToken,
					reused: false,
					error:
						spawnErr instanceof Error
							? spawnErr.message
							: "Workflow spawn failed",
				},
			};
		}
	}
}

function parsePeerSpawnRequest(body: unknown) {
	const value = isRecord(body) ? body : {};
	const sessionId =
		typeof value.sessionId === "string" && value.sessionId.trim()
			? value.sessionId.trim()
			: null;
	const peerAgentId =
		typeof value.peerAgentId === "string" ? value.peerAgentId.trim() : "";
	const prompt = typeof value.prompt === "string" ? value.prompt : "";
	const parentSessionId =
		typeof value.parentSessionId === "string" ? value.parentSessionId : null;
	const parentInstanceId =
		typeof value.parentInstanceId === "string" ? value.parentInstanceId : null;
	const title =
		typeof value.title === "string" && value.title.trim()
			? value.title.trim()
			: null;
	const skipSpawn = value.skipSpawn === true;
	const provisionSandbox = value.provisionSandbox === true;
	const sandboxTemplate =
		typeof value.sandboxTemplate === "string" && value.sandboxTemplate.trim()
			? value.sandboxTemplate.trim()
			: null;
	return {
		sessionId,
		peerAgentId,
		prompt,
		parentSessionId,
		parentInstanceId,
		title,
		skipSpawn,
		skipSpawnOnReplay: skipSpawn,
		provisionSandbox,
		sandboxTemplate,
	};
}

function baseResponse(session: PeerSessionRecord, reused: boolean) {
	return {
		sessionId: session.id,
		agentId: session.agentId,
		agentVersion: session.agentVersion,
		daprInstanceId: session.daprInstanceId,
		natsSubject: session.natsSubject,
		reused,
	};
}

function skipSpawnResponse(
	base: ReturnType<typeof baseResponse>,
	session: PeerSessionRecord,
	dispatch: PeerAgentDispatchContext,
) {
	return {
		...base,
		agentConfig: dispatch.agentConfig,
		environmentConfig: dispatch.environmentConfig,
		vaultIds: session.vaultIds,
		callableAgents: dispatch.callableAgents,
		registryTeam: dispatch.registryTeam,
		skipSpawn: true,
	};
}

function peerSpawnError(
	httpStatus: number,
	message: string,
): PeerSessionSpawnResult {
	return { status: "error", httpStatus, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
