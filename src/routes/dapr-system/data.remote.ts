import { query } from '$app/server';
import {
	daprFetch,
	getDaprSidecarUrl,
	getDurableAgentUrl,
	getOrchestratorUrl,
	getWorkflowCapableServices
} from '$lib/server/dapr-client';
import { db } from '$lib/server/db';
import {
	workflowExecutions,
	workflows,
	workflowExecutionLogs,
	workflowAgentRuns,
	workflowAgentEvents
} from '$lib/server/db/schema';
import { desc, eq, isNotNull, and, asc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaprComponent {
	name: string;
	type: string;
	version: string;
	capabilities?: string[];
}

interface DaprSubscription {
	pubsubname: string;
	topic: string;
	route?: string;
	routes?: { rules?: { path: string; match?: string }[]; default?: string };
}

interface SidecarMetadata {
	id: string;
	runtimeVersion: string;
	enabledFeatures: string[];
	components: DaprComponent[];
	subscriptions: DaprSubscription[];
	httpEndpoints: unknown[];
	appConnectionProperties: Record<string, unknown>;
}

interface ServiceHealthEntry {
	id: string;
	healthy: boolean;
	version: string;
	runtime: string;
	workflowCount: number;
	activityCount: number;
	features: string[];
	error?: string;
}

interface WorkflowInstance {
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

interface WorkflowHistoryEvent {
	eventId?: number;
	eventType: string;
	timestamp?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
}

interface KnownStateKeys {
	agents: { key: string; label: string; storeName: string; serviceId: string }[];
	conversations: { key: string; label: string; storeName: string; serviceId: string }[];
}

// ---------------------------------------------------------------------------
// Helpers — cross-service state access via Dapr service invocation
// ---------------------------------------------------------------------------

/** Read a state key via the local Dapr sidecar. */
async function readStateLocal(
	storeName: string,
	key: string
): Promise<{ found: boolean; value: unknown; etag: string | null; error?: string }> {
	const sidecarUrl = getDaprSidecarUrl();
	try {
		const res = await daprFetch(
			`${sidecarUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(key)}?consistency=strong`,
			{ maxRetries: 1 }
		);
		if (res.status === 204 || res.status === 404) {
			return { found: false, value: null, etag: null };
		}
		if (!res.ok) {
			return { found: false, value: null, etag: null, error: `HTTP ${res.status} — store "${storeName}" may not be in scope for this app's sidecar.` };
		}
		const rawText = await res.text();
		const etag = res.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '') ?? null;
		let value: unknown;
		try { value = JSON.parse(rawText); } catch { value = rawText; }
		return { found: true, value, etag };
	} catch (err) {
		return { found: false, value: null, etag: null, error: err instanceof Error ? err.message : 'Sidecar unreachable' };
	}
}

/**
 * Fetch the durable-agent's introspect data which includes agent registry info.
 */
async function fetchDurableAgentIntrospect(): Promise<Record<string, unknown> | null> {
	try {
		const durableAgentUrl = getDurableAgentUrl();
		const res = await daprFetch(`${durableAgentUrl}/api/runtime/introspect`, { maxRetries: 1 });
		if (res.ok) return (await res.json()) as Record<string, unknown>;
	} catch {
		// try via Dapr service invocation as fallback
		try {
			const sidecarUrl = getDaprSidecarUrl();
			const res = await daprFetch(
				`${sidecarUrl}/v1.0/invoke/durable-agent/method/api/runtime/introspect`,
				{ maxRetries: 1 }
			);
			if (res.ok) return (await res.json()) as Record<string, unknown>;
		} catch {
			// unavailable
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tab 1: Overview
// ---------------------------------------------------------------------------

export const getSidecarMetadata = query(async () => {
	const sidecarUrl = getDaprSidecarUrl();
	let metadata: SidecarMetadata | null = null;
	let healthy = false;

	try {
		const [metaRes, healthRes] = await Promise.allSettled([
			daprFetch(`${sidecarUrl}/v1.0/metadata`, { maxRetries: 1 }),
			daprFetch(`${sidecarUrl}/v1.0/healthz`, { maxRetries: 1 })
		]);

		if (metaRes.status === 'fulfilled' && metaRes.value.ok) {
			metadata = (await metaRes.value.json()) as SidecarMetadata;
		}
		healthy = healthRes.status === 'fulfilled' && healthRes.value.ok;
	} catch {
		// sidecar unavailable
	}

	return { metadata, healthy };
});

export const getServiceHealth = query(async () => {
	const services = getWorkflowCapableServices();

	const results = await Promise.allSettled(
		services.map(async (svc) => {
			const endpoint = `${svc.getBaseUrl()}${svc.introspectPath}`;
			const res = await daprFetch(endpoint, { maxRetries: 1 });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { serviceId: svc.id, data: (await res.json()) as Record<string, unknown> };
		})
	);

	const entries: ServiceHealthEntry[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const serviceId = services[i].id;

		if (result.status === 'rejected') {
			entries.push({
				id: serviceId,
				healthy: false,
				version: 'unknown',
				runtime: 'unknown',
				workflowCount: 0,
				activityCount: 0,
				features: [],
				error: result.reason instanceof Error ? result.reason.message : String(result.reason)
			});
			continue;
		}

		const raw = result.value.data;
		entries.push({
			id: serviceId,
			healthy: Boolean(raw.ready),
			version: String(raw.version || 'unknown'),
			runtime: String(raw.runtime || 'unknown'),
			workflowCount: Array.isArray(raw.registeredWorkflows)
				? raw.registeredWorkflows.length
				: 0,
			activityCount: Array.isArray(raw.registeredActivities)
				? raw.registeredActivities.length
				: 0,
			features: Array.isArray(raw.features) ? (raw.features as string[]) : []
		});
	}

	return entries;
});

// ---------------------------------------------------------------------------
// Tab 2: State Inspector
// ---------------------------------------------------------------------------

export const getStateValue = query(
	'unchecked',
	async ({ storeName, key }: { storeName: string; key: string }) => {
		return await readStateLocal(storeName, key);
	}
);

export const getKnownStateKeys = query(async () => {
	const sidecarUrl = getDaprSidecarUrl();
	const keys: KnownStateKeys = { agents: [], conversations: [] };

	// Get the durable-agent's state store name from introspect
	const introspect = await fetchDurableAgentIntrospect();
	const introspectAdditional = introspect?.additional as { stateStoreName?: string } | undefined;
	const agentStoreName = introspectAdditional?.stateStoreName || 'workflowstatestore';

	// Probe for known agent state keys by checking well-known agent names
	// Agent names come from service app-ids that run durable-agent workflows
	const knownAgentNames = ['durable-dev-agent', 'claude-code-agent', 'openshell-agent'];

	// Also get agent names from registry if available
	const registry = introspect?.registry as { registeredAgents?: { name: string }[] } | undefined;
	if (registry?.registeredAgents?.length) {
		for (const agent of registry.registeredAgents) {
			if (!knownAgentNames.includes(agent.name)) {
				knownAgentNames.push(agent.name);
			}
		}
	}

	// Probe each agent name — check state (bare name and :workflow_state suffix) and conversations
	const probeResults = await Promise.allSettled(
		knownAgentNames.flatMap((agentName) => [
			// Probe agent state (bare name — claude-code-agent pattern)
			daprFetch(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(agentStoreName)}/${encodeURIComponent(agentName)}?consistency=strong`,
				{ maxRetries: 0 }
			).then((res) => ({ agentName, type: 'state' as const, key: agentName, found: res.ok && res.status !== 204 })),
			// Probe agent state (:workflow_state suffix — durable-dev-agent pattern)
			daprFetch(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(agentStoreName)}/${encodeURIComponent(`${agentName}:workflow_state`)}?consistency=strong`,
				{ maxRetries: 0 }
			).then((res) => ({ agentName, type: 'state' as const, key: `${agentName}:workflow_state`, found: res.ok && res.status !== 204 })),
			// Probe global conversation
			daprFetch(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(agentStoreName)}/${encodeURIComponent(`conversation:${agentName}`)}?consistency=strong`,
				{ maxRetries: 0 }
			).then((res) => ({ agentName, type: 'conversation' as const, key: `conversation:${agentName}`, found: res.ok && res.status !== 204 })),
		])
	);

	const discoveredAgents = new Set<string>();
	for (const result of probeResults) {
		if (result.status !== 'fulfilled' || !result.value.found) continue;
		const { agentName, type, key: stateKey } = result.value;
		discoveredAgents.add(agentName);
		if (type === 'state') {
			keys.agents.push({ key: stateKey, label: `${agentName} (state)`, storeName: agentStoreName, serviceId: 'durable-agent' });
		}
		if (type === 'conversation') {
			keys.conversations.push({
				key: stateKey,
				label: `${agentName} (conversation)`,
				storeName: agentStoreName,
				serviceId: 'durable-agent'
			});
		}
	}

	// Probe recent DB execution IDs as per-run conversation keys.
	// Per-run conversation keys follow: conversation:{agentName}:{daprInstanceId}__{suffix}
	// The suffix is a child workflow naming pattern specific to each agent type.
	if (db && discoveredAgents.size > 0) {
		try {
			const recentExecs = await db
				.select({ daprInstanceId: workflowExecutions.daprInstanceId })
				.from(workflowExecutions)
				.where(isNotNull(workflowExecutions.daprInstanceId))
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(5);

			// Known child workflow suffixes per agent type
			const suffixMap: Record<string, string[]> = {
				'durable-dev-agent': [
					'__durable__durable_validation_run__run__0',
					'__durable__durable_recovery_run__run__0',
				],
				'claude-code-agent': [
					'__claude__claude_setup__run__0',
					'__claude__claude_prompt_build__run__0',
					'__claude__claude_finalize_push__run__0',
				],
			};

			const agentNamesDiscovered = [...discoveredAgents];

			const seen = new Set(keys.conversations.map((c) => c.key));

			// Probe all combinations in parallel
			const probes: Promise<void>[] = [];
			for (const exec of recentExecs) {
				if (!exec.daprInstanceId) continue;
				for (const agentName of agentNamesDiscovered) {
					const suffixes = suffixMap[agentName] || ['__run__0'];
					for (const suffix of suffixes) {
						const convKey = `conversation:${agentName}:${exec.daprInstanceId}${suffix}`;
						if (seen.has(convKey)) continue;
						probes.push(
							daprFetch(
								`${sidecarUrl}/v1.0/state/${encodeURIComponent(agentStoreName)}/${encodeURIComponent(convKey)}?consistency=strong`,
								{ maxRetries: 0 }
							).then((res) => {
								if (res.ok && res.status !== 204) {
									seen.add(convKey);
									const shortId = exec.daprInstanceId!.replace(/^sw-/, '').slice(0, 28) + '...';
									keys.conversations.push({
										key: convKey,
										label: shortId,
										storeName: agentStoreName,
										serviceId: 'durable-agent'
									});
								}
							}).catch(() => {})
						);
					}
				}
			}
			await Promise.allSettled(probes);
		} catch {
			// DB unavailable
		}
	}

	return keys;
});

// ---------------------------------------------------------------------------
// Tab 3: Workflows
// ---------------------------------------------------------------------------

export const getWorkflowSummary = query(async () => {
	const orchestratorUrl = getOrchestratorUrl();
	let instances: WorkflowInstance[] = [];
	let orchestratorError: string | undefined;

	// Try orchestrator first
	try {
		const res = await daprFetch(`${orchestratorUrl}/api/v2/workflows?limit=100`, {
			maxRetries: 1
		});
		if (res.ok) {
			const data = await res.json();
			instances = (Array.isArray(data) ? data : data.workflows || []) as WorkflowInstance[];
		} else {
			orchestratorError = `Orchestrator returned HTTP ${res.status}`;
		}
	} catch (err) {
		orchestratorError = err instanceof Error ? err.message : 'Orchestrator unreachable';
	}

	// Always try DB fallback if orchestrator returned nothing
	if (instances.length === 0 && db) {
		try {
			const rows = await db
				.select({
					id: workflowExecutions.id,
					instanceId: workflowExecutions.daprInstanceId,
					workflowId: workflowExecutions.workflowId,
					workflowName: workflows.name,
					status: workflowExecutions.status,
					phase: workflowExecutions.phase,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt
				})
				.from(workflowExecutions)
				.leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(100);

			instances = rows.map((r) => ({
				instanceId: r.instanceId || r.id,
				workflowId: r.workflowId ?? undefined,
				workflowName: r.workflowName ?? undefined,
				status: r.status ?? undefined,
				phase: r.phase ?? undefined,
				startedAt: r.startedAt ? r.startedAt.toISOString() : undefined,
				completedAt: r.completedAt ? r.completedAt.toISOString() : undefined
			}));
		} catch {
			// both unavailable
		}
	}

	const summary = {
		running: 0,
		completed: 0,
		failed: 0,
		total: instances.length
	};

	for (const inst of instances) {
		const s = (inst.runtimeStatus || inst.status || '').toUpperCase();
		if (s === 'RUNNING' || s === 'SUSPENDED' || s === 'PENDING') summary.running++;
		else if (s === 'COMPLETED' || s === 'SUCCESS') summary.completed++;
		else if (s === 'FAILED' || s === 'ERROR') summary.failed++;
	}

	return { summary, instances: instances.slice(0, 50), orchestratorError };
});

export const getWorkflowHistory = query('unchecked', async (instanceId: string) => {
	const orchestratorUrl = getOrchestratorUrl();
	try {
		const res = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${encodeURIComponent(instanceId)}/history`,
			{ maxRetries: 1 }
		);
		if (!res.ok) return { events: [] as WorkflowHistoryEvent[], error: `HTTP ${res.status}` };
		const data = await res.json();
		return { events: (data.events || []) as WorkflowHistoryEvent[] };
	} catch (err) {
		return {
			events: [] as WorkflowHistoryEvent[],
			error: err instanceof Error ? err.message : 'Failed to fetch history'
		};
	}
});

/**
 * Get enriched execution detail: DB logs, agent runs, agent events, and state store outputs.
 * Takes the DB execution ID (not the Dapr instance ID).
 */
export const getExecutionDetail = query('unchecked', async (daprInstanceId: string) => {
	if (!db) return { logs: [], agentRuns: [], agentEvents: [], stateOutputs: null };

	// Find the DB execution by daprInstanceId
	const [execution] = await db
		.select({ id: workflowExecutions.id, workflowId: workflowExecutions.workflowId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.daprInstanceId, daprInstanceId))
		.limit(1);

	if (!execution) return { logs: [], agentRuns: [], agentEvents: [], stateOutputs: null };

	const executionId = execution.id;

	// Fetch all in parallel
	const [logs, agentRunRows, agentEventRows] = await Promise.all([
		// Execution logs (per-node step details)
		db.select({
			nodeId: workflowExecutionLogs.nodeId,
			nodeName: workflowExecutionLogs.nodeName,
			nodeType: workflowExecutionLogs.nodeType,
			activityName: workflowExecutionLogs.activityName,
			status: workflowExecutionLogs.status,
			input: workflowExecutionLogs.input,
			output: workflowExecutionLogs.output,
			error: workflowExecutionLogs.error,
			startedAt: workflowExecutionLogs.startedAt,
			completedAt: workflowExecutionLogs.completedAt,
			duration: workflowExecutionLogs.duration,
			routedTo: workflowExecutionLogs.routedTo,
		})
			.from(workflowExecutionLogs)
			.where(eq(workflowExecutionLogs.executionId, executionId))
			.orderBy(asc(workflowExecutionLogs.startedAt)),

		// Agent runs (sub-workflow invocations)
		db.select({
			id: workflowAgentRuns.id,
			nodeId: workflowAgentRuns.nodeId,
			mode: workflowAgentRuns.mode,
			agentWorkflowId: workflowAgentRuns.agentWorkflowId,
			daprInstanceId: workflowAgentRuns.daprInstanceId,
			status: workflowAgentRuns.status,
			result: workflowAgentRuns.result,
			error: workflowAgentRuns.error,
			createdAt: workflowAgentRuns.createdAt,
			completedAt: workflowAgentRuns.completedAt,
		})
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
			.orderBy(asc(workflowAgentRuns.createdAt)),

		// Agent events (fine-grained tool/model events) - limit to most recent 50
		db.select({
			eventId: workflowAgentEvents.eventId,
			eventType: workflowAgentEvents.eventType,
			phase: workflowAgentEvents.phase,
			toolName: workflowAgentEvents.toolName,
			sandboxName: workflowAgentEvents.sandboxName,
			daprInstanceId: workflowAgentEvents.daprInstanceId,
			ts: workflowAgentEvents.ts,
		})
			.from(workflowAgentEvents)
			.where(eq(workflowAgentEvents.workflowExecutionId, executionId))
			.orderBy(desc(workflowAgentEvents.eventId))
			.limit(50),
	]);

	// Try to fetch state store outputs
	let stateOutputs: Record<string, unknown> | null = null;
	try {
		// Get workflow name for the state key
		const [wf] = await db
			.select({ name: workflows.name })
			.from(workflows)
			.where(eq(workflows.id, execution.workflowId))
			.limit(1);

		if (wf) {
			const workflowSlug = wf.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
			const stateKey = `workflow:${workflowSlug}:${workflowSlug}-exec-${executionId}:outputs`;
			const sidecarUrl = getDaprSidecarUrl();
			const res = await daprFetch(
				`${sidecarUrl}/v1.0/state/workflowstatestore/${encodeURIComponent(stateKey)}?consistency=strong`,
				{ maxRetries: 0 }
			);
			if (res.ok && res.status !== 204) {
				stateOutputs = await res.json();
			}
		}
	} catch {
		// state outputs unavailable
	}

	return {
		logs: logs.map((l) => ({
			...l,
			startedAt: l.startedAt?.toISOString(),
			completedAt: l.completedAt?.toISOString(),
		})),
		agentRuns: agentRunRows.map((r) => ({
			...r,
			createdAt: r.createdAt?.toISOString(),
			completedAt: r.completedAt?.toISOString(),
		})),
		agentEvents: agentEventRows.map((e) => ({
			...e,
			ts: e.ts?.toISOString(),
		})).reverse(), // chronological order
		stateOutputs,
	};
});

// ---------------------------------------------------------------------------
// Tab 4: Agents — fetch from durable-agent introspect endpoint
// ---------------------------------------------------------------------------

export const getAgentRegistry = query(async () => {
	const sidecarUrl = getDaprSidecarUrl();
	const introspect = await fetchDurableAgentIntrospect();
	const introspectAdditional = introspect?.additional as { stateStoreName?: string } | undefined;
	const storeName = introspectAdditional?.stateStoreName || 'workflowstatestore';

	// Check if formal registry is enabled
	const registry = introspect?.registry as {
		enabled?: boolean;
		storeName?: string;
		registeredAgents?: { name: string; metadata: Record<string, unknown> }[];
	} | undefined;

	if (registry?.registeredAgents?.length) {
		return {
			agents: registry.registeredAgents,
			storeName: registry.storeName ?? storeName
		};
	}

	// Registry disabled — discover agents by probing known agent names in state store
	// Some agents store state as {name}, others as {name}:workflow_state
	const knownAgentNames = ['durable-dev-agent', 'claude-code-agent', 'openshell-agent'];
	const discoveredAgents: { name: string; metadata: Record<string, unknown> }[] = [];

	const probes = await Promise.allSettled(
		knownAgentNames.flatMap((agentName) => [
			// Probe bare name (claude-code-agent pattern)
			daprFetch(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(agentName)}?consistency=strong`,
				{ maxRetries: 0 }
			).then(async (res) => {
				if (!res.ok || res.status === 204) return null;
				const data = await res.json();
				return { agentName, stateKey: agentName, instances: data?.instances || {} };
			}),
			// Probe :workflow_state suffix (durable-dev-agent pattern)
			daprFetch(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(`${agentName}:workflow_state`)}?consistency=strong`,
				{ maxRetries: 0 }
			).then(async (res) => {
				if (!res.ok || res.status === 204) return null;
				const data = await res.json();
				return { agentName, stateKey: `${agentName}:workflow_state`, instances: data?.instances || {} };
			}),
		])
	);

	const seen = new Set<string>();
	for (const result of probes) {
		if (result.status !== 'fulfilled' || !result.value) continue;
		const { agentName, stateKey, instances } = result.value;
		if (seen.has(agentName)) continue;
		seen.add(agentName);
		discoveredAgents.push({
			name: agentName,
			metadata: {
				source: 'state-probe',
				stateKey,
				instanceCount: Object.keys(instances).length,
				storeName
			}
		});
	}

	return { agents: discoveredAgents, storeName };
});

export const getAgentState = query('unchecked', async ({ agentName, storeName, stateKey }: { agentName: string; storeName: string; stateKey?: string }) => {
	// Agent state can be stored as bare name (claude-code-agent) or with suffix (durable-dev-agent:workflow_state)
	// Use stateKey from registry metadata if available, otherwise try both
	const key = stateKey || agentName;
	const result = await readStateLocal(storeName, key);
	if (!result.found && !stateKey) {
		// Try the :workflow_state suffix as fallback
		const altResult = await readStateLocal(storeName, `${agentName}:workflow_state`);
		if (altResult.found) return altResult.value as any;
	}
	if (!result.found) return null;
	return result.value as {
		instances: Record<
			string,
			{
				input_value: string;
				output: string | null;
				start_time: string;
				end_time: string | null;
				status: string;
				messages: { role: string; content: string; timestamp?: string }[];
				tool_history: {
					tool_name: string;
					execution_result: string;
					timestamp: string;
				}[];
				workflow_instance_id: string | null;
				session_id: string | null;
			}
		>;
	};
});

/**
 * Get detailed execution data for a specific agent instance.
 * Combines: DB agent run record, DB agent events, and Dapr child workflow history.
 */
export const getAgentInstanceDetail = query('unchecked', async (instanceId: string) => {
	const orchestratorUrl = getOrchestratorUrl();

	let agentRun: {
		id: string;
		nodeId: string;
		mode: string;
		status: string;
		agentWorkflowId: string;
		daprInstanceId: string;
		workflowExecutionId: string;
		error: string | null;
		createdAt: string | null;
		completedAt: string | null;
	} | null = null;

	let agentEvents: {
		eventId: number;
		eventType: string;
		toolName: string | null;
		sandboxName: string | null;
		phase: string | null;
		ts: string | null;
	}[] = [];

	let daprHistory: { events: unknown[] } | null = null;

	if (db) {
		// Find agent run by daprInstanceId
		const runs = await db
			.select({
				id: workflowAgentRuns.id,
				nodeId: workflowAgentRuns.nodeId,
				mode: workflowAgentRuns.mode,
				status: workflowAgentRuns.status,
				agentWorkflowId: workflowAgentRuns.agentWorkflowId,
				daprInstanceId: workflowAgentRuns.daprInstanceId,
				workflowExecutionId: workflowAgentRuns.workflowExecutionId,
				error: workflowAgentRuns.error,
				createdAt: workflowAgentRuns.createdAt,
				completedAt: workflowAgentRuns.completedAt,
			})
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.daprInstanceId, instanceId))
			.limit(1);

		if (runs.length > 0) {
			const r = runs[0];
			agentRun = {
				...r,
				createdAt: r.createdAt?.toISOString() ?? null,
				completedAt: r.completedAt?.toISOString() ?? null,
			};

			// Fetch agent events for this instance
			const events = await db
				.select({
					eventId: workflowAgentEvents.eventId,
					eventType: workflowAgentEvents.eventType,
					toolName: workflowAgentEvents.toolName,
					sandboxName: workflowAgentEvents.sandboxName,
					phase: workflowAgentEvents.phase,
					ts: workflowAgentEvents.ts,
				})
				.from(workflowAgentEvents)
				.where(eq(workflowAgentEvents.daprInstanceId, instanceId))
				.orderBy(asc(workflowAgentEvents.eventId))
				.limit(100);

			agentEvents = events.map((e) => ({
				...e,
				ts: e.ts?.toISOString() ?? null,
			}));
		}
	}

	// Fetch Dapr child workflow history
	try {
		const res = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${encodeURIComponent(instanceId)}/history`,
			{ maxRetries: 1 }
		);
		if (res.ok) {
			daprHistory = await res.json();
		}
	} catch {
		// history unavailable
	}

	return { agentRun, agentEvents, daprHistory };
});
