import type {
	PeerAgentDispatchContext,
	PeerSessionRecord,
	SessionWorkflowSpawner,
	WorkflowDataService,
} from "$lib/server/application/ports";

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
				"ensurePeerSession" | "resolvePeerAgentDispatchContext"
			>;
			workflowSpawner: SessionWorkflowSpawner;
		},
	) {}

	async spawnPeerSession(body: unknown): Promise<PeerSessionSpawnResult> {
		const request = parsePeerSpawnRequest(body);
		if (!request.sessionId) return peerSpawnError(400, "sessionId is required");
		if (!request.peerAgentId) return peerSpawnError(400, "peerAgentId is required");
		if (request.sessionId.length > 64) {
			return peerSpawnError(
				400,
				"sessionId must be ≤64 chars (Dapr workflow cap)",
			);
		}

		const ensureResult = await this.deps.workflowData.ensurePeerSession({
			sessionId: request.sessionId,
			peerAgentId: request.peerAgentId,
			prompt: request.prompt,
			parentSessionId: request.parentSessionId,
			parentInstanceId: request.parentInstanceId,
			title: request.title,
		});
		if (!ensureResult.ok) {
			return peerSpawnError(ensureResult.status, ensureResult.message);
		}

		const session = ensureResult.session;
		const base = baseResponse(session, ensureResult.reused);
		if (ensureResult.reused && !request.skipSpawnOnReplay) {
			return { status: "ok", body: base };
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
				return peerSpawnError(500, `could not re-resolve peer ${session.agentId}`);
			}
			return {
				status: "ok",
				body: skipSpawnResponse(base, session, dispatch),
			};
		}

		try {
			const { instanceId, natsSubject } =
				await this.deps.workflowSpawner.spawnSessionWorkflow(session.id);
			return {
				status: "ok",
				body: {
					sessionId: session.id,
					agentId: session.agentId,
					agentVersion: session.agentVersion,
					daprInstanceId: instanceId,
					natsSubject,
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
	return {
		sessionId,
		peerAgentId,
		prompt,
		parentSessionId,
		parentInstanceId,
		title,
		skipSpawn,
		skipSpawnOnReplay: skipSpawn,
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
