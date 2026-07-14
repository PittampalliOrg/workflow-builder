import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import {
	daprFetch,
	getDaprSidecarUrl,
	getOrchestratorUrl,
} from "$lib/server/dapr-client";
import type {
	CredentialStore,
	EventBus,
	LegacyAgentPlanReaderPort,
	ResolveSecretOptions,
	WorkflowApprovalEventInput,
	WorkflowApprovalEventPort,
	WorkflowApprovalEventResult,
	WorkflowRaiseEventInput,
	WorkflowScheduler,
	WorkflowScriptStartRequest,
	WorkflowStartRequest,
} from "$lib/server/application/ports";

/** Default agent runtime for a dynamic-script agent() dispatch. */
const DYNAMIC_SCRIPT_DEFAULT_RUNTIME = "dapr-agent-py";
const DYNAMIC_SCRIPT_DEFAULT_TIMEOUT_MINUTES = 30;
const DYNAMIC_SCRIPT_MAX_LIFETIME_AGENTS = 1000;
const DYNAMIC_SCRIPT_MAX_ITEMS_PER_CALL = 4096;
const DYNAMIC_SCRIPT_MAX_STRUCTURED_RETRIES = 5;

function dynamicScriptMaxConcurrency(): number {
	const raw = Number(env.DYNAMIC_SCRIPT_MAX_CONCURRENCY);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/** Contract-1.2.0 action-class primitives (action/sleep/approve/waitForEvent).
 * Stamped into the workflow INPUT at start so replay stays deterministic across
 * env flips; nested workflow() children inherit it. Default OFF until the
 * dispatch path soaks (docs/code-first-cutover.md item 6). */
function dynamicScriptActionsEnabled(): boolean {
	const raw = (env.DYNAMIC_SCRIPT_ACTIONS_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export class DaprWorkflowScheduler implements WorkflowScheduler {
	async startSwWorkflow(input: WorkflowStartRequest): Promise<{ instanceId?: string }> {
		const response = await daprFetch(`${input.orchestratorUrl}/api/v2/sw-workflows`, {
			method: "POST",
			headers: input.headers,
			body: JSON.stringify({
				workflow: input.workflow,
				workflowId: input.workflowId,
				triggerData: input.triggerData,
				dbExecutionId: input.dbExecutionId,
				traceContext: input.traceContext,
				...(input.resumeFromNode ? { resumeFromNode: input.resumeFromNode } : {}),
				...(input.workspaceExecutionId ? { workspaceExecutionId: input.workspaceExecutionId } : {}),
				...(input.seedWorkspaceFrom ? { seedWorkspaceFrom: input.seedWorkspaceFrom } : {}),
			}),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "Unknown error");
			throw new Error(`Orchestrator error (${response.status}): ${detail}`);
		}
		return (await response.json()) as { instanceId?: string };
	}

	async startScriptWorkflow(
		input: WorkflowScriptStartRequest,
	): Promise<{ instanceId?: string }> {
		const scriptSha256 = createHash("sha256").update(input.script, "utf8").digest("hex");
		const response = await daprFetch(`${input.orchestratorUrl}/api/v2/script-workflows`, {
			method: "POST",
			headers: input.headers,
			body: JSON.stringify({
				script: input.script,
				scriptSha256,
				meta: input.meta,
				args: input.args,
				...(input.budgetTotal != null ? { budgetTotal: input.budgetTotal } : {}),
				...(input.journalImportFromExecutionId
					? { journalImportFromExecutionId: input.journalImportFromExecutionId }
					: {}),
				nested: false,
				dispatchMode: input.dispatchMode ?? "batch-v2",
				dbExecutionId: input.dbExecutionId,
				workflowId: input.workflowId,
				userId: input.userId,
				projectId: input.projectId,
				defaults: {
					agentRuntime: DYNAMIC_SCRIPT_DEFAULT_RUNTIME,
					timeoutMinutes: DYNAMIC_SCRIPT_DEFAULT_TIMEOUT_MINUTES,
					// Default model for dapr-agent-py dispatches only (the orchestrator
					// guards non-dapr-agent-py runtimes from inheriting it). Per-call
					// agent(..., {model}) always wins.
					...(env.DYNAMIC_SCRIPT_DEFAULT_MODEL?.trim()
						? { model: env.DYNAMIC_SCRIPT_DEFAULT_MODEL.trim() }
						: {}),
					...(input.defaults ?? {}),
				},
				limits: {
					maxConcurrentAgents: dynamicScriptMaxConcurrency(),
					maxLifetimeAgents: DYNAMIC_SCRIPT_MAX_LIFETIME_AGENTS,
					maxItemsPerCall: DYNAMIC_SCRIPT_MAX_ITEMS_PER_CALL,
					maxStructuredRetries: DYNAMIC_SCRIPT_MAX_STRUCTURED_RETRIES,
				},
				...(dynamicScriptActionsEnabled() ? { features: { actions: true } } : {}),
				traceContext: input.traceContext,
			}),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "Unknown error");
			throw new Error(`Orchestrator error (${response.status}): ${detail}`);
		}
		return (await response.json()) as { instanceId?: string };
	}
}

export class DaprWorkflowApprovalEventPort implements WorkflowApprovalEventPort {
	async raiseApprovalEvent(
		input: WorkflowApprovalEventInput,
	): Promise<WorkflowApprovalEventResult> {
		const response = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(
				input.instanceId,
			)}/events`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					eventName: input.eventType,
					eventData: {
						approved: true,
						approvedBy: input.approvedBy,
						source: "run-ui",
					},
				}),
			},
		);
		if (response.ok) return { ok: true };
		return {
			ok: false,
			status: response.status,
			detail: await response.text().catch(() => ""),
		};
	}

	async raiseWorkflowEvent(
		input: WorkflowRaiseEventInput,
	): Promise<WorkflowApprovalEventResult> {
		const response = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(
				input.instanceId,
			)}/events`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					eventName: input.eventName,
					eventData: input.eventData,
				}),
			},
		);
		if (response.ok) return { ok: true };
		return {
			ok: false,
			status: response.status,
			detail: await response.text().catch(() => ""),
		};
	}
}

