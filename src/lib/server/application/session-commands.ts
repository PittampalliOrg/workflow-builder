import { createHash } from "node:crypto";
import { isAgentConfigEquivalent } from "$lib/utils/agent-config-diff";
import type { AgentConfig } from "$lib/types/agents";
import type {
	SessionDetail,
	SessionResource,
	SessionResourceType,
	SessionSummary,
	UserEvent,
} from "$lib/types/sessions";
import {
	classifySessionKind,
	DEV_SESSION_WORKFLOW_ID,
	type SessionKind,
} from "$lib/server/application/session-kind";
import { canResumeCliSession, isInteractiveCliRuntime } from "$lib/server/sessions/resume";
import { CliTokenError } from "$lib/server/application/cli-credentials";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { sandboxProvisionFailureMessage } from "$lib/server/sandboxes/provision";
import type {
	AddSessionResourceInput,
	AgentRuntimeSyncPort,
	SandboxProvisioner,
	SessionAgentSlugResolver,
	SessionAgentResolver,
	SessionEventLog,
	SessionExperimentAgentStore,
	SessionListInput,
	SessionRepository,
	SessionRepositoryMountTarget,
	SessionRepositoryMounter,
	SessionSandboxDestroyer,
	SessionWorkflowSpawner,
	WorkspaceProjectRepository,
	WorkflowEphemeralAgentStore,
	WorkflowPublishedAgent,
} from "$lib/server/application/ports";

/** Minimal slice of the workflow-definition repo used to resolve a project's
 * dev-session workflow id (project-forked, else the template). Kept narrow so
 * the session command service doesn't take a dependency on the whole repo. */
export interface DevSessionWorkflowResolver {
	findProjectWorkflowIdByIdOrNamePrefix(input: {
		projectId: string;
		workflowId: string;
		namePrefix: string;
	}): Promise<string | null>;
}

export type SessionListPageInput = SessionListInput & { kind?: SessionKind };

export type SessionListPage = {
	sessions: (SessionSummary & { kind: SessionKind })[];
	hasMore: boolean;
	/** The project's resolved dev-session workflow id (for client-side kind
	 * links / re-classification); null when unresolved or project-less. */
	devWorkflowId: string | null;
};

export type CreateInteractiveSessionCommand = {
	userId: string;
	projectId?: string | null;
	body: Record<string, unknown>;
};

export type CreateInteractiveSessionResult =
	| { status: "created"; session: SessionDetail }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string }
	| { status: "conflict"; message: string }
	| {
			status: "precondition_failed";
			code: string;
			provider: string;
			settingsPath: string;
			message: string;
			session: SessionDetail;
	  };

export type StartSessionWorkflowCommand = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type StartSessionWorkflowResult =
	| {
			status: "started";
			instanceId: string;
			natsSubject: string;
			alreadyStarted: false;
	  }
	| {
			status: "already_started";
			instanceId: string;
			natsSubject: string | null;
			alreadyStarted: true;
	  }
	| {
			status: "precondition_failed";
			code: string;
			provider: string;
			settingsPath: string;
			message: string;
	  }
	| { status: "not_found"; message: string }
	| { status: "failed"; message: string };

export type AddSessionResourceCommand = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
	body: Record<string, unknown>;
};

export type AddSessionResourceResult =
	| { status: "created"; resource: SessionResource }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export type MaterializeWorkflowSessionRepositoriesCommand = {
	sessionId: string;
	repositories: unknown;
	workflowExecutionId?: string | null;
	workspaceRef?: string | null;
	cwd?: string | null;
};

export type MaterializeSessionRepositoriesViaHostCommand = {
	sessionId: string;
	hostBaseUrl: string;
};

export type ReapTerminatedWorkflowSessionRuntimeHostsCommand = {
	workflowExecutionId: string;
	exceptSessionId: string;
};

export type AppendWorkflowSessionSwapDegradedEventCommand = {
	sessionId: string;
	runtimeId: string;
	decision: string;
	drops: unknown[];
};

export type AppendWorkflowSessionInitialMessageCommand = {
	sessionId: string;
	text: string | null | undefined;
};

