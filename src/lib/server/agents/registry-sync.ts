import { env } from "$env/dynamic/private";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents, agentVersions } from "$lib/server/db/schema";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import type { AgentConfig, AgentDetail } from "$lib/types/agents";
import { lookupBuiltinTool } from "./builtin-tool-catalog";
import { rewriteMcpForBrowserSidecar } from "./mcp-sidecar";
import { resolveAgentConfigMcpForProject } from "./mcp-resolution";
import {
	agentRuntimeDedicatedAppId,
	resolveAgentRuntimeRoute,
} from "./runtime-routing";
import { getRuntimeDescriptor } from "./runtime-registry";

/**
 * Dual-write: Postgres remains the source of truth for agent CRUD/versioning/
 * scoping. On publish + archive we also mirror the current version into the
 * Dapr agent registry state store (`DAPR_AGENT_REGISTRY_STORE`, default
 * `agent-registry`) so downstream Dapr Agents native features — call_agent(),
 * broadcast, team discovery — can address our agents by name.
 *
 * Key format mirrors dapr-agents/dapr_agents/agents/components.py:
 *   agents:{team}:_index      — {"agents": ["slug1", "slug2", ...]}
 *   agents:{team}:{slug}      — AgentMetadataSchema JSON blob
 *
 * Team is the workspace `projectId` (UUID). Using the UUID (not the slug)
 * survives workspace renames without leaving orphan registry entries.
 *
 * All writes are non-blocking — publish never fails because the Dapr sidecar
 * is slow or down. Errors are captured in `agents.registry_error` and the
 * UI surfaces a "Sync failed" chip with a manual resync button.
 */

export type RegistryStatus =
	| "unregistered"
	| "registered"
	| "failed"
	| "archiving"
	| "archived";

export type RegistrySyncResult = {
	status: RegistryStatus;
	syncedAt: string | null;
	error: string | null;
	team: string | null;
	key: string | null;
};