export class DaprLegacyAgentPlanReader implements LegacyAgentPlanReaderPort {
	constructor(private readonly appId = "dapr-agent-py.openshell") {}

	async getPlan(executionId: string): Promise<string | null> {
		const invokeUrl = `${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(
			this.appId,
		)}/method/plan/${encodeURIComponent(executionId)}`;
		const response = await daprFetch(invokeUrl, {
			headers: { "Content-Type": "application/json" },
		});
		if (!response.ok) return null;

		const data = (await response.json().catch(() => null)) as {
			plan?: unknown;
		} | null;
		return typeof data?.plan === "string" ? data.plan : null;
	}
}

export class DaprEventBus implements EventBus {
	constructor(
		private readonly pubsubComponent =
			env.DAPR_PUBSUB_COMPONENT || "workflow-triggers-pubsub",
	) {}

	async publish(topic: string, payload: unknown): Promise<void> {
		const response = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/publish/${this.pubsubComponent}/${encodeURIComponent(topic)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			},
		);
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`Dapr publish failed (${response.status}): ${detail}`);
		}
	}
}

export class DaprCredentialStore implements CredentialStore {
	constructor(
		private readonly defaultStore = env.DAPR_SECRETS_STORE || "azure-keyvault",
	) {}

	async resolveSecret(
		name: string,
		options: ResolveSecretOptions = {},
	): Promise<Record<string, unknown>> {
		const secretName = name.trim();
		if (!secretName) throw new Error("Secret name is required");
		const store = (options.store ?? this.defaultStore).trim();
		if (!store) throw new Error("Dapr secret store name is required");
		const signal =
			options.signal ??
			(options.timeoutMs == null
				? undefined
				: AbortSignal.timeout(options.timeoutMs));
		const response = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/secrets/${encodeURIComponent(
				store,
			)}/${encodeURIComponent(secretName)}`,
			{ signal, maxRetries: 0 },
		);
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`Dapr secret lookup failed (${response.status}): ${detail}`);
		}
		return (await response.json()) as Record<string, unknown>;
	}
}
