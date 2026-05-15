import { createHash } from "node:crypto";
import { desc, eq, and } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import { sessionEvents } from "$lib/server/db/schema";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { resolveSessionRuntimeTarget } from "$lib/server/sessions/runtime-target";
import { getSession } from "$lib/server/sessions/registry";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";
import type { SessionDetail } from "$lib/types/sessions";

export const RUNTIME_CONFIG_SESSION_EVENT_TYPE = "session.runtime_config";
export const RUNTIME_CONFIG_CLOUDEVENT_TYPE =
	"io.workflow-builder.session.runtime_config.v1";

export type RuntimeConfigCloudEvent = {
	specversion: "1.0";
	id: string;
	source: string;
	type: typeof RUNTIME_CONFIG_CLOUDEVENT_TYPE;
	subject: string;
	datacontenttype: "application/json";
	dataschema?: string;
	traceparent?: string;
	data: {
		schemaVersion: "workflow-builder.agent_runtime_config.v1";
		source: "memory" | "state" | "event" | "settings";
		sessionId: string;
		instanceId: string;
		turn: number;
		configRevision: number;
		configHash: string;
		agent: Record<string, unknown>;
		llm: Record<string, unknown>;
		execution: Record<string, unknown>;
		tools: Record<string, unknown>;
		mcp: Record<string, unknown>;
		skills: unknown[];
		instructions: Record<string, unknown>;
		mlflow: Record<string, unknown>;
		dapr: Record<string, unknown>;
		attributes: Record<string, unknown>;
	};
};

export async function getSessionRuntimeConfig(
	sessionId: string,
): Promise<RuntimeConfigCloudEvent | null> {
	const session = await getSession(sessionId);
	if (!session) return null;
	const instanceId = session.daprInstanceId ?? session.id;

	const live = await readLiveRuntimeConfig(session, instanceId);
	if (live) return withRuntimeConfigSource(live, "memory");

	const state = await readDaprRuntimeConfigSnapshot(instanceId);
	if (state) return withRuntimeConfigSource(state, "state");

	const latestEvent = await readLatestRuntimeConfigEvent(session.id);
	if (latestEvent) return withRuntimeConfigSource(latestEvent, "event");

	return withRuntimeConfigSource(
		await buildSettingsRuntimeConfigEvent(session),
		"settings",
	);
}

async function readLiveRuntimeConfig(
	session: SessionDetail,
	instanceId: string,
): Promise<RuntimeConfigCloudEvent | null> {
	const target = await resolveSessionRuntimeTarget(session.id);
	if (!target) return null;
	const path = `/internal/runtime/instances/${encodeURIComponent(instanceId)}/config`;
	let response: Response;
	try {
		if (target.runtimeSandboxName || target.appId.startsWith("agent-session-")) {
			const ready = await waitForAgentWorkflowHostAppReady({
				agentAppId: target.appId,
				timeoutSeconds: 2,
			});
			response = await fetchWithTimeout(`${ready.baseUrl}${path}`, {}, 2000);
		} else {
			response = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(target.invokeTarget)}/method${path}`,
				{ maxRetries: 0 },
			);
		}
		if (!response.ok) return null;
		return coerceRuntimeConfigEvent(await response.json().catch(() => null));
	} catch {
		return null;
	}
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function runtimeConfigStateStores(): string[] {
	return [
		env.RUNTIME_CONFIG_STATE_STORE,
		env.AGENT_STATE_STORE,
		env.DAPR_AGENT_STATESTORE,
		"dapr-agent-py-statestore",
	].filter((value, index, arr): value is string => {
		const text = value?.trim();
		return Boolean(text) && arr.findIndex((item) => item?.trim() === text) === index;
	});
}

async function readDaprRuntimeConfigSnapshot(
	instanceId: string,
): Promise<RuntimeConfigCloudEvent | null> {
	const key = `runtime-config:${instanceId}`;
	const encodedKey = encodeURIComponent(key);
	for (const store of runtimeConfigStateStores()) {
		try {
			const response = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/state/${encodeURIComponent(store)}/${encodedKey}?metadata.partitionKey=${encodedKey}`,
				{ maxRetries: 0 },
			);
			if (!response.ok) continue;
			const raw = await response.text();
			if (!raw.trim()) continue;
			const parsed = parsePossiblyStringifiedJson(raw);
			const event = coerceRuntimeConfigEvent(parsed);
			if (event) return event;
		} catch {
			/* try next store */
		}
	}
	return null;
}

async function readLatestRuntimeConfigEvent(
	sessionId: string,
): Promise<RuntimeConfigCloudEvent | null> {
	if (!db) return null;
	const [row] = await db
		.select({ data: sessionEvents.data })
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				eq(sessionEvents.type, RUNTIME_CONFIG_SESSION_EVENT_TYPE),
			),
		)
		.orderBy(desc(sessionEvents.sequence))
		.limit(1);
	return coerceRuntimeConfigEvent(row?.data);
}

