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
import {
	agentRegistryKey,
	teamRegistryPrefix,
} from "./registry-sync";
import {
	resolveEnvironmentRef,
	type ResolvedEnvironment,
} from "$lib/server/environments/registry";

export class AgentRefResolutionError extends Error {
	constructor(
		message: string,
		public readonly nodeId?: string,
	) {
		super(message);
		this.name = "AgentRefResolutionError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRef(value: unknown): value is AgentRef {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if ("version" in value && value.version !== undefined) {
		if (typeof value.version !== "number" || !Number.isFinite(value.version)) {
			return false;
		}
	}
	return true;
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
): Promise<Record<string, unknown>> {
	const cloned = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
	const tasks = collectDurableRunTasks(cloned);
	if (tasks.length === 0) return cloned;

	const agentCache = new Map<string, ResolvedAgent | null>();
	const envCache = new Map<string, ResolvedEnvironment | null>();
	for (const { task, taskName } of tasks) {
		const withBlock = (task.with ??= {} as Record<string, unknown>);
		const body = (withBlock as Record<string, unknown>).body;
		const bodyRecord = isRecord(body) ? body : null;
		const ref = pickAgentRef(withBlock, bodyRecord);
		if (!ref) {
			throw new AgentRefResolutionError(
				`Task "${taskName}" (durable/run) is missing agentRef. All workflows must be backfilled to named agents before executing.`,
				taskName,
			);
		}

		const key = `${ref.id}#${ref.version ?? "current"}`;
		let resolved = agentCache.get(key);
		if (resolved === undefined) {
			resolved = await resolveAgentRef(ref);
			agentCache.set(key, resolved);
		}
		if (!resolved) {
			throw new AgentRefResolutionError(
				`Agent "${ref.id}" (version ${ref.version ?? "current"}) referenced by task "${taskName}" was not found.`,
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
		const config = applyOverrides(resolved.config, overrides);
		const prompt = pickPrompt(withBlock, bodyRecord);
		const sandboxPolicy = environment
			? deriveSandboxPolicy(environment, overrides?.sandboxPolicy)
			: undefined;

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
				appId: p.runtime,
				team,
				registryKey: agentRegistryKey(team, p.slug),
			}));
		}

		const inlinedBody: Record<string, unknown> = {
			...(bodyRecord ?? {}),
			prompt,
			agentConfig: config,
			agentRuntime: config.runtime ?? "dapr-agent-py",
			maxTurns: overrides?.maxTurns ?? config.maxTurns,
			timeoutMinutes: overrides?.timeoutMinutes ?? config.timeoutMinutes,
			cwd: overrides?.cwd ?? config.cwd ?? bodyRecord?.cwd,
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
		delete inlinedBody.agentRef;
		delete inlinedBody.environmentRef;
		delete inlinedBody.overrides;

		const withRecord = withBlock as Record<string, unknown>;
		withRecord.body = inlinedBody;
		withRecord.prompt = prompt;
		withRecord.agentRuntime = config.runtime ?? "dapr-agent-py";
		withRecord.agentConfig = config;
		if (sandboxPolicy) withRecord.sandboxPolicy = sandboxPolicy;
		delete withRecord.agentRef;
		delete withRecord.environmentRef;
	}

	return cloned;
}

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
): AgentRef | null {
	const fromBody = body?.agentRef;
	if (isAgentRef(fromBody)) return fromBody;
	const fromWith = isRecord(withBlock) ? withBlock.agentRef : undefined;
	if (isAgentRef(fromWith)) return fromWith;
	return null;
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

function applyOverrides(
	config: AgentConfig,
	overrides: AgentOverrides | undefined,
): AgentConfig {
	if (!overrides) return config;
	const next: AgentConfig = { ...config };
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
