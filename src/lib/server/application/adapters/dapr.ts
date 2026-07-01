import { env } from "$env/dynamic/private";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import type {
	CredentialStore,
	EventBus,
	ResolveSecretOptions,
	WorkflowScheduler,
	WorkflowStartRequest,
} from "$lib/server/application/ports";

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
				mlflowContext: input.mlflowContext,
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