async function buildSettingsRuntimeConfigEvent(
	session: SessionDetail,
): Promise<RuntimeConfigCloudEvent> {
	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	const config: Record<string, unknown> = isRecord(agent?.config)
		? agent.config
		: {};
	const runtimeAppId =
		session.runtimeAppId ??
		agent?.runtimeAppId ??
		(session.agentSlug ? `agent-runtime-${session.agentSlug}` : "dapr-agent-py");
	const llm = compactRecord({
		modelSpec: stringOrNull(config.modelSpec),
		providerModel: stringOrNull(config.providerModel),
	});
	const tools = compactRecord({
		allowedTools: stringArray(config.tools ?? config.allowedTools),
		builtinTools: stringArray(config.builtinTools),
	});
	const mcpServers = sanitizeMcpServers(config.mcpServers);
	const mcp = compactRecord({
		scope: "settings",
		serverCount: mcpServers.length,
		servers: mcpServers,
		configHash: mcpServers.length > 0 ? stableHash(mcpServers) : null,
	});
	const skills = stringArray(config.skills).map((name) => ({ name }));
	const instructions = compactRecord({
		systemPromptHash: stringOrNull(config.systemPrompt)
			? stableHash(config.systemPrompt)
			: null,
		promptPresetManifestHash: Array.isArray(config.promptPresetManifest)
			? stableHash(config.promptPresetManifest)
			: null,
	});
	const data: RuntimeConfigCloudEvent["data"] = {
		schemaVersion: "workflow-builder.agent_runtime_config.v1" as const,
		source: "settings" as const,
		sessionId: session.id,
		instanceId: session.daprInstanceId ?? session.id,
		turn: 0,
		configRevision: 0,
		configHash: stableHash({
			agentId: session.agentId,
			agentVersion: session.agentVersion,
			llm,
			tools,
			mcp,
			skills,
			instructions,
		}),
		agent: compactRecord({
			id: session.agentId,
			version: session.agentVersion,
			slug: session.agentSlug ?? agent?.slug,
			appid: runtimeAppId,
			runtime: config.runtime,
		}),
		llm,
		execution: compactRecord({
			sandboxName: session.workspaceSandboxName ?? session.sandboxName,
			permissionMode: config.permissionMode,
			maxTurns: config.maxTurns,
		}),
		tools,
		mcp,
		skills,
		instructions,
		mlflow: compactRecord({
			experimentId: session.mlflowExperimentId,
			runId: session.mlflowRunId,
			parentRunId: session.mlflowParentRunId,
			mlflowSessionId: session.mlflowSessionId ?? session.id,
			activeModelId: agent?.mlflowModelVersion,
			activeModelName: agent?.mlflowModelName,
			activeModelUri: agent?.mlflowUri,
		}),
		dapr: compactRecord({
			appId: runtimeAppId,
			workflowInstanceId: session.daprInstanceId ?? session.id,
		}),
		attributes: {},
	};
	data.attributes = compactRecord({
		"gen_ai.provider.name": inferProviderFromModel(
			String(data.llm.modelSpec ?? data.llm.providerModel ?? ""),
		),
		"gen_ai.request.model": data.llm.modelSpec ?? data.llm.providerModel,
		"gen_ai.operation.name": "chat",
		"openinference.span.kind": "LLM",
		"agent.id": data.agent.id,
		"agent.version": data.agent.version,
		"dapr.app_id": runtimeAppId,
		"dapr.workflow.instance_id": data.instanceId,
		"workflow.execution.id": session.workflowExecutionId,
		"session.id": session.id,
		"agent.session.id": session.id,
		"mlflow.run_id": session.mlflowRunId,
	});
	return {
		specversion: "1.0",
		id: `session:${session.id}:${data.instanceId}:turn:0:runtime_config:${data.configHash}`,
		source: `urn:workflow-builder:agent-runtime:${runtimeAppId}`,
		type: RUNTIME_CONFIG_CLOUDEVENT_TYPE,
		subject: `sessions/${session.id}/turns/0`,
		datacontenttype: "application/json",
		dataschema: "urn:workflow-builder:schema:agent-runtime-config:v1",
		data,
	};
}

function withRuntimeConfigSource(
	event: RuntimeConfigCloudEvent,
	source: RuntimeConfigCloudEvent["data"]["source"],
): RuntimeConfigCloudEvent {
	return {
		...event,
		data: {
			...event.data,
			source,
		},
	};
}

function coerceRuntimeConfigEvent(value: unknown): RuntimeConfigCloudEvent | null {
	const parsed = parsePossiblyStringifiedJson(value);
	if (!isRecord(parsed)) return null;
	if (
		parsed.specversion !== "1.0" ||
		typeof parsed.id !== "string" ||
		parsed.type !== RUNTIME_CONFIG_CLOUDEVENT_TYPE ||
		!isRecord(parsed.data)
	) {
		return null;
	}
	return parsed as RuntimeConfigCloudEvent;
}

function parsePossiblyStringifiedJson(value: unknown): unknown {
	let parsed = value;
	while (typeof parsed === "string") {
		const text = parsed.trim();
		if (!text) return parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return parsed;
		}
	}
	return parsed;
}

function sanitizeMcpServers(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value
		.filter(isRecord)
		.map((server, index) => {
			const allowedTools = stringArray(
				server.allowedTools ?? server.allowed_tools,
			);
			return compactRecord({
				serverName:
					stringOrNull(server.serverName) ??
					stringOrNull(server.name) ??
					stringOrNull(server.displayName) ??
					`mcp_server_${index + 1}`,
				transport: stringOrNull(server.transport) ?? stringOrNull(server.type),
				toolNames: allowedTools,
				configHash: stableHash({
					serverName:
						server.serverName ?? server.name ?? server.displayName ?? index,
					transport: server.transport ?? server.type ?? null,
					allowedTools,
				}),
				auth:
					server.connectionExternalId || server.headers
						? "external_reference"
						: null,
			});
		});
}

function inferProviderFromModel(model: string): string | null {
	if (!model) return null;
	const [provider] = model.split("/", 1);
	return provider || null;
}

function stableHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, inner]) => inner !== undefined && inner !== null)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, canonical(inner)]),
		);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => {
			if (entry === null || entry === undefined || entry === "") return false;
			if (Array.isArray(entry) && entry.length === 0) return false;
			return true;
		}),
	) as T;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}
