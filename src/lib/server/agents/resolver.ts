import type {
	AgentConfig,
	AgentOverrides,
	AgentRef,
	ResolvedCallableAgent,
} from "$lib/types/agents";
import type {
	EnvironmentConfig,
	EnvironmentRef,
} from "$lib/types/environments";
import {
	resolveAgentRef,
	resolveCallableAgents,
	type ResolvedAgent,
} from "./registry";
import { flattenBundles } from "$lib/server/capabilities/flatten";
import {
	agentRegistryKey,
	teamRegistryPrefix,
} from "./registry-sync";
import {
	resolveEnvironmentRef,
	type ResolvedEnvironment,
} from "$lib/server/environments/registry";
import { getApplicationAdapters } from "$lib/server/application";
import type { AgentSkillHydrationRepository } from "$lib/server/application/ports";
import { hashAgentConfig } from "./config-hash";
import {
	buildInstructionBundle,
	buildOpenShellSystemPrompt,
} from "./instruction-bundle";
import {
	agentRuntimeDedicatedAppId,
	resolveAgentRuntimeRoute,
} from "./runtime-routing";
import {
	getRuntimeDescriptor,
	workspaceBackendForRuntime,
	type WorkspaceBackend,
} from "./runtime-registry";

export class AgentRefResolutionError extends Error {
	constructor(
		message: string,
		public readonly nodeId?: string,
	) {
		super(message);
		this.name = "AgentRefResolutionError";
	}
}

/**
 * Raised when two `durable/run` nodes that share a `workspaceRef` (i.e. intend to
 * share files) resolve to agents with DIFFERENT {@link WorkspaceBackend}s. Their
 * filesystems are physically distinct storage, so the shared-file handoff would
 * silently lose data — we fail fast at dispatch instead. Mix per-phase agents only
 * within one backend family (all interactive-cli, or all openshell).
 */
export class WorkspaceBackendMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceBackendMismatchError";
	}
}

/**
 * Enforce that every group of `durable/run` nodes sharing a `workspaceRef` uses a
 * single workspace backend. Nodes without a workspaceRef (no shared FS) are exempt.
 */
export function assertConsistentWorkspaceBackends(
	nodes: { taskName: string; runtime: string; workspaceRef: string }[],
): void {
	const byRef = new Map<
		string,
		{ taskName: string; runtime: string; backend: WorkspaceBackend }[]
	>();
	for (const n of nodes) {
		const backend = workspaceBackendForRuntime(n.runtime);
		const group = byRef.get(n.workspaceRef) ?? [];
		group.push({ taskName: n.taskName, runtime: n.runtime, backend });
		byRef.set(n.workspaceRef, group);
	}
	for (const [, group] of byRef) {
		const backends = new Set(group.map((g) => g.backend));
		if (backends.size > 1) {
			const detail = group
				.map((g) => `${g.taskName} (${g.runtime} → ${g.backend})`)
				.join(", ");
			throw new WorkspaceBackendMismatchError(
				`Workflow mixes agent runtimes with incompatible workspace backends on a shared workspace: ${detail}. ` +
					`Nodes that share files (same workspaceRef) must use one backend family — all interactive-cli (juicefs-shared) OR all openshell-shared. ` +
					`Select per-phase agents within a single backend family.`,
			);
		}
	}
}

type ResolveSpecAgentRefsOptions = {
	triggerData?: Record<string, unknown>;
	skillHydration?: AgentSkillHydrationRepository;
};

/**
 * Hydrate each entry of `config.skills[]` from `agent_skill_registry` so
 * the Python runtime's `_extract_skill_configs` (main.py:602-662) sees a
 * fully-populated skill. Merges the registry row's `prompt`, `allowedTools`,
 * `description`, `whenToUse`, `arguments`, `argumentHint`, `model`, and
 * `packageManifest` onto each entry, keyed by `registryId`. Fields already
 * present on the entry take precedence (so admin overrides survive).
 *
 * Mutates `config.skills` in place. Silent no-op when skills is absent or
 * empty, or when none of the entries carry a registryId.
 */