export type ResolveWorkflowSessionAgentCommand = {
	publishedAgent: WorkflowPublishedAgent | null;
	workflowId: string;
	nodeId: string;
	agentConfig: AgentConfig;
	userId: string;
};

export type SyncWorkflowSessionAgentRuntimeCommand = {
	agentId: string;
	bestEffort?: boolean;
	context?: string;
};

export type DispatchAgentTriggerCommand = {
	body: Record<string, unknown>;
};

export type DispatchAgentTriggerResult = {
	status: "ack";
	outcome:
		| "missing_fields"
		| "agent_not_found"
		| "project_mismatch"
		| "not_member"
		| "duplicate"
		| "started"
		| "failed";
	sessionId?: string;
	agentId?: string;
	message?: string;
};

type AgentTriggerPayload = {
	agentId?: unknown;
	agentSlug?: unknown;
	agentVersion?: unknown;
	projectId?: unknown;
	userId?: unknown;
	objective?: unknown;
	prompt?: unknown;
	initialMessage?: unknown;
	dedupKey?: unknown;
	title?: unknown;
	vaultIds?: unknown;
};

function triggerSessionId(dedupKey: string): string {
	const hex = createHash("sha256").update(dedupKey).digest("hex").slice(0, 40);
	return `evt-${hex}`;
}

