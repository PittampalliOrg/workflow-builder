export interface DaprComponent {
	name: string;
	type: string;
	version: string;
	capabilities?: string[];
}

export interface DaprSubscription {
	pubsubname: string;
	topic: string;
	route?: string;
	routes?: { rules?: { path: string; match?: string }[]; default?: string };
}

export interface SidecarMetadata {
	id: string;
	runtimeVersion: string;
	enabledFeatures: string[];
	components: DaprComponent[];
	subscriptions: DaprSubscription[];
	httpEndpoints: unknown[];
	appConnectionProperties: Record<string, unknown>;
}

export interface ServiceHealthEntry {
	id: string;
	healthy: boolean;
	version: string;
	runtime: string;
	workflowCount: number;
	activityCount: number;
	features: string[];
	error?: string;
}

export interface WorkflowInstance {
	instanceId: string;
	workflowId?: string;
	workflowName?: string;
	runtimeStatus?: string;
	status?: string;
	phase?: string;
	progress?: number;
	startedAt?: string;
	completedAt?: string;
	duration?: string | number;
	message?: string;
}

export interface WorkflowRegistration {
	serviceId: string;
	name: string;
	version?: string;
	metadata?: Record<string, unknown>;
}

export interface WorkflowHistoryEvent {
	eventId?: number;
	eventType: string;
	timestamp?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
}

export interface KnownStateKeys {
	agents: {
		key: string;
		label: string;
		storeName: string;
		serviceId: string;
		metadata?: Record<string, string>;
	}[];
	conversations: {
		key: string;
		label: string;
		storeName: string;
		serviceId: string;
		metadata?: Record<string, string>;
	}[];
}

export interface AgentStateMessage {
	role: string;
	content: string;
	timestamp?: string;
	name?: string;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

export interface AgentStateInstance {
	input_value: string;
	output: string | null;
	start_time: string;
	end_time: string | null;
	status: string;
	messages: AgentStateMessage[];
	tool_history: {
		tool_name: string;
		tool_args?: Record<string, unknown>;
		execution_result: string;
		timestamp: string;
	}[];
	workflow_instance_id: string | null;
	session_id: string | null;
	source?: string;
	workflow_name?: string;
	error?: string | null;
}

export interface AgentRegistryEntry {
	name: string;
	metadata: Record<string, unknown>;
}

export type DaprInspectionStateReadResult = {
	found: boolean;
	value: unknown;
	etag: string | null;
	error?: string;
};

export type DaprInspectionWorkflowService = {
	id: string;
	introspectPath: string;
};

export type DaprInspectionRuntimePort = {
	getSidecarMetadata(): Promise<{ metadata: SidecarMetadata | null; healthy: boolean }>;
	getWorkflowCapableServices(): DaprInspectionWorkflowService[];
	invokeApp(appId: string, path: string): Promise<Response>;
	readState(
		storeName: string,
		key: string,
		metadata?: Record<string, string>,
	): Promise<DaprInspectionStateReadResult>;
	agentRegistryStore(): string;
	agentRegistryTeams(): string[];
};

const DEFAULT_AGENT_REGISTRY_TEAM = "default";

export class ApplicationDaprInspectionService {
	constructor(private readonly deps: { runtime: DaprInspectionRuntimePort }) {}

	getSidecarMetadata() {
		return this.deps.runtime.getSidecarMetadata();
	}

	async getServiceHealth(): Promise<ServiceHealthEntry[]> {
		const services = this.deps.runtime.getWorkflowCapableServices();
		const results = await Promise.allSettled(
			services.map(async (service) => {
				const res = await this.deps.runtime.invokeApp(
					service.id,
					service.introspectPath,
				);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return {
					serviceId: service.id,
					data: (await res.json()) as Record<string, unknown>,
				};
			}),
		);

		return results.map((result, index) => {
			const serviceId = services[index].id;
			if (result.status === "rejected") {
				return {
					id: serviceId,
					healthy: false,
					version: "unknown",
					runtime: "unknown",
					workflowCount: 0,
					activityCount: 0,
					features: [],
					error:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason),
				};
			}

			const raw = result.value.data;
			return {
				id: serviceId,
				healthy: Boolean(raw.ready),
				version: String(raw.version || "unknown"),
				runtime: String(raw.runtime || "unknown"),
				workflowCount: Array.isArray(raw.registeredWorkflows)
					? raw.registeredWorkflows.length
					: 0,
				activityCount: Array.isArray(raw.registeredActivities)
					? raw.registeredActivities.length
					: 0,
				features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
			};
		});
	}