async function hydrateSkillsFromRegistry(
	config: AgentConfig,
	repository?: AgentSkillHydrationRepository,
): Promise<void> {
	const skills = (config as { skills?: unknown }).skills;
	if (!Array.isArray(skills) || skills.length === 0) return;
	const ids = new Set<string>();
	for (const item of skills) {
		if (!isRecord(item)) continue;
		const id = typeof item.registryId === "string" ? item.registryId.trim() : "";
		if (id) ids.add(id);
	}
	if (ids.size === 0) return;
	let repo = repository;
	if (!repo) {
		try {
			repo = getApplicationAdapters().agentSkillHydration;
		} catch {
			return;
		}
	}
	const rows = await repo.listAgentSkillHydrationEntries(Array.from(ids));
	const byId = new Map<string, (typeof rows)[number]>();
	for (const row of rows) byId.set(row.id, row);
	for (const item of skills) {
		if (!isRecord(item)) continue;
		const id = typeof item.registryId === "string" ? item.registryId.trim() : "";
		if (!id) continue;
		const row = byId.get(id);
		if (!row) continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.prompt !== "string" || !rec.prompt.trim()) {
			rec.prompt = row.prompt ?? "";
		}
		if (!Array.isArray(rec.allowedTools) || rec.allowedTools.length === 0) {
			rec.allowedTools = Array.isArray(row.allowedTools) ? row.allowedTools : [];
		}
		if (typeof rec.description !== "string" || !rec.description.trim()) {
			rec.description = row.description ?? "";
		}
		if (typeof rec.whenToUse !== "string" || !rec.whenToUse.trim()) {
			rec.whenToUse = row.whenToUse ?? row.description ?? "";
		}
		if (!Array.isArray(rec.arguments) || rec.arguments.length === 0) {
			rec.arguments = Array.isArray(row.arguments) ? row.arguments : [];
		}
		if (typeof rec.argumentHint !== "string" || !rec.argumentHint) {
			rec.argumentHint = row.argumentHint ?? "";
		}
		if (typeof rec.model !== "string" || !rec.model) {
			rec.model = row.model ?? "";
		}
		if (!isRecord(rec.packageManifest)) {
			rec.packageManifest = row.packageManifest ?? null;
		}
		if (typeof rec.skillName !== "string" || !rec.skillName) {
			rec.skillName = row.skillName ?? row.slug ?? "";
		}
		if (typeof rec.version !== "string" || !rec.version) {
			rec.version = row.version ?? "";
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRef(value: unknown): value is AgentRef {
	if (!isRecord(value)) return false;
	// Accept either `id` or `slug` (authoritative id is resolved later from
	// the agents table). Workflow specs authored from templates / scripts
	// often stamp only slug; we read the id from the DB at resolve time.
	const hasId = typeof value.id === "string" && value.id.trim().length > 0;
	const hasSlug = typeof value.slug === "string" && (value.slug as string).trim().length > 0;
	if (!hasId && !hasSlug) return false;
	if ("version" in value && value.version !== undefined) {
		if (typeof value.version !== "number" || !Number.isFinite(value.version)) {
			return false;
		}
	}
	return true;
}

function hasSwExpression(value: unknown): value is string {
	return typeof value === "string" && /^\s*\$\{[\s\S]*\}\s*$/.test(value);
}

function splitFallbackExpression(value: string): string[] | null {
	const match = value.match(/^\s*\$\{\s*([\s\S]*?)\s*\}\s*$/);
	if (!match) return null;
	return match[1]
		.split(/\s*\/\/\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function readTriggerPath(triggerData: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = triggerData;
	for (const part of parts) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function hasExpressionValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	return value !== null && value !== undefined;
}

function resolveTriggerExpression(
	value: string,
	triggerData: Record<string, unknown> | undefined,
	taskName: string,
): unknown {
	const fallbackParts = splitFallbackExpression(value);
	if (!fallbackParts) return value;
	if (!triggerData) {
		throw new AgentRefResolutionError(
			`Task "${taskName}" uses an agentRef expression but no trigger data was available for agent resolution.`,
			taskName,
		);
	}

	for (const part of fallbackParts) {
		const triggerPath = part.match(/^\.trigger\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/);
		if (triggerPath) {
			const resolved = readTriggerPath(triggerData, triggerPath[1]);
			if (hasExpressionValue(resolved)) return resolved;
			continue;
		}

		const stringLiteral = part.match(/^"([^"]*)"$/);
		if (stringLiteral) {
			if (stringLiteral[1].trim()) return stringLiteral[1];
			continue;
		}

		throw new AgentRefResolutionError(
			`Task "${taskName}" uses unsupported agentRef expression "${value}". Only .trigger.<field> lookups and // fallbacks are supported before agent resolution.`,
			taskName,
		);
	}

	return undefined;
}

function resolveAgentRefValue(
	value: unknown,
	triggerData: Record<string, unknown> | undefined,
	taskName: string,
): AgentRef | null {
	if (typeof value === "string") {
		const resolved = hasSwExpression(value)
			? resolveTriggerExpression(value, triggerData, taskName)
			: value;
		if (isAgentRef(resolved)) return resolved;
		if (typeof resolved === "string" && resolved.trim()) {
			return { slug: resolved.trim() } as unknown as AgentRef;
		}
		return null;
	}

	if (!isRecord(value)) return null;
	const candidate: Record<string, unknown> = { ...value };
	for (const key of ["id", "slug"] as const) {
		const raw = candidate[key];
		if (typeof raw === "string" && hasSwExpression(raw)) {
			const resolved = resolveTriggerExpression(raw, triggerData, taskName);
			if (typeof resolved === "string") {
				candidate[key] = resolved.trim();
			} else if (isAgentRef(resolved)) {
				return resolved;
			} else if (resolved !== undefined) {
				throw new AgentRefResolutionError(
					`Task "${taskName}" agentRef.${key} expression did not resolve to an agent id or slug.`,
					taskName,
				);
			}
		}
	}

	return isAgentRef(candidate) ? (candidate as AgentRef) : null;
}

/**
 * Walk an SW 1.0 spec, find every `durable/run` task, read its `with.body.agentRef`,
 * resolve the canonical AgentConfig from the registry, and inline it back into
 * `with.body.agentConfig`. Returns a deep-copied spec; does not mutate input.
 *
 * Fail-closed: any `durable/run` task without a valid agentRef throws. Post-cutover
 * every workflow must have been backfilled; a missing ref is a bug.
 */
export async function resolveSpecAgentRefs(
	spec: Record<string, unknown>,
	options: ResolveSpecAgentRefsOptions = {},
): Promise<Record<string, unknown>> {
	const cloned = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
	const tasks = collectDurableRunTasks(cloned);
	if (tasks.length === 0) return cloned;

	const agentCache = new Map<string, ResolvedAgent | null>();
	const envCache = new Map<string, ResolvedEnvironment | null>();
	// Collected per node for the cross-backend file-sharing guard (below).
	const workspaceGuard: { taskName: string; runtime: string; workspaceRef: string }[] = [];
	for (const { task, taskName } of tasks) {
		const withBlock = (task.with ??= {} as Record<string, unknown>);
		const body = (withBlock as Record<string, unknown>).body;
		const bodyRecord = isRecord(body) ? body : null;
		const ref = pickAgentRef(withBlock, bodyRecord, options.triggerData, taskName);
		if (!ref) {
			throw new AgentRefResolutionError(
				`Task "${taskName}" (durable/run) is missing agentRef. All workflows must be backfilled to named agents before executing.`,
				taskName,
			);
		}

		const refKey = (ref as AgentRef & { slug?: string }).id || (ref as AgentRef & { slug?: string }).slug || "";
		const key = `${refKey}#${ref.version ?? "current"}`;
		let resolved = agentCache.get(key);
		if (resolved === undefined) {
			resolved = await resolveAgentRef(ref);
			agentCache.set(key, resolved);
		}
		if (!resolved) {
			throw new AgentRefResolutionError(
				`Agent "${(ref as AgentRef & { slug?: string }).id || (ref as AgentRef & { slug?: string }).slug}" (version ${ref.version ?? "current"}) referenced by task "${taskName}" was not found.`,
				taskName,
			);
		}

		const envRef = pickEnvironmentRef(withBlock, bodyRecord, resolved);
		let environment: ResolvedEnvironment | null = null;
		if (envRef) {
			const envKey = `${envRef.id}#${envRef.version ?? "current"}`;
			const cached = envCache.get(envKey);
			if (cached === undefined) {
				environment = await resolveEnvironmentRef(envRef);
				envCache.set(envKey, environment);
			} else {
				environment = cached;
			}
			if (!environment) {
				throw new AgentRefResolutionError(
					`Environment "${envRef.id}" (version ${envRef.version ?? "current"}) referenced by agent "${resolved.slug}" (task "${taskName}") was not found.`,
					taskName,
				);
			}
		}

		const overrides = pickOverrides(withBlock, bodyRecord);
		// Flatten the agent's capability bundles (Pillar 2) into the base config,
		// then layer node/session overrides on top.
		const flattened = await flattenBundles(resolved.config, resolved.projectId);
		let config = await applyOverrides(flattened, overrides, resolved.projectId);
		// Hydrate attached skills from agent_skill_registry. The agent's stored
		// config only carries the `registryId` pointer — the Python runtime
		// needs `prompt`, `allowed_tools`, and `packageManifest.files` inline
		// to activate the skill + materialize its bundled assets. Without
		// this hydration, `_extract_skill_configs` in dapr-agent-py skips the
		// skill because `prompt` is empty.
		await hydrateSkillsFromRegistry(config, options.skillHydration);
		config = stampCliAdapterForRuntime(config);
		const prompt = pickPrompt(withBlock, bodyRecord);
		const sandboxPolicy = environment
			? deriveSandboxPolicy(environment, overrides?.sandboxPolicy)
			: undefined;
		const effectiveCwd = overrides?.cwd ?? config.cwd ?? bodyRecord?.cwd;

		// Resolve peer agents listed in config.callableAgents. Only peers
		// currently `registered` in the Dapr registry are emitted; unregistered
		// / failed peers are dropped so the runtime doesn't expose a broken
		// tool. Runs at most once per (project, slug-set) via the project
		// scope — cache is implicit since the DB read is cheap.
		let callableAgents: ResolvedCallableAgent[] = [];
		if (
			resolved.projectId &&
			Array.isArray(config.callableAgents) &&
			config.callableAgents.length > 0
		) {
			const peers = await resolveCallableAgents(
				resolved.projectId,
				config.callableAgents,
			);
			const team = resolved.projectId;
			callableAgents = peers.map((p) => ({
				slug: p.slug,
				agentId: p.agentId,
				version: p.version,
				// Per-agent-runtime routing: peer workflows dispatch to
				// the peer's materialized runtime app id. For pool-backed
				// agents this may be agent-runtime-pool-<class>; otherwise it
				// stays agent-runtime-<slug>.
				appId: p.runtimeAppId ?? agentRuntimeDedicatedAppId(p.slug),
				team,
				registryKey: agentRegistryKey(team, p.slug),
			}));
		}

		const runtimeRoute = resolveAgentRuntimeRoute({
			agentSlug: resolved.slug,
			runtimeAppId: resolved.runtimeAppId,
			config,
		});
		// The physical runtime app id is intentionally separate from the
		// published agent slug. Shared-pool routes keep agent-specific
		// instructions/tools/MCP in childInput while dispatching multiple
		// agents to the same Dapr app id.
		const agentAppId = runtimeRoute.appId;
		// Record (runtime, workspaceRef) for the cross-backend file-sharing guard.
		const nodeWorkspaceRef =
			typeof (withBlock as Record<string, unknown>).workspaceRef === "string"
				? ((withBlock as Record<string, unknown>).workspaceRef as string).trim()
				: typeof bodyRecord?.workspaceRef === "string"
					? (bodyRecord.workspaceRef as string).trim()
					: "";
		if (nodeWorkspaceRef) {
			workspaceGuard.push({
				taskName,
				runtime: (config.runtime as string) ?? "dapr-agent-py",
				workspaceRef: nodeWorkspaceRef,
			});
		}
		const profileConfigHash = resolved.configHash ?? hashAgentConfig(resolved.config);
		const sandboxName =
			typeof bodyRecord?.sandboxName === "string"
				? bodyRecord.sandboxName
				: typeof (withBlock as Record<string, unknown>).sandboxName === "string"
					? ((withBlock as Record<string, unknown>).sandboxName as string)
					: undefined;
		const instructionBundle = buildInstructionBundle({
			agentConfig: config,
			prompt,
			promptSource: "workflow-node",
			agent: {
				id: resolved.id,
				version: resolved.version,
				configHash: profileConfigHash,
				slug: resolved.slug,
			},
			cwd: typeof effectiveCwd === "string" ? effectiveCwd : undefined,
			sandboxName,
			platformSystemSections: [
				buildOpenShellSystemPrompt(
					typeof effectiveCwd === "string" ? effectiveCwd : "/sandbox",
					sandboxName,
				),
			],
			sourceId: resolved.id,
		});

		const inlinedBody: Record<string, unknown> = {
			...(bodyRecord ?? {}),
			prompt,
			agentConfig: config,
			instructionBundle,
			agentRuntime: config.runtime ?? "dapr-agent-py",
			agentId: resolved.id,
			agentVersion: resolved.version,
			agentAppId,
			agentSlug: resolved.slug,
			agentRuntimeClass: runtimeRoute.runtimeClass,
			agentRuntimeIsolation: runtimeRoute.isolation,
			agentRuntimeRouteReason: runtimeRoute.reason,
			maxTurns: overrides?.maxTurns ?? config.maxTurns,
			timeoutMinutes: overrides?.timeoutMinutes ?? config.timeoutMinutes,
			cwd: effectiveCwd,
		};
		if (callableAgents.length > 0) {
			inlinedBody.callableAgents = callableAgents;
			inlinedBody.registryTeam = teamRegistryPrefix(
				resolved.projectId as string,
			);
		}
		if (environment) {
			inlinedBody.environment = {
				id: environment.id,
				slug: environment.slug,
				version: environment.version,
				config: environment.config,
				imageTag: environment.imageTag,
				baseEnvSlug: environment.baseEnvSlug,
			};
		}
		if (sandboxPolicy) inlinedBody.sandboxPolicy = sandboxPolicy;
		for (const key of PERSONA_OVERRIDE_FIELDS) delete inlinedBody[key];
		delete inlinedBody.agentRef;
		delete inlinedBody.environmentRef;
		delete inlinedBody.overrides;

		const withRecord = withBlock as Record<string, unknown>;
		withRecord.body = inlinedBody;
		withRecord.prompt = prompt;
		withRecord.agentRuntime = config.runtime ?? "dapr-agent-py";
		withRecord.agentId = resolved.id;
		withRecord.agentVersion = resolved.version;
		withRecord.agentAppId = agentAppId;
		withRecord.agentSlug = resolved.slug;
		withRecord.agentRuntimeClass = runtimeRoute.runtimeClass;
		withRecord.agentRuntimeIsolation = runtimeRoute.isolation;
		withRecord.agentRuntimeRouteReason = runtimeRoute.reason;
		withRecord.agentConfig = config;
		withRecord.instructionBundle = instructionBundle;
		if (sandboxPolicy) withRecord.sandboxPolicy = sandboxPolicy;
		for (const key of PERSONA_OVERRIDE_FIELDS) delete withRecord[key];
		delete withRecord.agentRef;
		delete withRecord.environmentRef;
	}

	// Reject cross-backend file-sharing: per-phase agent mix-and-match is only
	// valid within one workspace-backend family (all interactive-cli, or all
	// openshell). Different backends on a shared workspaceRef silently lose files.
	assertConsistentWorkspaceBackends(workspaceGuard);

	return cloned;
}

function stampCliAdapterForRuntime(config: AgentConfig): AgentConfig {
	const descriptor = getRuntimeDescriptor(config.runtime);
	if (!descriptor?.capabilities?.interactiveTerminal || !descriptor.cliAdapter) {
		return config;
	}
	return {
		...config,
		cliAdapter: descriptor.cliAdapter as AgentConfig["cliAdapter"],
	};
}

const PERSONA_OVERRIDE_FIELDS = [
	"role",
	"goal",
	"instructions",
	"styleGuidelines",
	"style_guidelines",
	"systemPrompt",
	"system_prompt",
	"persona",
];

/**
 * Backward-compatible sandbox policy shape. dapr-agent-py still reads
 * `sandboxPolicy.{mode, template, keepAfterRun, ttlSeconds}`; we derive it
 * from the environment config at resolve time.
 *
 * Post-collapse: `template` is the env's own slug (each env maps 1:1 to a
 * baked image). Legacy `sandboxTemplate` field on the config is honored if
 * still present so agents that hard-coded it don't break, but the env slug
 * is the intended source going forward.
 */
function deriveSandboxPolicy(
	environment: ResolvedEnvironment,
	override?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
	const cfg = environment.config;
	const base: Record<string, unknown> = {
		mode: cfg.sandboxMode,
		template: cfg.sandboxTemplate ?? environment.slug,
		keepAfterRun: cfg.keepAfterRun,
	};
	if (cfg.ttlSeconds !== undefined) base.ttlSeconds = cfg.ttlSeconds;
	if (environment.imageTag) base.imageTag = environment.imageTag;
	return { ...base, ...(override ?? {}) };
}

function pickEnvironmentRef(
	withBlock: unknown,
	body: Record<string, unknown> | null,
	agent: ResolvedAgent,
): EnvironmentRef | null {
	const fromBody = body?.environmentRef;
	if (isEnvironmentRef(fromBody)) return fromBody;
	const fromWith = isRecord(withBlock) ? withBlock.environmentRef : undefined;
	if (isEnvironmentRef(fromWith)) return fromWith;
	if (agent.environmentId) {
		return {
			id: agent.environmentId,
			...(agent.environmentVersion !== null
				? { version: agent.environmentVersion }
				: {}),
		};
	}
	return null;
}

function isEnvironmentRef(value: unknown): value is EnvironmentRef {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if ("version" in value && value.version !== undefined) {
		if (typeof value.version !== "number" || !Number.isFinite(value.version)) {
			return false;
		}
	}
	return true;
}

function pickAgentRef(
	withBlock: unknown,
	body: Record<string, unknown> | null,
	triggerData: Record<string, unknown> | undefined,
	taskName: string,
): AgentRef | null {
	const fromBody = body?.agentRef;
	const bodyRef = resolveAgentRefValue(fromBody, triggerData, taskName);
	if (bodyRef) return bodyRef;
	const fromWith = isRecord(withBlock) ? withBlock.agentRef : undefined;
	return resolveAgentRefValue(fromWith, triggerData, taskName);
}

function pickOverrides(
	withBlock: unknown,
	body: Record<string, unknown> | null,
): AgentOverrides | undefined {
	const fromBody = body?.overrides;
	if (isRecord(fromBody)) return fromBody as AgentOverrides;
	const fromWith = isRecord(withBlock) ? withBlock.overrides : undefined;
	if (isRecord(fromWith)) return fromWith as AgentOverrides;
	return undefined;
}

function pickPrompt(
	withBlock: unknown,
	body: Record<string, unknown> | null,
): string {
	const bodyPrompt = body?.prompt;
	if (typeof bodyPrompt === "string") return bodyPrompt;
	const withPrompt = isRecord(withBlock) ? withBlock.prompt : undefined;
	if (typeof withPrompt === "string") return withPrompt;
	return "";
}

async function applyOverrides(
	config: AgentConfig,
	overrides: AgentOverrides | undefined,
	projectId: string | null | undefined,
): Promise<AgentConfig> {
	if (!overrides) return config;
	let next: AgentConfig = { ...config };
	if (overrides.tools !== undefined) {
		next.tools = overrides.tools;
	}
	if (overrides.maxTurns !== undefined) next.maxTurns = overrides.maxTurns;
	if (overrides.timeoutMinutes !== undefined) {
		next.timeoutMinutes = overrides.timeoutMinutes;
	}
	if (overrides.cwd !== undefined) next.cwd = overrides.cwd;
	if (overrides.sandboxPolicy && config.sandboxPolicy) {
		next.sandboxPolicy = {
			...config.sandboxPolicy,
			...overrides.sandboxPolicy,
		};
	} else if (overrides.sandboxPolicy && !config.sandboxPolicy) {
		// Keep as partial — the orchestrator normalizes before dispatch.
		next.sandboxPolicy = overrides.sandboxPolicy as AgentConfig["sandboxPolicy"];
	}
	// Node/session-level capability bundles (Pillar 3) layer ON TOP of the
	// agent's own already-flattened config — flatten them in turn so their MCP
	// servers / skills / tools merge before MCP resolution (the agent's inline
	// config still wins on key collision via flattenBundles' config-wins union).
	if (Array.isArray(overrides.bundleRefs) && overrides.bundleRefs.length > 0) {
		next = await flattenBundles({ ...next, bundleRefs: overrides.bundleRefs }, projectId);
	}
	return next;
}

type DurableRunTask = {
	task: Record<string, unknown> & { with?: Record<string, unknown> };
	taskName: string;
};

/**
 * Walk a CNCF SW 1.0 document (spec.document.do) and collect every task with
 * `call: "durable/run"`. Supports nested `do` blocks (switch/fork/parallel).
 */
export function collectDurableRunTasks(
	spec: Record<string, unknown>,
): DurableRunTask[] {
	const out: DurableRunTask[] = [];
	const doList = extractDoList(spec);
	if (!doList) return out;
	walkDo(doList, out);
	return out;
}

function extractDoList(spec: Record<string, unknown>): unknown[] | null {
	const document = isRecord(spec.document) ? spec.document : null;
	if (document && Array.isArray(document.do)) return document.do;
	if (Array.isArray(spec.do)) return spec.do as unknown[];
	return null;
}

function walkDo(doList: unknown[], out: DurableRunTask[]): void {
	for (const entry of doList) {
		if (!isRecord(entry)) continue;
		for (const [taskName, task] of Object.entries(entry)) {
			if (!isRecord(task)) continue;
			if (task.call === "durable/run") {
				out.push({ task: task as DurableRunTask["task"], taskName });
			}
			// Recurse into nested do blocks (fork.branches, switch cases, etc.)
			if (Array.isArray(task.do)) walkDo(task.do as unknown[], out);
			const branches = (task.fork as Record<string, unknown> | undefined)
				?.branches;
			if (Array.isArray(branches)) walkDo(branches as unknown[], out);
			const switchCases = task.switch;
			if (Array.isArray(switchCases)) {
				for (const caseEntry of switchCases) {
					if (isRecord(caseEntry)) {
						for (const value of Object.values(caseEntry)) {
							if (isRecord(value) && Array.isArray(value.do)) {
								walkDo(value.do as unknown[], out);
							}
						}
					}
				}
			}
		}
	}
}