export class ApplicationSessionCommandService {
	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			sessionEvents: SessionEventLog;
			sessionAgents: SessionAgentResolver;
			sessionAgentSlugs?: SessionAgentSlugResolver;
			sessionExperimentAgents: SessionExperimentAgentStore;
			sandboxProvisioner: SandboxProvisioner;
			repositoryMounter: SessionRepositoryMounter;
			workflowSpawner: SessionWorkflowSpawner;
			workspaceProjects?: WorkspaceProjectRepository;
			sandboxDestroyer?: SessionSandboxDestroyer;
			workflowEphemeralAgents?: WorkflowEphemeralAgentStore;
			agentRuntimeSync?: AgentRuntimeSyncPort;
			devSessionWorkflows?: DevSessionWorkflowResolver;
		},
	) {}

	listSessions(filter: SessionListInput = {}) {
		return this.deps.sessions.listSessions(filter);
	}

	/**
	 * One page of classified sessions for the dedicated Sessions list. `limit+1`
	 * is fetched to derive `hasMore` without a count query. Kind narrowing is
	 * server-side where it maps cleanly onto existing filter columns (dev →
	 * resolved workflowId, workflow → source); interactive/experiment share the
	 * "direct" set and are refined by post-classification, so a page may render
	 * fewer than `limit` rows while `hasMore`/`offset` still page the raw set.
	 */
	async getSessionListPage(
		input: SessionListPageInput,
	): Promise<SessionListPage> {
		const { kind, limit: rawLimit, offset, ...rest } = input;
		const limit = Math.max(1, Math.min(rawLimit ?? 50, 200));

		let devWorkflowId: string | null = null;
		if (rest.projectId && this.deps.devSessionWorkflows) {
			devWorkflowId = await this.deps.devSessionWorkflows
				.findProjectWorkflowIdByIdOrNamePrefix({
					projectId: rest.projectId,
					workflowId: DEV_SESSION_WORKFLOW_ID,
					namePrefix: "Microservice dev-session%",
				})
				.catch(() => null);
		}

		const filter: SessionListInput = {
			...rest,
			limit: limit + 1,
			offset: offset ?? 0,
		};
		if (kind === "dev") {
			filter.workflowId = devWorkflowId ?? DEV_SESSION_WORKFLOW_ID;
		} else if (kind === "workflow") {
			filter.source = "workflow";
		} else if (kind === "interactive") {
			filter.source = "direct";
		}

		const rows = await this.deps.sessions.listSessions(filter);
		const hasMore = rows.length > limit;
		const page = rows.slice(0, limit).map((session) => ({
			...session,
			kind: classifySessionKind(
				{
					workflowId: session.workflowId,
					workflowExecutionId: session.workflowExecutionId,
					agentSlug: session.agentSlug,
				},
				devWorkflowId,
			),
		}));
		const sessions =
			kind === "interactive" || kind === "experiment"
				? page.filter((session) => session.kind === kind)
				: page;
		return { sessions, hasMore, devWorkflowId };
	}

	async dispatchAgentTrigger(
		input: DispatchAgentTriggerCommand,
	): Promise<DispatchAgentTriggerResult> {
		try {
			const data = (
				input.body.data && typeof input.body.data === "object"
					? input.body.data
					: input.body
			) as AgentTriggerPayload;
			const agentIdRaw =
				typeof data.agentId === "string" ? data.agentId.trim() : "";
			const agentSlugRaw =
				typeof data.agentSlug === "string" ? data.agentSlug.trim() : "";
			const projectId =
				typeof data.projectId === "string" ? data.projectId.trim() : "";
			const userId = typeof data.userId === "string" ? data.userId.trim() : "";
			const objective =
				typeof data.objective === "string"
					? data.objective
					: typeof data.prompt === "string"
						? data.prompt
						: typeof data.initialMessage === "string"
							? data.initialMessage
							: "";
			const dedupKey =
				(typeof data.dedupKey === "string" && data.dedupKey.trim()) ||
				(typeof input.body.id === "string" && input.body.id.trim()) ||
				"";
			const agentVersion =
				typeof data.agentVersion === "number" ? data.agentVersion : undefined;
			const vaultIds = Array.isArray(data.vaultIds)
				? data.vaultIds.filter((v): v is string => typeof v === "string")
				: undefined;
			const title =
				typeof data.title === "string" && data.title.trim()
					? data.title
					: undefined;

			if ((!agentIdRaw && !agentSlugRaw) || !projectId || !userId || !dedupKey) {
				console.warn(
					"[agent-trigger] missing required fields (agentId|agentSlug, projectId, userId, dedupKey) — dropping",
				);
				return { status: "ack", outcome: "missing_fields" };
			}

			let resolveId = agentIdRaw;
			if (!resolveId && agentSlugRaw && this.deps.sessionAgentSlugs) {
				resolveId =
					(await this.deps.sessionAgentSlugs.resolveSessionAgentIdBySlug(
						agentSlugRaw,
					)) ?? "";
			}
			const agent = resolveId
				? await this.deps.sessionAgents.resolveSessionAgent({
						agentId: resolveId,
						agentVersion,
					})
				: null;
			if (!agent) {
				console.warn(
					`[agent-trigger] agent not found (id=${agentIdRaw} slug=${agentSlugRaw}) — dropping`,
				);
				return { status: "ack", outcome: "agent_not_found" };
			}

			if (agent.projectId && agent.projectId !== projectId) {
				console.warn(
					`[agent-trigger] agent ${agent.id} not in project ${projectId} — dropping`,
				);
				return {
					status: "ack",
					outcome: "project_mismatch",
					agentId: agent.id,
				};
			}
			const membership =
				await this.deps.workspaceProjects?.getProjectMembershipDetail({
					projectId,
					userId,
				});
			if (!membership?.selfRole) {
				console.warn(
					`[agent-trigger] user ${userId} is not a member of project ${projectId} — dropping`,
				);
				return { status: "ack", outcome: "not_member", agentId: agent.id };
			}

			const sessionId = triggerSessionId(dedupKey);
			const existing = await this.deps.sessions.getSession(sessionId);
			if (existing) {
				return {
					status: "ack",
					outcome: "duplicate",
					sessionId,
					agentId: agent.id,
				};
			}

			const session = await this.deps.sessions.createSession({
				id: sessionId,
				agentId: agent.id,
				agentVersion: agent.version ?? agentVersion,
				vaultIds,
				title: title ?? `Triggered · ${agent.name}`,
				userId,
				projectId,
			});

			if (objective.trim()) {
				const userMessage: UserEvent = {
					type: "user.message",
					content: [{ type: "text", text: objective }],
				};
				await this.deps.sessionEvents.appendSessionEvent(session.id, {
					type: userMessage.type,
					data: userMessage as unknown as Record<string, unknown>,
					processedAt: null,
				});
			}

			await this.deps.workflowSpawner.spawnSessionWorkflow(session.id);
			console.info(
				`[agent-trigger] started session ${session.id} for agent ${agent.slug} (project ${projectId})`,
			);
			return {
				status: "ack",
				outcome: "started",
				sessionId: session.id,
				agentId: agent.id,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[agent-trigger] dispatch failed:", message);
			return { status: "ack", outcome: "failed", message };
		}
	}

	async startSessionWorkflow(
		input: StartSessionWorkflowCommand,
	): Promise<StartSessionWorkflowResult> {
		const session = await this.deps.sessions.getSession(input.sessionId);
		if (!session || !this.isSessionInProject(session, input.projectId ?? null)) {
			return { status: "not_found", message: "Session not found" };
		}

		if (session.daprInstanceId) {
			return {
				status: "already_started",
				instanceId: session.daprInstanceId,
				natsSubject: session.natsSubject,
				alreadyStarted: true,
			};
		}

		await this.deps.sessions.updateSessionStatusUnlessTerminated({
			id: input.sessionId,
			status: "rescheduling",
			errorMessage: null,
		});

		try {
			const runtime = await this.deps.workflowSpawner.spawnSessionWorkflow(
				input.sessionId,
			);
			return {
				status: "started",
				instanceId: runtime.instanceId,
				natsSubject: runtime.natsSubject,
				alreadyStarted: false,
			};
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Session workflow spawn failed";
			await this.deps.sessions.updateSessionStatusUnlessTerminated({
				id: input.sessionId,
				status: "rescheduling",
				errorMessage: message,
			});
			if (err instanceof CliTokenError) {
				return {
					status: "precondition_failed",
					code: err.code,
					provider: err.provider,
					settingsPath: "/settings/cli-tokens",
					message,
				};
			}
			return { status: "failed", message };
		}
	}

	async addSessionResource(
		input: AddSessionResourceCommand,
	): Promise<AddSessionResourceResult> {
		const parsed = parseSessionResourceInput(input.body);
		if (parsed.status === "invalid") return parsed;

		const session = await this.deps.sessions.getSession(input.sessionId);
		if (!session || !this.isSessionInProject(session, input.projectId ?? null)) {
			return { status: "not_found", message: "Session not found" };
		}

		const resource = await this.deps.sessions.addSessionResource({
			sessionId: input.sessionId,
			resource: parsed.resource,
		});

		if (resource.type === "github_repository") {
			try {
				await this.mountRepoIntoLiveSession(session, resource);
			} catch (mountErr) {
				console.warn("[sessions] mid-session repo mount failed:", mountErr);
			}
		}

		return { status: "created", resource };
	}

	async materializeWorkflowSessionRepositories(
		input: MaterializeWorkflowSessionRepositoriesCommand,
	): Promise<void> {
		const repos = parseRepositoryResources(input.repositories);
		if (repos.length === 0) return;

		const existing = await this.deps.sessions.listSessionResources(
			input.sessionId,
		);
		if (!existing.some((resource) => resource.type === "github_repository")) {
			for (const repo of repos) {
				try {
					await this.deps.sessions.addSessionResource({
						sessionId: input.sessionId,
						resource: {
							type: "github_repository",
							repoUrl: repo.repoUrl,
							checkoutRef: repo.checkoutRef,
							mountPath: repo.mountPath,
							authTokenCredentialId: repo.authTokenCredentialId,
							appConnectionExternalId: repo.appConnectionExternalId,
						},
					});
				} catch (resErr) {
					console.warn(
						"[sessions] failed to persist workflow repo resource:",
						resErr,
					);
				}
			}
		}

		if (!input.workspaceRef) return;
		try {
			await this.deps.repositoryMounter.mountSessionRepositories(
				input.sessionId,
				{
					executionId: input.workflowExecutionId ?? input.sessionId,
					workspaceRef: input.workspaceRef,
					rootPath: input.cwd ?? null,
				},
			);
		} catch (mountErr) {
			console.error("[sessions] workflow repository mount failed:", mountErr);
		}
	}

	async materializeSessionRepositoriesViaHost(
		input: MaterializeSessionRepositoriesViaHostCommand,
	): Promise<void> {
		await this.deps.repositoryMounter.mountSessionRepositoriesViaHost(
			input.sessionId,
			input.hostBaseUrl,
		);
	}

	async resolveWorkflowSessionAgent(
		input: ResolveWorkflowSessionAgentCommand,
	): Promise<{ agentId: string; agentVersion: number }> {
		if (input.publishedAgent) {
			return {
				agentId: input.publishedAgent.agentId,
				agentVersion: input.publishedAgent.agentVersion,
			};
		}
		if (!this.deps.workflowEphemeralAgents) {
			throw new Error("Workflow ephemeral agent store is not configured");
		}
		return this.deps.workflowEphemeralAgents.findOrCreateWorkflowEphemeralAgent({
			workflowId: input.workflowId,
			nodeId: input.nodeId,
			agentConfig: input.agentConfig,
			userId: input.userId,
		});
	}

	async syncWorkflowSessionAgentRuntime(
		input: SyncWorkflowSessionAgentRuntimeCommand,
	): Promise<void> {
		if (!this.deps.agentRuntimeSync) return;
		try {
			await this.deps.agentRuntimeSync.syncAgentRuntime(input.agentId);
		} catch (err) {
			if (!input.bestEffort) throw err;
			console.warn(
				`[sessions] sync runtime${input.context ? ` for ${input.context}` : ""} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	async appendWorkflowSessionSwapDegradedEvent(
		input: AppendWorkflowSessionSwapDegradedEventCommand,
	): Promise<void> {
		await this.deps.sessionEvents.appendSessionEvent(input.sessionId, {
			type: "runtime.swap_degraded",
			data: {
				runtimeId: input.runtimeId,
				decision: input.decision,
				drops: input.drops,
			},
			sourceEventId: `swap:${input.sessionId}:${input.runtimeId}`,
		});
	}

	async appendWorkflowSessionInitialMessage(
		input: AppendWorkflowSessionInitialMessageCommand,
	): Promise<void> {
		const text = typeof input.text === "string" ? input.text.trim() : "";
		if (!text) return;
		await this.deps.sessionEvents.appendSessionEvent(input.sessionId, {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text }],
			},
			processedAt: null,
		});
	}

	async reapTerminatedWorkflowSessionRuntimeHosts(
		input: ReapTerminatedWorkflowSessionRuntimeHostsCommand,
	): Promise<void> {
		if (!this.deps.sandboxDestroyer) return;
		const rows = await this.deps.sessions.listReapableWorkflowSessionRuntimeHosts({
			workflowExecutionId: input.workflowExecutionId,
		});
		for (const row of rows) {
			if (row.sessionId === input.exceptSessionId) continue;
			try {
				await this.deps.sandboxDestroyer.deleteRuntimeSandbox(
					`agent-host-${row.runtimeAppId}`,
				);
			} catch (err) {
				console.warn(
					`[sessions] reap host agent-host-${row.runtimeAppId} failed (best-effort): ${String(err)}`,
				);
			}
		}
	}

	async createInteractiveSession(
		input: CreateInteractiveSessionCommand,
	): Promise<CreateInteractiveSessionResult> {
		const body = input.body;
		const requestedAgentId = typeof body.agentId === "string" ? body.agentId : "";
		if (!requestedAgentId) {
			return { status: "invalid", message: "agentId is required" };
		}

		let resolvedAgentId = requestedAgentId;
		let resolvedAgentVersion =
			typeof body.agentVersion === "number" ? body.agentVersion : undefined;

		const resumeFromSessionId =
			typeof body.resumeFromSessionId === "string" && body.resumeFromSessionId
				? body.resumeFromSessionId
				: undefined;
		if (resumeFromSessionId) {
			const resumeResult = await this.resolveResumeTarget({
				sourceSessionId: resumeFromSessionId,
				projectId: input.projectId ?? null,
			});
			if (resumeResult.status !== "ok") return resumeResult;
			resolvedAgentId = resumeResult.agentId;
			resolvedAgentVersion = resumeResult.agentVersion ?? undefined;
		}

		const tweakedConfig = isAgentConfigShape(body.agentConfig)
			? (body.agentConfig as AgentConfig)
			: null;

		if (tweakedConfig) {
			const experimentResult = await this.resolveExperimentAgent({
				requestedAgentId,
				resolvedAgentVersion,
				agentConfig: tweakedConfig,
				userId: input.userId,
				projectId: input.projectId ?? null,
			});
			if (experimentResult.status !== "ok") return experimentResult;
			resolvedAgentId = experimentResult.agentId;
			resolvedAgentVersion = experimentResult.agentVersion;
		}

		try {
			const session = await this.deps.sessions.createSession({
				agentId: resolvedAgentId,
				agentVersion: resolvedAgentVersion,
				environmentId:
					typeof body.environmentId === "string" ? body.environmentId : undefined,
				environmentVersion:
					typeof body.environmentVersion === "number"
						? body.environmentVersion
						: undefined,
				vaultIds: Array.isArray(body.vaultIds)
					? body.vaultIds.filter((v): v is string => typeof v === "string")
					: undefined,
				title: typeof body.title === "string" ? body.title : undefined,
				userId: input.userId,
				projectId: input.projectId ?? null,
				resumedFromSessionId: resumeFromSessionId ?? null,
			});

			const resolvedAgent = await this.deps.sessionAgents.resolveSessionAgent({
				agentId: session.agentId,
				agentVersion: session.agentVersion ?? undefined,
			});
			await this.appendInitialMessage({ sessionId: session.id, body });

			const mergedRepos = dedupeRepositoriesByUrl([
				...parseRepositoryResources(resolvedAgent?.config?.repositories),
				...parseRepositoryResources(body.resources),
			]);
			for (const repo of mergedRepos) {
				try {
					await this.deps.sessions.addSessionResource({
						sessionId: session.id,
						resource: {
							type: "github_repository",
							repoUrl: repo.repoUrl,
							checkoutRef: repo.checkoutRef,
							mountPath: repo.mountPath,
							authTokenCredentialId: repo.authTokenCredentialId,
							appConnectionExternalId: repo.appConnectionExternalId,
						},
					});
				} catch (resErr) {
					console.warn("[sessions] failed to persist repo resource:", resErr);
				}
			}

			const repoMountTarget = await this.maybeProvisionSandbox({ session, body });
			const interactiveCliRuntime =
				getRuntimeDescriptor(
					readRuntimeFromConfig(resolvedAgent?.config) ?? resolvedAgent?.runtime,
				)?.capabilities?.interactiveTerminal === true;
			if (repoMountTarget && !interactiveCliRuntime) {
				try {
					await this.deps.repositoryMounter.mountSessionRepositories(
						session.id,
						repoMountTarget,
					);
				} catch (mountErr) {
					console.error("[sessions] repository mount failed:", mountErr);
				}
			}

			try {
				const { instanceId, natsSubject } =
					await this.deps.workflowSpawner.spawnSessionWorkflow(session.id);
				session.daprInstanceId = instanceId;
				session.natsSubject = natsSubject;
			} catch (spawnErr) {
				console.error("[sessions] spawn failed:", spawnErr);
				session.errorMessage =
					spawnErr instanceof Error ? spawnErr.message : "Workflow spawn failed";
				if (spawnErr instanceof CliTokenError) {
					return {
						status: "precondition_failed",
						code: spawnErr.code,
						provider: spawnErr.provider,
						settingsPath: "/settings/cli-tokens",
						message: spawnErr.message,
						session,
					};
				}
			}

			return { status: "created", session };
		} catch (err) {
			return {
				status: "invalid",
				message: err instanceof Error ? err.message : "Session create failed",
			};
		}
	}

	private async resolveResumeTarget(input: {
		sourceSessionId: string;
		projectId?: string | null;
	}): Promise<
		| { status: "ok"; agentId: string; agentVersion?: number | null }
		| { status: "not_found"; message: string }
		| { status: "invalid"; message: string }
		| { status: "conflict"; message: string }
	> {
		const source = await this.deps.sessions.getSession(input.sourceSessionId);
		if (!source) {
			return { status: "not_found", message: "resumeFromSessionId session not found" };
		}
		if (input.projectId && source.projectId !== input.projectId) {
			return { status: "not_found", message: "resumeFromSessionId session not found" };
		}
		const sourceAgent = await this.deps.sessionAgents.resolveSessionAgent({
			agentId: source.agentId,
			agentVersion: source.agentVersion ?? undefined,
		});
		const sourceRuntime = sourceAgent
			? getRuntimeDescriptor(sourceAgent.runtime)
			: null;
		const resumeDecision = canResumeCliSession({
			runtime: sourceRuntime,
			status: source.status,
			stopReason: source.stopReason,
			errorMessage: source.errorMessage,
			// completedAt distinguishes a finalized crash (resumable) from a LIVE
			// turn-level `failed` (pod/TUI still up → resuming would duplicate).
			completedAt: source.completedAt,
		});
		if (!resumeDecision.allowed) {
			const status = isInteractiveCliRuntime(sourceRuntime)
				? "conflict"
				: "invalid";
			return {
				status,
				message: resumeDecision.reason ?? "session is not resumable",
			};
		}
		return {
			status: "ok",
			agentId: source.agentId,
			agentVersion: source.agentVersion ?? undefined,
		};
	}

	private async resolveExperimentAgent(input: {
		requestedAgentId: string;
		resolvedAgentVersion?: number;
		agentConfig: AgentConfig;
		userId: string;
		projectId?: string | null;
	}): Promise<
		| { status: "ok"; agentId: string; agentVersion?: number }
		| { status: "not_found"; message: string }
		| { status: "invalid"; message: string }
	> {
		const baseAgent = await this.deps.sessionAgents.resolveSessionAgent({
			agentId: input.requestedAgentId,
			agentVersion: input.resolvedAgentVersion,
		});
		if (!baseAgent) return { status: "not_found", message: "Base agent not found" };
		if (isAgentConfigEquivalent(baseAgent.config, input.agentConfig)) {
			return {
				status: "ok",
				agentId: input.requestedAgentId,
				agentVersion: input.resolvedAgentVersion,
			};
		}
		try {
			const experiment =
				await this.deps.sessionExperimentAgents.findOrCreateSessionExperimentAgent({
					baseAgentId: baseAgent.id,
					baseAgentSlug: baseAgent.slug,
					baseAgentName: baseAgent.name,
					agentConfig: input.agentConfig,
					userId: input.userId,
					projectId: input.projectId ?? null,
				});
			return {
				status: "ok",
				agentId: experiment.agentId,
				agentVersion: experiment.agentVersion,
			};
		} catch (err) {
			return {
				status: "invalid",
				message:
					err instanceof Error ? err.message : "Experiment agent create failed",
			};
		}
	}

	private async appendInitialMessage(input: {
		sessionId: string;
		body: Record<string, unknown>;
	}): Promise<void> {
		if (
			typeof input.body.initialMessage !== "string" ||
			!input.body.initialMessage.trim()
		) {
			return;
		}
		const userMessage: UserEvent = {
			type: "user.message",
			content: [{ type: "text", text: input.body.initialMessage }],
		};
		await this.deps.sessionEvents.appendSessionEvent(input.sessionId, {
			type: userMessage.type,
			data: userMessage as unknown as Record<string, unknown>,
			processedAt: null,
		});
	}

	private async maybeProvisionSandbox(input: {
		session: SessionDetail;
		body: Record<string, unknown>;
	}): Promise<SessionRepositoryMountTarget | null> {
		const provisioning =
			typeof input.body.provisioning === "string" &&
			input.body.provisioning.trim().toLowerCase() === "lazy"
				? "lazy"
				: "eager";
		if (provisioning !== "eager") return null;

		try {
			const sandbox = await this.deps.sandboxProvisioner.provision({
				executionId: input.session.id,
				name: input.session.title ?? `session-${input.session.id.slice(0, 8)}`,
				sandboxTemplate:
					typeof input.body.sandboxTemplate === "string"
						? input.body.sandboxTemplate
						: "base",
				keepAfterRun: true,
			});
			await this.deps.sessions.attachWorkspaceSandbox({
				sessionId: input.session.id,
				workspaceSandboxName: sandbox.sandboxName,
			});
			input.session.workspaceSandboxName = sandbox.sandboxName;
			input.session.errorMessage = null;
			return {
				executionId: input.session.id,
				workspaceRef: sandbox.workspaceRef,
				rootPath: sandbox.rootPath,
			};
		} catch (sandboxErr) {
			console.error("[sessions] sandbox provisioning failed:", sandboxErr);
			const message = sandboxProvisionFailureMessage(sandboxErr);
			input.session.errorMessage = message;
			try {
				await this.deps.sessions.recordSandboxProvisioningError({
					sessionId: input.session.id,
					errorMessage: message,
				});
			} catch (persistErr) {
				console.error(
					"[sessions] failed to persist sandbox provisioning error:",
					persistErr,
				);
			}
			return null;
		}
	}

	private async mountRepoIntoLiveSession(
		session: SessionDetail,
		resource: SessionResource,
	): Promise<void> {
		if (!session.workspaceSandboxName) return;
		let workspaceRef: string | null = null;
		let rootPath = "/sandbox";
		try {
			const sandbox = await this.deps.sandboxProvisioner.provision({
				executionId: session.id,
				name: session.title ?? `session-${session.id.slice(0, 8)}`,
				keepAfterRun: true,
			});
			workspaceRef = sandbox.workspaceRef;
			rootPath = sandbox.rootPath;
		} catch (provErr) {
			console.warn(
				"[sessions] could not recover sandbox workspaceRef for mid-session mount:",
				provErr,
			);
		}
		await this.deps.repositoryMounter.mountSessionRepository(session.id, resource, {
			executionId: session.id,
			workspaceRef,
			rootPath,
		});
	}

	private isSessionInProject(
		session: SessionDetail,
		projectId?: string | null,
	): boolean {
		return !projectId || session.projectId === projectId;
	}
}

function parseSessionResourceInput(
	body: Record<string, unknown>,
):
	| { status: "ok"; resource: AddSessionResourceInput }
	| { status: "invalid"; message: string } {
	const type = body.type as SessionResourceType | undefined;
	if (type !== "file" && type !== "github_repository") {
		return {
			status: "invalid",
			message: "type must be 'file' or 'github_repository'",
		};
	}
	return {
		status: "ok",
		resource: {
			type,
			fileId: typeof body.fileId === "string" ? body.fileId : undefined,
			mountPath:
				typeof body.mountPath === "string" ? body.mountPath : undefined,
			repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
			checkoutRef:
				typeof body.checkoutRef === "string" ? body.checkoutRef : undefined,
			authTokenCredentialId:
				typeof body.authTokenCredentialId === "string"
					? body.authTokenCredentialId
					: undefined,
			appConnectionExternalId:
				typeof body.appConnectionExternalId === "string"
					? body.appConnectionExternalId
					: undefined,
		},
	};
}

function isAgentConfigShape(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.runtime === "string" ||
		typeof v.modelSpec === "string" ||
		typeof v.systemPrompt === "string" ||
		Array.isArray(v.skills) ||
		Array.isArray(v.mcpServers) ||
		Array.isArray(v.builtinTools) ||
		Array.isArray(v.bundleRefs)
	);
}

function readRuntimeFromConfig(config: unknown): string | undefined {
	if (!config || typeof config !== "object") return undefined;
	const runtime = (config as { runtime?: unknown }).runtime;
	return typeof runtime === "string" ? runtime : undefined;
}

type ParsedRepoResource = {
	repoUrl: string;
	checkoutRef?: string;
	mountPath?: string;
	authTokenCredentialId?: string;
	appConnectionExternalId?: string;
};

function parseRepositoryResources(value: unknown): ParsedRepoResource[] {
	if (!Array.isArray(value)) return [];
	const out: ParsedRepoResource[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const repoUrl = typeof e.repoUrl === "string" ? e.repoUrl.trim() : "";
		if (!repoUrl) continue;
		out.push({
			repoUrl,
			checkoutRef:
				typeof e.checkoutRef === "string" && e.checkoutRef.trim()
					? e.checkoutRef.trim()
					: undefined,
			mountPath:
				typeof e.mountPath === "string" && e.mountPath.trim()
					? e.mountPath.trim()
					: undefined,
			authTokenCredentialId:
				typeof e.authTokenCredentialId === "string" && e.authTokenCredentialId
					? e.authTokenCredentialId
					: undefined,
			appConnectionExternalId:
				typeof e.appConnectionExternalId === "string" && e.appConnectionExternalId
					? e.appConnectionExternalId
					: undefined,
		});
	}
	return out;
}

function dedupeRepositoriesByUrl(
	repos: ParsedRepoResource[],
): ParsedRepoResource[] {
	const byUrl = new Map<string, ParsedRepoResource>();
	for (const r of repos) byUrl.set(r.repoUrl.toLowerCase(), r);
	return [...byUrl.values()];
}