	getStateValue(input: {
		storeName: string;
		key: string;
		metadata?: Record<string, string>;
	}) {
		return this.deps.runtime.readState(
			input.storeName,
			input.key,
			input.metadata ?? {},
		);
	}

	async getKnownStateKeys(): Promise<KnownStateKeys> {
		const keys: KnownStateKeys = { agents: [], conversations: [] };
		const registry = await this.loadDaprAgentRegistry();

		for (const team of registry.teams) {
			keys.agents.push({
				key: registryIndexKey(team),
				label: `Dapr Agent Registry index (${team})`,
				storeName: registry.storeName,
				serviceId: "dapr-agent-registry",
				metadata: registryStateMetadata(team),
			});
		}

		for (const agent of registry.agents) {
			const meta = agent.metadata;
			const team =
				typeof meta.team === "string" ? meta.team : DEFAULT_AGENT_REGISTRY_TEAM;
			keys.agents.push({
				key:
					typeof meta.registryKey === "string"
						? meta.registryKey
						: agentRegistryKey(team, agent.name),
				label: `${agent.name} (registry record)`,
				storeName: registry.storeName,
				serviceId: typeof meta.appId === "string" ? meta.appId : agent.name,
				metadata: registryStateMetadata(team),
			});

			if (
				typeof meta.storeName === "string" &&
				typeof meta.stateKey === "string"
			) {
				keys.agents.push({
					key: meta.stateKey,
					label: `${agent.name} (execution state)`,
					storeName: meta.storeName,
					serviceId: typeof meta.appId === "string" ? meta.appId : agent.name,
				});
			}
		}

		return keys;
	}

