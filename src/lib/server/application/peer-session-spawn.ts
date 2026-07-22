import type {
	PeerAgentDispatchContext,
	PeerSessionRecord,
  RuntimeProvisioningLease,
	SandboxProvisioner,
	SessionRepository,
  SessionSandboxDestroyer,
	SessionWorkflowSpawner,
	WorkflowDataService,
} from "$lib/server/application/ports";
import type {
  WorkflowMcpSessionCapabilities,
  WorkflowMcpSessionTokenSigner,
} from "$lib/server/application/ports/workflow-mcp-auth";
import type { ApplicationTeamMailboxDeliveryService } from "$lib/server/application/team-mailbox-delivery";

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
      status: "pending";
      httpStatus: 202;
      code: "runtime_provisioning";
      message: string;
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
        | "attachWorkspaceSandbox"
        | "attachSessionRuntime"
        | "acknowledgeRuntimeProvisioningCompensation"
        | "recordSandboxProvisioningError"
      >;
      sandboxDestroyer: SessionSandboxDestroyer;
      teamMailboxDelivery: Pick<
        ApplicationTeamMailboxDeliveryService,
        "requestDeliveryAfterRuntimePublished"
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
    if (policy.kind === "team" && request.peerAgentVersion == null) {
      return peerSpawnError(
        400,
        "peerAgentVersion is required for team peer spawn",
      );
    }
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
    if (
      parentOwner.stopRequestedAt != null ||
      parentOwner.completedAt != null ||
      parentOwner.status === "terminated"
    ) {
      return peerSpawnError(409, "Peer spawn parent is stopping or terminal");
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
      ...(policy.kind === "team"
        ? { peerAgentVersion: request.peerAgentVersion }
        : {}),
			prompt: request.prompt,
      workflowExecutionId: parentSession.workflowExecutionId,
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
        (policy.kind === "team" &&
          session.agentVersion !== request.peerAgentVersion) ||
        session.parentExecutionId !== expectedParent ||
        session.workflowExecutionId !== parentSession.workflowExecutionId)
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
    if (ensureResult.reused && !isActivePeerSession(session)) {
      return peerSpawnError(
        409,
        `Session ${session.id} is stopping or terminal`,
      );
    }
    if (
      ensureResult.reused &&
      !request.skipSpawnOnReplay &&
      hasPositiveDispatchEvidence(session)
    ) {
      await this.requestPendingTeamMailboxDelivery(session.id);
      return {
        status: "ok",
        body: { ...base, workflowMcpSessionToken },
      };
		}

    let nativeDispatch: PeerAgentDispatchContext | null = null;
    let nativeRuntimeAppId: string | null = null;
		if (request.skipSpawn) {
      nativeDispatch =
				await this.deps.workflowData.resolvePeerAgentDispatchContext({
					agentId: session.agentId,
					agentVersion: session.agentVersion,
					environmentId: session.environmentId,
					environmentVersion: session.environmentVersion,
				});
      if (!nativeDispatch) {
        return peerSpawnError(
          500,
          `could not re-resolve peer ${session.agentId}`,
        );
			}
      nativeRuntimeAppId = parentSession.runtimeAppId?.trim() || null;
      if (!nativeRuntimeAppId) {
        return peerSpawnError(
          409,
          "Peer spawn parent has no lifecycle-managed runtime target",
        );
      }
      if (
        ensureResult.reused &&
        request.skipSpawnOnReplay &&
        hasPositiveDispatchEvidence(session)
      ) {
        if (session.runtimeAppId?.trim() !== nativeRuntimeAppId) {
          return peerSpawnError(
            409,
            "Published native peer runtime does not match the parent runtime target",
          );
        }
        await this.requestPendingTeamMailboxDelivery(session.id);
        return {
          status: "ok",
          body: {
            ...skipSpawnResponse(
              base,
              session,
              nativeDispatch,
              nativeRuntimeAppId,
            ),
            workflowMcpSessionToken,
          },
        };
      }
    }

    const provisioningLease =
      await this.deps.workflowSpawner.reserveSessionWorkflow(session.id);
    if (!provisioningLease) {
      // A reused, active, unpublished child may already have an exact
      // provisioning owner. That is not a definitive rejection: callers must
      // preserve their durable intent until the owner publishes or lifecycle
      // state makes a later retry deterministically fail.
      if (
        ensureResult.reused &&
        isActivePeerSession(session) &&
        !hasPositiveDispatchEvidence(session)
      ) {
        return peerSpawnPending(session.id);
      }
      return peerSpawnError(
        409,
        `Session ${session.id} is stopping or terminal`,
      );
    }

    if (request.skipSpawn) {
      let attached: boolean;
      try {
        attached = await this.deps.sessions.attachSessionRuntime({
          sessionId: session.id,
          expectedStartedAt: provisioningLease.startedAt,
          daprInstanceId: session.id,
          natsSubject: `session.events.${session.id}`,
          runtimeAppId: nativeRuntimeAppId,
          runtimeSandboxName: parentSession.runtimeSandboxName ?? null,
          runtimeHostOwned: false,
        });
      } catch (attachErr) {
        await this.releaseUnpublishedRuntimeLease(
          session.id,
          provisioningLease,
        );
        return peerSpawnError(
          500,
          attachErr instanceof Error
            ? attachErr.message
            : "native runtime attachment failed",
        );
      }
      if (!attached) {
        await this.releaseUnpublishedRuntimeLease(
          session.id,
          provisioningLease,
        );
        return peerSpawnError(
          409,
          `Session ${session.id} stopped before native peer dispatch`,
        );
      }
      await this.requestPendingTeamMailboxDelivery(session.id);
			return {
				status: "ok",
        body: {
          ...skipSpawnResponse(
            {
              ...base,
              daprInstanceId: session.id,
              natsSubject: `session.events.${session.id}`,
            },
            session,
            nativeDispatch!,
            nativeRuntimeAppId!,
          ),
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
      let sandbox;
			try {
        sandbox = await this.deps.sandboxProvisioner.provision({
					executionId: session.id,
					name: request.title ?? `peer-${session.id.slice(0, 8)}`,
					sandboxTemplate: request.sandboxTemplate ?? "base",
					keepAfterRun: true,
				});
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
      if (sandbox) {
        let attached: boolean;
        try {
          attached = await this.deps.sessions.attachWorkspaceSandbox({
            sessionId: session.id,
            workspaceSandboxName: sandbox.sandboxName,
          });
        } catch (attachErr) {
          const cleanupError = await this.deleteProvisionedWorkspaceSandbox(
            sandbox.sandboxName,
          );
          await this.releaseUnpublishedRuntimeLease(
            session.id,
            provisioningLease,
          );
          return peerSpawnError(
            500,
            cleanupError ??
              (attachErr instanceof Error
                ? attachErr.message
                : "workspace attachment failed"),
          );
        }
        if (!attached) {
          const cleanupError = await this.deleteProvisionedWorkspaceSandbox(
            sandbox.sandboxName,
          );
          await this.releaseUnpublishedRuntimeLease(
            session.id,
            provisioningLease,
          );
          if (cleanupError) return peerSpawnError(500, cleanupError);
          return peerSpawnError(
            409,
            `Session ${session.id} stopped while its workspace was provisioning`,
          );
        }
        sandboxName = sandbox.sandboxName;
      }
		}

		try {
			const { instanceId, natsSubject } =
        await this.deps.workflowSpawner.spawnSessionWorkflow(session.id, {
          workflowMcpCapabilities,
          provisioningLease,
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
          reused: ensureResult.reused,
				},
			};
		} catch (spawnErr) {
      return peerSpawnError(
        502,
        spawnErr instanceof Error ? spawnErr.message : "Workflow spawn failed",
      );
		}
	}

  private async requestPendingTeamMailboxDelivery(
    sessionId: string,
  ): Promise<void> {
    try {
      await this.deps.teamMailboxDelivery.requestDeliveryAfterRuntimePublished(
        sessionId,
      );
    } catch (err) {
      // The mailbox row remains durable and the periodic sweeper is the fallback;
      // runtime attachment must not be rolled back after it has been published.
      console.warn(
        `[peer-spawn] mailbox delivery trigger failed for ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async deleteProvisionedWorkspaceSandbox(
    sandboxName: string,
  ): Promise<string | null> {
    try {
      const result =
        await this.deps.sandboxDestroyer.deleteWorkspaceSandbox(sandboxName);
      return result.status === "error"
        ? result.error || `failed to delete workspace Sandbox ${sandboxName}`
        : null;
    } catch (err) {
      return err instanceof Error
        ? err.message
        : `failed to delete workspace Sandbox ${sandboxName}`;
    }
  }

  private async releaseUnpublishedRuntimeLease(
    sessionId: string,
    lease: RuntimeProvisioningLease,
  ): Promise<void> {
    const released = await this.deps.workflowSpawner.releaseSessionWorkflow(
      sessionId,
      lease,
    );
    if (released) return;
    await this.deps.sessions.acknowledgeRuntimeProvisioningCompensation({
      sessionId,
      expectedStartedAt: lease.startedAt,
    });
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
  const peerAgentVersion =
    typeof value.peerAgentVersion === "number" &&
    Number.isSafeInteger(value.peerAgentVersion) &&
    value.peerAgentVersion > 0
      ? value.peerAgentVersion
      : null;
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
    peerAgentVersion,
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

function isActivePeerSession(session: PeerSessionRecord): boolean {
  return (
    session.stopRequestedAt == null &&
    session.completedAt == null &&
    session.status !== "terminated"
  );
}

function hasPositiveDispatchEvidence(session: PeerSessionRecord): boolean {
  return Boolean(
    isActivePeerSession(session) &&
    session.daprInstanceId &&
    session.runtimeAppId &&
    session.runtimeProvisioningStartedAt == null,
  );
}

function skipSpawnResponse(
	base: ReturnType<typeof baseResponse>,
	session: PeerSessionRecord,
	dispatch: PeerAgentDispatchContext,
  runtimeAppId: string,
) {
	return {
		...base,
    runtimeAppId,
		agentConfig: dispatch.agentConfig,
		environmentConfig: dispatch.environmentConfig,
		vaultIds: session.vaultIds,
		callableAgents: dispatch.callableAgents,
		registryTeam: dispatch.registryTeam,
		skipSpawn: true,
    requiresStartAuthority: true,
	};
}

function peerSpawnError(
	httpStatus: number,
	message: string,
): PeerSessionSpawnResult {
	return { status: "error", httpStatus, message };
}

function peerSpawnPending(sessionId: string): PeerSessionSpawnResult {
  return {
    status: "pending",
    httpStatus: 202,
    code: "runtime_provisioning",
    message: `Session ${sessionId} runtime provisioning is already in progress`,
    body: { sessionId, reused: true, pending: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