const DEFAULT_REGISTRY_STORE = "agent-registry";
const SCHEMA_VERSION = "0.12.0";
const WRITE_TIMEOUT_MS = 5000;
const INDEX_RETRY_ATTEMPTS = 5;

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export function isDualWriteEnabled(): boolean {
	const raw = (env.AGENT_REGISTRY_DUAL_WRITE ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

function registryStoreName(): string {
	return env.DAPR_AGENT_REGISTRY_STORE?.trim() || DEFAULT_REGISTRY_STORE;
}

export function teamRegistryPrefix(team: string): string {
	return `agents:${team}`;
}

export function registryIndexKey(team: string): string {
	return `${teamRegistryPrefix(team)}:_index`;
}

export function agentRegistryKey(team: string, agentSlug: string): string {
	return `${teamRegistryPrefix(team)}:${agentSlug}`;
}

function partitionKey(team: string): string {
	return teamRegistryPrefix(team);
}

function stateUrl(store: string, key: string, team: string): string {
	const url = new URL(
		`${getDaprSidecarUrl()}/v1.0/state/${encodeURIComponent(store)}/${encodeURIComponent(key)}`,
	);
	url.searchParams.set("metadata.partitionKey", partitionKey(team));
	return url.toString();
}

function bulkStateUrl(store: string): string {
	return `${getDaprSidecarUrl()}/v1.0/state/${encodeURIComponent(store)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}).catch((e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

// ---------------------------------------------------------------------------
// Metadata serialization — map our AgentConfig → AgentMetadataSchema blob
// ---------------------------------------------------------------------------

export type AgentMetadataBlob = {
	version: string;
	name: string;
	registered_at: string;
	agent: {
		appid: string;
		type: string;
		orchestrator: boolean;
		system_prompt: string;
		framework: string;
		max_iterations: number;
		tool_choice: string | null;
	};
	pubsub: null;
	memory: null;
	llm: {
		client: string;
		provider: string;
		api: string;
		model: string;
	} | null;
	tools: Array<{ name: string; description: string; args: string }>;
	registry: {
		resource_name: string;
		name: string;
	};
};

export function buildAgentMetadata(
	agent: AgentDetail,
	team: string,
): AgentMetadataBlob {
	const config: AgentConfig = agent.config;
	const runtimeRoute = resolveAgentRuntimeRoute({
		agentSlug: agent.slug,
		config,
	});

	const builtin = (config.builtinTools || []).map((name) => {
		const spec = lookupBuiltinTool(name);
		return {
			name,
			description: spec?.description ?? "",
			args: spec ? JSON.stringify(spec.args) : "{}",
		};
	});
	const mcpTools = (config.mcpServers || []).map((srv) => ({
		name: `mcp:${srv.server_name}`,
		description: srv.displayName || srv.server_name || "",
		args: "{}",
	}));

	return {
		version: SCHEMA_VERSION,
		name: agent.slug,
		registered_at: new Date().toISOString(),
		agent: {
			appid: runtimeRoute.appId,
			type: "durable",
			orchestrator: false,
			system_prompt: config.systemPrompt ?? "",
			// Framework is the agent's runtime framework, from the registry
			// (e.g. "Claude Agent SDK", "Google ADK"), not a hard-coded
			// "Dapr Agents" — claude/adk agents were previously mislabeled.
			framework:
				getRuntimeDescriptor(config.runtime)?.agentMetadataFramework ?? "Dapr Agents",
			max_iterations: typeof config.maxTurns === "number" ? config.maxTurns : 120,
			tool_choice: config.toolChoice ?? null,
		},
		pubsub: null,
		memory: null,
		llm: config.modelSpec
			? {
					client: "DaprChatClient",
					provider: "dapr",
					api: "dapr",
					model: config.modelSpec,
				}
			: null,
		tools: [...builtin, ...mcpTools],
		registry: {
			resource_name: registryStoreName(),
			name: team,
		},
	};
}

// ---------------------------------------------------------------------------
// State-store primitives
// ---------------------------------------------------------------------------

type StateReadResult = {
	status: number;
	etag: string | null;
	value: unknown;
	error?: string;
};

async function readState(
	store: string,
	key: string,
	team: string,
): Promise<StateReadResult> {
	const res = await daprFetch(stateUrl(store, key, team), {
		method: "GET",
		maxRetries: 1,
	});
	if (res.status === 204) {
		return { status: res.status, etag: null, value: null };
	}
	if (!res.ok) {
		return {
			status: res.status,
			etag: null,
			value: null,
			error: await res.text(),
		};
	}
	const etag = res.headers.get("ETag");
	const text = await res.text();
	if (!text.trim()) {
		return { status: res.status, etag, value: null };
	}
	try {
		return { status: res.status, etag, value: JSON.parse(text) };
	} catch {
		return { status: res.status, etag, value: text };
	}
}

async function saveState(
	store: string,
	team: string,
	entries: Array<{
		key: string;
		value: unknown;
		etag?: string;
		firstWrite?: boolean;
	}>,
): Promise<{ ok: boolean; status: number; error?: string }> {
	const body = entries.map((e) => ({
		key: e.key,
		value: e.value,
		// Dapr HTTP state API expects `etag` as a bare string, not
		// the { value: string } wrapper the gRPC SDK uses.
		...(e.etag ? { etag: e.etag } : {}),
		options: {
			concurrency: e.firstWrite ? "first-write" : "last-write",
			consistency: "strong",
		},
		metadata: {
			contentType: "application/json",
			partitionKey: partitionKey(team),
		},
	}));
	const res = await daprFetch(bulkStateUrl(store), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		return { ok: false, status: res.status, error: await res.text() };
	}
	return { ok: true, status: res.status };
}

async function deleteState(
	store: string,
	key: string,
	team: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
	const res = await daprFetch(stateUrl(store, key, team), { method: "DELETE" });
	if (!res.ok && res.status !== 204) {
		return { ok: false, status: res.status, error: await res.text() };
	}
	return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Index read-modify-write with ETag retry
// ---------------------------------------------------------------------------

async function updateIndex(
	store: string,
	team: string,
	mutate: (agents: string[]) => string[],
): Promise<{ ok: boolean; error?: string }> {
	const indexKey = registryIndexKey(team);
	for (let attempt = 0; attempt < INDEX_RETRY_ATTEMPTS; attempt++) {
		const current = await readState(store, indexKey, team);
		const existing = readAgentList(current.value);
		const next = uniqueSorted(mutate(existing));
		const payload = { agents: next };

		// If nothing changed, skip the write.
		if (arraysEqual(existing, next)) {
			return { ok: true };
		}

		const save = await saveState(store, team, [
			{
				key: indexKey,
				value: payload,
				etag: current.etag ?? undefined,
				firstWrite: Boolean(current.etag),
			},
		]);
		if (save.ok) return { ok: true };
		// 409 / etag conflict → retry after jitter.
		if (save.status === 409 || save.status === 412) {
			await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
			continue;
		}
		return { ok: false, error: save.error || `index save HTTP ${save.status}` };
	}
	return { ok: false, error: "index update exhausted retries" };
}

function readAgentList(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const rec = value as Record<string, unknown>;
	const list = rec.agents;
	if (!Array.isArray(list)) return [];
	return list.filter((s): s is string => typeof s === "string" && s.length > 0);
}

function uniqueSorted(xs: string[]): string[] {
	return Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

async function loadAgentForRegistry(agentId: string): Promise<
	| {
			agent: AgentDetail;
			team: string | null;
			isEphemeral: boolean;
	  }
	| null
> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	if (!row) return null;
	if (!row.currentVersionId) return null;
	const [version] = await database
		.select()
		.from(agentVersions)
		.where(eq(agentVersions.id, row.currentVersionId))
		.limit(1);
	if (!version) return null;

	const tags = Array.isArray(row.tags) ? row.tags : [];
	const isEphemeral = tags.includes("workflow-ephemeral");
	const config = version.config as unknown as AgentConfig;
	const detail: AgentDetail = {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		avatar: row.avatar ?? null,
		tags,
		runtime: row.runtime as AgentDetail["runtime"],
		currentVersion: version.version,
		currentConfigHash: version.configHash,
		modelSpec: config?.modelSpec ?? null,
		environmentId: row.environmentId ?? null,
		environmentVersion: row.environmentVersion ?? null,
		defaultVaultIds: Array.isArray(row.defaultVaultIds) ? row.defaultVaultIds : [],
		isArchived: row.isArchived,
		registryStatus:
			(row.registryStatus as AgentDetail["registryStatus"]) ?? "unregistered",
		registrySyncedAt: row.registrySyncedAt
			? row.registrySyncedAt.toISOString()
			: null,
		registryError: row.registryError ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		config,
		sourceTemplateSlug: row.sourceTemplateSlug ?? null,
		sourceTemplateVersion: row.sourceTemplateVersion ?? null,
	};
	return { agent: detail, team: row.projectId, isEphemeral };
}

async function markStatus(
	agentId: string,
	status: RegistryStatus,
	error: string | null,
	syncedAt: Date | null,
): Promise<void> {
	const database = requireDb();
	await database
		.update(agents)
		.set({
			registryStatus: status,
			registryError: error,
			registrySyncedAt: syncedAt,
		})
		.where(eq(agents.id, agentId));
}

function toResult(
	agentId: string,
	team: string | null,
	agentSlug: string | null,
	status: RegistryStatus,
	error: string | null,
	syncedAt: Date | null,
): RegistrySyncResult {
	return {
		status,
		syncedAt: syncedAt ? syncedAt.toISOString() : null,
		error,
		team,
		key:
			team && agentSlug ? agentRegistryKey(team, agentSlug) : null,
	};
}

export async function registerAgent(
	agentId: string,
): Promise<RegistrySyncResult> {
	const loaded = await loadAgentForRegistry(agentId);
	if (!loaded) {
		return toResult(agentId, null, null, "failed", "agent not found", null);
	}
	const { agent, team, isEphemeral } = loaded;

	if (isEphemeral) {
		// Ephemeral workflow-shell agents never belong in the team roster.
		return toResult(agentId, team, agent.slug, "unregistered", null, null);
	}
	if (!team) {
		const err = "agent has no project_id; cannot determine team";
		await markStatus(agentId, "failed", err, null);
		return toResult(agentId, null, agent.slug, "failed", err, null);
	}

	const store = registryStoreName();
	const blob = buildAgentMetadata(agent, team);
	const key = agentRegistryKey(team, agent.slug);

	try {
		const perAgent = await withTimeout(
			saveState(store, team, [{ key, value: blob }]),
			WRITE_TIMEOUT_MS,
			`registry save ${key}`,
		);
		if (!perAgent.ok) {
			const err = perAgent.error || `HTTP ${perAgent.status}`;
			await markStatus(agentId, "failed", err, null);
			return toResult(agentId, team, agent.slug, "failed", err, null);
		}

		const idx = await withTimeout(
			updateIndex(store, team, (names) => [...names, agent.slug]),
			WRITE_TIMEOUT_MS,
			`registry index update ${team}`,
		);
		if (!idx.ok) {
			const err = idx.error || "index update failed";
			await markStatus(agentId, "failed", err, null);
			return toResult(agentId, team, agent.slug, "failed", err, null);
		}

		const syncedAt = new Date();
		await markStatus(agentId, "registered", null, syncedAt);
		return toResult(agentId, team, agent.slug, "registered", null, syncedAt);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await markStatus(agentId, "failed", msg, null);
		return toResult(agentId, team, agent.slug, "failed", msg, null);
	}
}

export async function deregisterAgent(
	agentId: string,
): Promise<RegistrySyncResult> {
	const loaded = await loadAgentForRegistry(agentId);
	if (!loaded) {
		return toResult(agentId, null, null, "archived", null, null);
	}
	const { agent, team, isEphemeral } = loaded;
	if (isEphemeral || !team) {
		await markStatus(agentId, "archived", null, null);
		return toResult(agentId, team, agent.slug, "archived", null, null);
	}

	const store = registryStoreName();
	const key = agentRegistryKey(team, agent.slug);

	try {
		await markStatus(agentId, "archiving", null, null);
		const del = await withTimeout(
			deleteState(store, key, team),
			WRITE_TIMEOUT_MS,
			`registry delete ${key}`,
		);
		if (!del.ok) {
			const err = del.error || `HTTP ${del.status}`;
			await markStatus(agentId, "failed", err, null);
			return toResult(agentId, team, agent.slug, "failed", err, null);
		}
		const idx = await withTimeout(
			updateIndex(store, team, (names) =>
				names.filter((n) => n !== agent.slug),
			),
			WRITE_TIMEOUT_MS,
			`registry index remove ${team}`,
		);
		if (!idx.ok) {
			const err = idx.error || "index update failed";
			await markStatus(agentId, "failed", err, null);
			return toResult(agentId, team, agent.slug, "failed", err, null);
		}
		const syncedAt = new Date();
		await markStatus(agentId, "archived", null, syncedAt);
		return toResult(agentId, team, agent.slug, "archived", null, syncedAt);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await markStatus(agentId, "failed", msg, null);
		return toResult(agentId, team, agent.slug, "failed", msg, null);
	}
}

export type RegistryView = {
	status: RegistryStatus;
	syncedAt: string | null;
	error: string | null;
	team: string | null;
	key: string | null;
	store: string;
	dualWriteEnabled: boolean;
	metadata?: AgentMetadataBlob | null;
};

export async function getRegistryStatus(
	agentId: string,
	opts: { includeMetadata?: boolean } = {},
): Promise<RegistryView | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	if (!row) return null;

	const status = (row.registryStatus as RegistryStatus) ?? "unregistered";
	const team = row.projectId;
	const store = registryStoreName();
	const key = team ? agentRegistryKey(team, row.slug) : null;

	let metadata: AgentMetadataBlob | null | undefined;
	if (opts.includeMetadata && team && key) {
		try {
			const current = await withTimeout(
				readState(store, key, team),
				WRITE_TIMEOUT_MS,
				`registry read ${key}`,
			);
			if (current.value && typeof current.value === "object") {
				metadata = current.value as AgentMetadataBlob;
			} else {
				metadata = null;
			}
		} catch {
			metadata = null;
		}
	}

	return {
		status,
		syncedAt: row.registrySyncedAt ? row.registrySyncedAt.toISOString() : null,
		error: row.registryError ?? null,
		team,
		key,
		store,
		dualWriteEnabled: isDualWriteEnabled(),
		...(opts.includeMetadata ? { metadata } : {}),
	};
}

/**
 * Fire-and-mostly-forget wrapper used by publish/archive. Applies the
 * feature-flag gate and swallows any unexpected throw so the caller's
 * response isn't blocked. Errors are logged and surfaced via the DB
 * row's registry_error column.
 */
export async function safeSyncOnPublish(agentId: string): Promise<void> {
	if (!isDualWriteEnabled()) return;
	try {
		const result = await registerAgent(agentId);
		if (result.status === "failed") {
			console.warn(
				`[agent-registry] publish sync failed for ${agentId}: ${result.error}`,
			);
		}
	} catch (err) {
		console.warn(
			`[agent-registry] publish sync threw for ${agentId}:`,
			err instanceof Error ? err.message : err,
		);
	}
	// Per-agent-runtime plan: materialize / refresh the AgentRuntime CR
	// alongside the registry dual-write. Kept fire-and-forget — never blocks
	// the publish response. Controller reconciles idempotently on CR upsert.
	try {
		await syncAgentRuntimeCR(agentId);
	} catch (err) {
		console.warn(
			`[agent-runtime] publish CR sync threw for ${agentId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

export async function safeSyncOnArchive(agentId: string): Promise<void> {
	if (!isDualWriteEnabled()) return;
	try {
		const result = await deregisterAgent(agentId);
		if (result.status === "failed") {
			console.warn(
				`[agent-registry] archive sync failed for ${agentId}: ${result.error}`,
			);
		}
	} catch (err) {
		console.warn(
			`[agent-registry] archive sync threw for ${agentId}:`,
			err instanceof Error ? err.message : err,
		);
	}
	try {
		await deleteAgentRuntimeCR(agentId);
	} catch (err) {
		console.warn(
			`[agent-runtime] archive CR delete threw for ${agentId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

// ---------------------------------------------------------------------------
// AgentRuntime CR sync helpers
// ---------------------------------------------------------------------------

export async function syncAgentRuntimeCR(agentId: string): Promise<void> {
	const [kubeClient, envModule] = await Promise.all([
		import("$lib/server/kube/client"),
		import("$lib/server/db/schema").then((m) => ({
			environments: m.environments,
			environmentVersions: m.environmentVersions,
		})),
	]);

	const rows = await requireDb()
		.select({ agent: agents })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	const row = rows[0]?.agent;
	if (!row || row.isArchived) return;

	let environmentRecord: {
		id?: string;
		slug?: string;
		version?: number;
		imageTag?: string | null;
	} | null = null;
	if (row.environmentId) {
		const envRows = await requireDb()
			.select({
				env: envModule.environments,
				version: envModule.environmentVersions,
			})
			.from(envModule.environments)
			.leftJoin(
				envModule.environmentVersions,
				eq(
					envModule.environments.currentVersionId,
					envModule.environmentVersions.id,
				),
			)
			.where(eq(envModule.environments.id, row.environmentId))
			.limit(1);
		const envRow = envRows[0];
		if (envRow?.env) {
			environmentRecord = {
				id: envRow.env.id,
				slug: envRow.env.slug,
				version: envRow.version?.version,
				imageTag: envRow.version?.imageTag ?? null,
			};
		}
	}
	// Per-agent runtime image is chosen by the agent runtime, not the attached
	// workspace environment. environmentRecord.imageTag is the WORKSPACE sandbox
	// image used by workspace/profile tools, not the agent runtime image.
	const config = await loadCurrentAgentConfig(agentId);
	const resolvedConfig = config
		? await resolveAgentConfigMcpForProject(config, row.projectId)
		: null;
	const imageTag =
		resolvedConfig?.runtime === "browser-use-agent"
			? env.AGENT_RUNTIME_BROWSER_USE_DEFAULT_IMAGE ??
				"gitea-ryzen.tail286401.ts.net/giteaadmin/browser-use-agent-sandbox:latest"
			: resolvedConfig?.runtime === "adk-agent-py"
				? env.AGENT_RUNTIME_ADK_DEFAULT_IMAGE ??
					"gitea-ryzen.tail286401.ts.net/giteaadmin/adk-agent-py-sandbox:latest"
				: env.AGENT_RUNTIME_DEFAULT_IMAGE ??
					"gitea-ryzen.tail286401.ts.net/giteaadmin/dapr-agent-py-sandbox:latest";

	const rawMcpServers = (resolvedConfig?.mcpServers ?? []).map((s) => ({
		name: s.server_name ?? s.serverName ?? s.name ?? "mcp",
		transport: (s.transport ?? "streamable_http") as
			| "streamable_http"
			| "sse"
			| "stdio"
			| "websocket",
		url: s.url ?? s.serverUrl,
		command: s.command,
		args: s.args,
		headers: s.headers,
		env: s.env,
	}));

	// Detect Playwright MCP and rewrite the entry to the in-pod sidecar URL
	// (http://localhost:3100/mcp). The stdio BROWSER_PRESETS from
	// agent-mcp-picker would otherwise try to `npx @playwright/mcp@latest`
	// inside the dapr-agent-py container, which has no Chromium binary.
	// See src/lib/server/agents/mcp-sidecar.ts for the matcher + rewrite.
	const { mcpServers, useBrowserSidecar } =
		resolvedConfig?.runtime === "browser-use-agent"
			? { mcpServers: rawMcpServers, useBrowserSidecar: false }
			: rewriteMcpForBrowserSidecar(rawMcpServers, {
					runtime: resolvedConfig?.runtime,
				});
	const runtimeRoute = resolveAgentRuntimeRoute({
		agentSlug: row.slug,
		runtimeAppId: row.runtimeAppId,
		config: resolvedConfig ?? config,
		useBrowserSidecar,
	});

	// Read agent-runtime idle TTL from the environment config if present.
	// Null/undefined leaves the CR default (1800s) in place.
	let idleTtlSeconds: number | undefined;
	if (row.environmentId) {
		const cfgRows = await requireDb()
			.select({ config: envModule.environmentVersions.config })
			.from(envModule.environmentVersions)
			.leftJoin(
				envModule.environments,
				eq(envModule.environments.currentVersionId, envModule.environmentVersions.id),
			)
			.where(eq(envModule.environments.id, row.environmentId))
			.limit(1);
		const raw = cfgRows[0]?.config as
			| { agentRuntimeIdleTtlSeconds?: number }
			| undefined;
	if (
		raw &&
		typeof raw.agentRuntimeIdleTtlSeconds === "number" &&
		raw.agentRuntimeIdleTtlSeconds >= 60
	) {
		idleTtlSeconds = raw.agentRuntimeIdleTtlSeconds;
	}
	if (!idleTtlSeconds && runtimeRoute.pool?.idleTtlSeconds) {
		idleTtlSeconds = runtimeRoute.pool.idleTtlSeconds;
	}
	}

	await requireDb()
		.update(agents)
		.set({
			runtimeAppId: runtimeRoute.appId,
		})
		.where(eq(agents.id, agentId));

	// Arc 2: route browser/Playwright agents to upstream `agents.x-k8s.io`
	// `SandboxTemplate` + `SandboxWarmPool` (+ a per-slug ClusterIP Service for
	// the playwright-mcp sidecar). Non-browser agents need no per-agent
	// resources at all — Arc 1's per-session Kueue `Sandbox` handles dispatch.
	// In both cases the legacy `AgentRuntime` CR is best-effort deleted so the
	// custom Kopf controller stops reconciling a parallel Deployment.
	const isBrowserUseAgent = resolvedConfig?.runtime === "browser-use-agent";
	const needsBrowserPool = useBrowserSidecar || isBrowserUseAgent;
	const namespace = env.AGENT_RUNTIME_NAMESPACE || "workflow-builder";

	if (needsBrowserPool) {
		const { buildBrowserSandboxTemplate, buildBrowserSandboxWarmPool } =
			await import("./sandbox-warmpool-builder");
		const template = buildBrowserSandboxTemplate({
			agentSlug: runtimeRoute.slug,
			appId: runtimeRoute.appId,
			runtimeClass: runtimeRoute.runtimeClass,
			runtimeIsolation: runtimeRoute.isolation,
			namespace,
			imageTag,
			modelSpec:
				typeof config?.modelSpec === "string" ? config.modelSpec : null,
			mcpServers,
			useBrowserSidecar,
		});
		const pool = buildBrowserSandboxWarmPool({
			agentSlug: runtimeRoute.slug,
			namespace,
		});
		await kubeClient.upsertSandboxTemplate(template);
		await kubeClient.upsertSandboxWarmPool(pool);
		// Per-slug ClusterIP Service is only meaningful for Playwright-MCP
		// agents (where the BFF reaches `agent-runtime-<slug>-mcp:3100` for
		// browser-validate calls). browser-use-agent has its own internal
		// browser and exposes no MCP gateway.
		if (useBrowserSidecar) {
			await kubeClient.upsertAgentRuntimeService({
				agentSlug: runtimeRoute.slug,
				namespace,
			});
		} else {
			// Drop a stale per-slug Service if a Playwright MCP entry was
			// just removed from this agent's config.
			await kubeClient
				.deleteAgentRuntimeService(runtimeRoute.slug, namespace)
				.catch(() => {});
		}
	} else {
		// Non-browser path: ensure no orphan SandboxTemplate/WarmPool/Service
		// from a previous browser configuration linger.
		await Promise.allSettled([
			kubeClient.deleteSandboxWarmPool(
				kubeClient.browserAgentSandboxWarmPoolName(runtimeRoute.slug),
				namespace,
			),
			kubeClient.deleteSandboxTemplate(
				kubeClient.browserAgentSandboxTemplateName(runtimeRoute.slug),
				namespace,
			),
			kubeClient.deleteAgentRuntimeService(runtimeRoute.slug, namespace),
		]);
	}

	// `idleTtlSeconds` is read by environment config + drives the `reap-idle`
	// CronJob via `AGENT_RUNTIME_IDLE_TTL_SECONDS` env on the BFF, not via the
	// (deleted) AgentRuntime spec. `environmentRecord` is captured for future
	// extension (e.g., per-agent runtime image overrides). Both are referenced
	// here to keep the closure shape stable.
	void idleTtlSeconds;
	void environmentRecord;
}

async function deleteAgentRuntimeCR(agentId: string): Promise<void> {
	const rows = await requireDb()
		.select({ slug: agents.slug, runtimeAppId: agents.runtimeAppId })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	const slug = rows[0]?.slug;
	if (!slug) return;
	const runtimeAppId = rows[0]?.runtimeAppId;
	if (runtimeAppId && runtimeAppId !== agentRuntimeDedicatedAppId(slug)) return;
	const kubeClient = await import("$lib/server/kube/client");
	const namespace = env.AGENT_RUNTIME_NAMESPACE || "workflow-builder";
	await Promise.allSettled([
		kubeClient.deleteSandboxWarmPool(
			kubeClient.browserAgentSandboxWarmPoolName(slug),
			namespace,
		),
		kubeClient.deleteSandboxTemplate(
			kubeClient.browserAgentSandboxTemplateName(slug),
			namespace,
		),
		kubeClient.deleteAgentRuntimeService(slug, namespace),
	]);
}

async function loadCurrentAgentConfig(
	agentId: string,
): Promise<AgentConfig | null> {
	const rows = await requireDb()
		.select({ agent: agents })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	const row = rows[0]?.agent;
	if (!row?.currentVersionId) return null;
	const versionRows = await requireDb()
		.select({ version: agentVersions })
		.from(agentVersions)
		.where(eq(agentVersions.id, row.currentVersionId))
		.limit(1);
	return (versionRows[0]?.version?.config as AgentConfig | undefined) ?? null;
}