	async getWorkflowSummary() {
		let instances: WorkflowInstance[] = [];
		let orchestratorError: string | undefined;
		const registrations = await this.loadWorkflowRegistrations();

		try {
			const res = await this.deps.runtime.invokeApp(
				"workflow-orchestrator",
				"/api/v2/workflows?limit=100",
			);
			if (res.ok) {
				const data = await res.json();
				instances = (
					Array.isArray(data) ? data : data.workflows || []
				) as WorkflowInstance[];
			} else {
				const detail = await res.text();
				orchestratorError = `Orchestrator returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
			}
		} catch (err) {
			orchestratorError =
				err instanceof Error ? err.message : "Orchestrator unreachable";
		}

		const summary = {
			running: 0,
			completed: 0,
			failed: 0,
			total: instances.length,
		};

		for (const inst of instances) {
			const status = (inst.runtimeStatus || inst.status || "").toUpperCase();
			if (status === "RUNNING" || status === "SUSPENDED" || status === "PENDING") {
				summary.running++;
			} else if (status === "COMPLETED" || status === "SUCCESS") {
				summary.completed++;
			} else if (status === "FAILED" || status === "ERROR") {
				summary.failed++;
			}
		}

		return {
			summary,
			instances: instances.slice(0, 50),
			registrations,
			orchestratorError,
			discovery: {
				registrations:
					"Registered workflows are discovered from workflow-capable services via Dapr service invocation to their runtime introspection endpoints.",
				executions:
					"Workflow executions are queried from workflow-orchestrator through Dapr service invocation; workflow-orchestrator reads the Dapr workflow TaskHub instance state.",
			},
		};
	}

	async getWorkflowHistory(instanceId: string) {
		try {
			const res = await this.deps.runtime.invokeApp(
				"workflow-orchestrator",
				`/api/v2/workflows/${encodeURIComponent(instanceId)}/history`,
			);
			if (!res.ok) {
				return {
					events: [] as WorkflowHistoryEvent[],
					error: `HTTP ${res.status}`,
				};
			}
			const data = await res.json();
			return { events: (data.events || []) as WorkflowHistoryEvent[] };
		} catch (err) {
			return {
				events: [] as WorkflowHistoryEvent[],
				error: err instanceof Error ? err.message : "Failed to fetch history",
			};
		}
	}

	async getAgentRegistry() {
		const registry = await this.loadDaprAgentRegistry();
		return {
			...registry,
			discovery: {
				definitions:
					"Agent definitions are discovered from the Dapr Agent Registry state store index and agent records.",
				executions:
					"Agent executions are read from Dapr-owned agent instance endpoints or from Dapr state keys declared in each registry record. Dapr state stores do not provide a portable key scan API, so each agent must publish a deterministic execution listing contract.",
			},
		};
	}

	async getAgentDaprState(input: {
		agentName: string;
		storeName?: string | null;
		stateKey?: string | null;
		appId?: string | null;
		instancesEndpoint?: string | null;
	}) {
		if (input.appId && input.instancesEndpoint) {
			return this.readDaprAgentStateViaService(
				input.appId,
				input.agentName,
				input.instancesEndpoint,
			);
		}
		if (!input.storeName || !input.stateKey) {
			return {
				source: "dapr-state" as const,
				storeName: input.storeName ?? "",
				agentName: input.agentName,
				stateKey: input.stateKey ?? "",
				found: false,
				error:
					"This agent registry record does not declare metadata.instancesEndpoint or metadata.stateStore plus metadata.stateKey, so executions cannot be enumerated deterministically from Dapr state.",
				instances: {} as Record<string, AgentStateInstance>,
			};
		}
		return this.readDaprAgentState(input.storeName, input.agentName, input.stateKey);
	}

	private async loadWorkflowRegistrations(): Promise<WorkflowRegistration[]> {
		const services = this.deps.runtime.getWorkflowCapableServices();
		const results = await Promise.allSettled(
			services.map(async (service) => {
				const res = await this.deps.runtime.invokeApp(
					service.id,
					service.introspectPath,
				);
				if (!res.ok) return [];
				const raw = (await res.json()) as Record<string, unknown>;
				return normalizeWorkflowRegistrations(
					service.id,
					raw.registeredWorkflows,
				);
			}),
		);

		return results.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		);
	}

	private async loadDaprAgentRegistry(): Promise<{
		agents: AgentRegistryEntry[];
		storeName: string;
		teams: string[];
		diagnostics: string[];
	}> {
		const storeName = this.deps.runtime.agentRegistryStore();
		const teams = this.deps.runtime.agentRegistryTeams();
		const agents: AgentRegistryEntry[] = [];
		const diagnostics: string[] = [];

		for (const team of teams) {
			const indexKey = registryIndexKey(team);
			const index = await this.deps.runtime.readState(
				storeName,
				indexKey,
				registryStateMetadata(team),
			);
			if (!index.found) {
				diagnostics.push(
					`No Dapr agent registry index found at ${storeName}/${indexKey}${index.error ? `: ${index.error}` : ""}`,
				);
				continue;
			}

			const agentNames = asStringArray(asRecord(index.value).agents);
			if (!agentNames.length) {
				diagnostics.push(
					`Dapr agent registry index ${storeName}/${indexKey} has no agent entries`,
				);
				continue;
			}

			for (const agentName of Array.from(new Set(agentNames)).sort((a, b) =>
				a.localeCompare(b),
			)) {
				const key = agentRegistryKey(team, agentName);
				const state = await this.deps.runtime.readState(
					storeName,
					key,
					registryStateMetadata(team),
				);
				if (!state.found) {
					diagnostics.push(
						`Registry index references missing agent key ${storeName}/${key}`,
					);
					continue;
				}

				const record = asRecord(state.value);
				const agent = asRecord(record.agent);
				const agentMetadata = asRecord(agent.metadata);
				const stateStore = metadataString(
					agentMetadata,
					"stateStore",
					"state_store",
					"state_store_name",
				);
				const stateKey = metadataString(agentMetadata, "stateKey", "state_key");
				const stateKeyPrefix = metadataString(
					agentMetadata,
					"stateKeyPrefix",
					"state_key_prefix",
				);
				const instancesEndpoint = metadataString(
					agentMetadata,
					"instancesEndpoint",
					"instances_endpoint",
				);
				const appId = asString(agent.appid);
				const instanceCount =
					appId && instancesEndpoint
						? await this.countDaprAgentInstancesViaService(
								appId,
								agentName,
								instancesEndpoint,
							)
						: stateStore && stateKey
							? await this.countDaprAgentInstances(stateStore, agentName, stateKey)
							: null;

				agents.push({
					name: asString(record.name) ?? agentName,
					metadata: {
						source: "dapr-agent-registry",
						team,
						registryStore: storeName,
						registryKey: key,
						schemaVersion: asString(record.version),
						registeredAt: asString(record.registered_at),
						appId,
						type: asString(agent.type),
						framework: asString(agent.framework),
						role: asString(agent.role),
						goal: asString(agent.goal),
						...(stateStore ? { storeName: stateStore } : {}),
						...(stateKey ? { stateKey } : {}),
						...(stateKeyPrefix ? { stateKeyPrefix } : {}),
						...(instancesEndpoint ? { instancesEndpoint } : {}),
						...(instanceCount != null ? { instanceCount } : {}),
						registryRecord: record,
					},
				});
			}
		}

		return { agents, storeName, teams, diagnostics };
	}

	private async countDaprAgentInstances(
		storeName: string,
		agentName: string,
		stateKey: string,
	): Promise<number> {
		const state = await this.readDaprAgentState(storeName, agentName, stateKey);
		return Object.keys(state.instances).length;
	}

	private async countDaprAgentInstancesViaService(
		appId: string,
		agentName: string,
		instancesEndpoint: string,
	): Promise<number> {
		const state = await this.readDaprAgentStateViaService(
			appId,
			agentName,
			instancesEndpoint,
		);
		return Object.keys(state.instances).length;
	}

	private async readDaprAgentStateViaService(
		appId: string,
		agentName: string,
		instancesEndpoint: string,
	): Promise<{
		source: "dapr-state";
		storeName: string;
		agentName: string;
		stateKey: string;
		found: boolean;
		error?: string;
		instances: Record<string, AgentStateInstance>;
	}> {
		const res = await this.deps.runtime.invokeApp(
			appId,
			`${instancesEndpoint.replace(/^\//, "")}?limit=200`,
		);
		if (!res.ok) {
			return {
				source: "dapr-state",
				storeName: "",
				agentName,
				stateKey: instancesEndpoint,
				found: false,
				error: `Agent ${appId} returned HTTP ${res.status} from ${instancesEndpoint}`,
				instances: {},
			};
		}
		const payload = (await res.json()) as {
			storeName?: string;
			stateKey?: string;
			found?: boolean;
			instances?: Record<string, unknown>;
			error?: string;
		};
		const instances: Record<string, AgentStateInstance> = {};
		for (const [instanceId, instance] of Object.entries(payload.instances ?? {})) {
			const normalized = normalizeDaprAgentInstance(agentName, instanceId, instance);
			if (normalized) instances[instanceId] = normalized;
		}
		return {
			source: "dapr-state",
			storeName: payload.storeName ?? "",
			agentName,
			stateKey: payload.stateKey ?? instancesEndpoint,
			found: payload.found ?? Object.keys(instances).length > 0,
			...(payload.error ? { error: payload.error } : {}),
			instances,
		};
	}

	private async readDaprAgentState(
		storeName: string,
		agentName: string,
		stateKey: string,
	): Promise<{
		source: "dapr-state";
		storeName: string;
		agentName: string;
		stateKey: string;
		found: boolean;
		error?: string;
		instances: Record<string, AgentStateInstance>;
	}> {
		const result = await this.deps.runtime.readState(storeName, stateKey);
		const rawInstances = asRecord(asRecord(result.value).instances);
		const instances: Record<string, AgentStateInstance> = {};

		for (const [instanceId, instance] of Object.entries(rawInstances)) {
			const normalized = normalizeDaprAgentInstance(
				agentName,
				instanceId,
				instance,
			);
			if (normalized) instances[instanceId] = normalized;
		}

		return {
			source: "dapr-state",
			storeName,
			agentName,
			stateKey,
			found: result.found,
			...(result.error ? { error: result.error } : {}),
			instances,
		};
	}
}

function normalizeWorkflowRegistrations(
	serviceId: string,
	value: unknown,
): WorkflowRegistration[] {
	const records = Array.isArray(value) ? value : [];
	return records.map((record, index) => {
		if (typeof record === "string") {
			return { serviceId, name: record };
		}
		const item = asRecord(record);
		const name =
			asString(item.name) ??
			asString(item.workflowName) ??
			asString(item.id) ??
			`workflow-${index + 1}`;
		const version =
			asString(item.version) ?? asString(item.workflowVersion) ?? undefined;
		return { serviceId, name, ...(version ? { version } : {}), metadata: item };
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			)
		: [];
}

function teamRegistryKey(team: string): string {
	return `agents:${team}`;
}

function registryIndexKey(team: string): string {
	return `${teamRegistryKey(team)}:_index`;
}

function agentRegistryKey(team: string, agentName: string): string {
	return `${teamRegistryKey(team)}:${agentName}`;
}

function metadataString(
	record: Record<string, unknown>,
	...keys: string[]
): string | null {
	for (const key of keys) {
		const value = asString(record[key]);
		if (value) return value;
	}
	return null;
}

function registryStateMetadata(team: string): Record<string, string> {
	return { partitionKey: teamRegistryKey(team) };
}

function isAgentStateInstance(value: unknown): value is AgentStateInstance {
	const record = asRecord(value);
	return Array.isArray(record.messages) && Array.isArray(record.tool_history);
}

function normalizeDaprAgentInstance(
	agentName: string,
	instanceId: string,
	value: unknown,
): AgentStateInstance | null {
	if (!isAgentStateInstance(value)) return null;
	return {
		...value,
		workflow_instance_id: value.workflow_instance_id ?? instanceId,
		workflow_name: value.workflow_name ?? agentName,
		source: value.source ?? "dapr-state",
	};
}
