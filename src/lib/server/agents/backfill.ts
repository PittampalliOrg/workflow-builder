import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	workflows,
} from "$lib/server/db/schema";
import type { AgentConfig } from "$lib/types/agents";
import { createDefaultAgentConfig } from "$lib/types/agents";
import { hashAgentConfig } from "./config-hash";

type NodeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Extract and normalize the AgentConfig shape from a node's legacy inline
 * config. The old shape lived at node.data.taskConfig.with.body.agentConfig,
 * with a subset of fields duplicated at with.agentConfig or body.*.
 */
function extractInlineConfig(node: NodeRecord): {
	body: NodeRecord;
	inline: Record<string, unknown>;
} | null {
	const data = isRecord(node.data) ? node.data : null;
	if (!data) return null;
	const taskConfig = isRecord(data.taskConfig) ? data.taskConfig : null;
	if (!taskConfig || taskConfig.call !== "durable/run") return null;
	const withBlock = isRecord(taskConfig.with) ? taskConfig.with : {};
	const body = isRecord(withBlock.body) ? withBlock.body : withBlock;
	if (isRecord(body.agentRef)) return null; // already migrated
	const inline = isRecord(body.agentConfig)
		? body.agentConfig
		: isRecord(withBlock.agentConfig)
			? withBlock.agentConfig
			: null;
	if (!inline) return null;
	return { body, inline };
}

function toStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => String(v ?? "").trim()).filter(Boolean);
	return out.length > 0 ? out : undefined;
}

function normalizeInlineToAgentConfig(
	inline: Record<string, unknown>,
	body: NodeRecord,
): AgentConfig {
	const defaults = createDefaultAgentConfig();
	const builtinTools = toStringArray(inline.builtinTools) ?? defaults.builtinTools;
	const toolChoice =
		inline.toolChoice === "required" ||
		inline.toolChoice === "none" ||
		inline.toolChoice === "auto"
			? inline.toolChoice
			: undefined;
	const mcpConnectionMode =
		inline.mcpConnectionMode === "project" ||
		inline.mcpConnectionMode === "explicit" ||
		inline.mcpConnectionMode === "auto"
			? inline.mcpConnectionMode
			: defaults.mcpConnectionMode;
	const runtime =
		inline.runtime === "dapr-agent-py-testing"
			? "dapr-agent-py-testing"
			: inline.runtime === "browser-use-agent"
				? "browser-use-agent"
				: "dapr-agent-py";
	const policySource = isRecord(inline.runtimeOverridePolicy)
		? (inline.runtimeOverridePolicy as typeof defaults.runtimeOverridePolicy)
		: defaults.runtimeOverridePolicy;
	const config: AgentConfig = {
		systemPrompt:
			typeof inline.systemPrompt === "string"
				? inline.systemPrompt
				: typeof inline.instructions === "string"
					? inline.instructions
					: undefined,
		modelSpec: typeof inline.modelSpec === "string" ? inline.modelSpec : undefined,
		temperature:
			typeof inline.temperature === "number" ? inline.temperature : undefined,
		toolChoice,
		maxTurns:
			typeof inline.maxTurns === "number"
				? inline.maxTurns
				: typeof body.maxTurns === "number"
					? body.maxTurns
					: defaults.maxTurns,
		timeoutMinutes:
			typeof inline.timeoutMinutes === "number"
				? inline.timeoutMinutes
				: typeof body.timeoutMinutes === "number"
					? body.timeoutMinutes
					: defaults.timeoutMinutes,
		cwd:
			typeof inline.cwd === "string"
				? inline.cwd
				: typeof body.cwd === "string"
					? body.cwd
					: undefined,
		builtinTools,
		tools: toStringArray(inline.tools),
		mcpConnectionMode,
		mcpServers: Array.isArray(inline.mcpServers)
			? (inline.mcpServers as AgentConfig["mcpServers"])
			: [],
		skills: Array.isArray(inline.skills)
			? (inline.skills as AgentConfig["skills"])
			: [],
		hooks: isRecord(inline.hooks) ? (inline.hooks as AgentConfig["hooks"]) : undefined,
		plugins: toStringArray(inline.plugins),
		memory: isRecord(inline.memory)
			? (inline.memory as AgentConfig["memory"])
			: defaults.memory,
		sandboxPolicy: isRecord(body.sandboxPolicy)
			? (body.sandboxPolicy as unknown as AgentConfig["sandboxPolicy"])
			: undefined,
		runtime,
		runtimeOverridePolicy: policySource,
		configuration: isRecord(inline.configuration)
			? (inline.configuration as AgentConfig["configuration"])
			: undefined,
	};
	return config;
}

function proposedAgentName(
	inline: Record<string, unknown>,
	workflowName: string,
	nodeLabel: string,
): string {
	const inlineName =
		typeof inline.name === "string" && inline.name.trim()
			? inline.name.trim()
			: undefined;
	if (inlineName) return inlineName;
	const base = `${workflowName} · ${nodeLabel}`.trim();
	return base || "Migrated Agent";
}

export type BackfillReport = {
	agentsCreated: number;
	agentsReused: number;
	nodesRewritten: number;
	workflowsTouched: number;
	workflowsScanned: number;
};

/**
 * One-shot, idempotent migration. Walks every workflow, finds every durable/run
 * node with inline agentConfig (and no agentRef), dedupes by config hash into
 * named agents, and rewrites each node's taskConfig body to reference the
 * agent by { id, version }.
 *
 * Reruns are safe — nodes already carrying agentRef are skipped and no
 * duplicate agents are created.
 */
export async function backfillInlineAgents(): Promise<BackfillReport> {
	const database = requireDb();
	const workflowRows = await database
		.select({
			id: workflows.id,
			name: workflows.name,
			nodes: workflows.nodes,
			spec: workflows.spec,
			userId: workflows.userId,
		})
		.from(workflows);

	const report: BackfillReport = {
		agentsCreated: 0,
		agentsReused: 0,
		nodesRewritten: 0,
		workflowsTouched: 0,
		workflowsScanned: workflowRows.length,
	};

	// Cache: configHash -> { agentId, version }
	const hashCache = new Map<string, { id: string; version: number }>();

	async function resolveRef(
		inline: Record<string, unknown>,
		body: NodeRecord,
		wfLabel: string,
		taskLabel: string,
		createdBy: string | null,
	): Promise<{ id: string; version: number }> {
		const config = normalizeInlineToAgentConfig(inline, body);
		const hash = hashAgentConfig(config);
		const cached = hashCache.get(hash);
		if (cached) {
			report.agentsReused++;
			return cached;
		}
		const ref = await findOrCreateAgentByHash({
			hash,
			config,
			proposedName: proposedAgentName(inline, wfLabel, taskLabel),
			createdBy,
			onCreated: () => report.agentsCreated++,
			onReused: () => report.agentsReused++,
		});
		hashCache.set(hash, ref);
		return ref;
	}

	for (const wf of workflowRows) {
		let mutatedNodes = false;
		let mutatedSpec = false;
		const wfLabel = wf.name ?? wf.id;

		// ── legacy Svelte Flow nodes path ──
		const originalNodes = wf.nodes as NodeRecord[] | null;
		const nextNodes: NodeRecord[] = [];
		if (Array.isArray(originalNodes)) {
			for (const node of originalNodes) {
				const extracted = extractInlineConfig(node);
				if (!extracted) {
					nextNodes.push(node);
					continue;
				}
				const taskLabel =
					typeof (node as NodeRecord).id === "string"
						? ((node as NodeRecord).id as string)
						: "agent";
				const ref = await resolveRef(
					extracted.inline,
					extracted.body,
					wfLabel,
					taskLabel,
					wf.userId,
				);
				const rewritten = rewriteNodeWithRef(node, extracted.body, ref, extracted.inline);
				nextNodes.push(rewritten);
				mutatedNodes = true;
				report.nodesRewritten++;
			}
		}

		// ── modern SW 1.0 spec.do path ──
		const spec = isRecord(wf.spec) ? (wf.spec as Record<string, unknown>) : null;
		const doArr = spec && Array.isArray(spec.do) ? (spec.do as Array<Record<string, unknown>>) : null;
		const nextDo: Array<Record<string, unknown>> = [];
		if (doArr) {
			for (const entry of doArr) {
				if (!isRecord(entry)) {
					nextDo.push(entry);
					continue;
				}
				const taskName = Object.keys(entry)[0];
				const task = taskName ? entry[taskName] : null;
				if (!taskName || !isRecord(task)) {
					nextDo.push(entry);
					continue;
				}
				const extracted = extractInlineConfigFromSpecTask(task);
				if (!extracted) {
					nextDo.push(entry);
					continue;
				}
				const ref = await resolveRef(
					extracted.inline,
					extracted.body,
					wfLabel,
					taskName,
					wf.userId,
				);
				const rewrittenTask = rewriteSpecTaskWithRef(
					task,
					extracted.body,
					ref,
					extracted.inline,
				);
				nextDo.push({ ...entry, [taskName]: rewrittenTask });
				mutatedSpec = true;
				report.nodesRewritten++;
			}
		}

		if (mutatedNodes || mutatedSpec) {
			const updatePayload: Record<string, unknown> = { updatedAt: new Date() };
			if (mutatedNodes) updatePayload.nodes = nextNodes;
			if (mutatedSpec && spec) updatePayload.spec = { ...spec, do: nextDo };
			await database
				.update(workflows)
				.set(updatePayload)
				.where(eq(workflows.id, wf.id));
			report.workflowsTouched++;
		}
	}

	return report;
}

async function findOrCreateAgentByHash(args: {
	hash: string;
	config: AgentConfig;
	proposedName: string;
	createdBy: string | null;
	onCreated: () => void;
	onReused: () => void;
}): Promise<{ id: string; version: number }> {
	const database = requireDb();
	const [existingVersion] = await database
		.select()
		.from(agentVersions)
		.where(eq(agentVersions.configHash, args.hash))
		.limit(1);
	if (existingVersion) {
		args.onReused();
		return { id: existingVersion.agentId, version: existingVersion.version };
	}

	const slugBase = slugify(args.proposedName) || "agent";
	const slug = await ensureUniqueSlug(slugBase);

	const result = await database.transaction(async (tx) => {
		const [agent] = await tx
			.insert(agents)
			.values({
				slug,
				name: args.proposedName,
				tags: ["migrated"],
				runtime: args.config.runtime,
				createdBy: args.createdBy,
			})
			.returning();
		const [version] = await tx
			.insert(agentVersions)
			.values({
				agentId: agent.id,
				version: 1,
				config: args.config as unknown as Record<string, unknown>,
				configHash: args.hash,
				publishedAt: new Date(),
				changelog: "Backfilled from inline agentConfig",
			})
			.returning();
		await tx
			.update(agents)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(agents.id, agent.id));
		return { id: agent.id, version: version.version };
	});
	args.onCreated();
	return result;
}

async function ensureUniqueSlug(base: string): Promise<string> {
	const database = requireDb();
	let candidate = base;
	let suffix = 1;
	while (true) {
		const [row] = await database
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.slug, candidate))
			.limit(1);
		if (!row) return candidate;
		suffix += 1;
		candidate = `${base}-${suffix}`;
	}
}

/**
 * Extract inline agentConfig from a spec.do task (modern SW 1.0 format).
 * Mirrors extractInlineConfig but walks `spec.do[i][taskName]` rather
 * than `nodes[i].data.taskConfig`. Returns null if the task isn't a
 * durable/run, is already on agentRef, or has no inline config.
 */
function extractInlineConfigFromSpecTask(task: Record<string, unknown>): {
	body: NodeRecord;
	inline: Record<string, unknown>;
} | null {
	if (task.call !== "durable/run") return null;
	const withBlock = isRecord(task.with) ? task.with : {};
	const body = isRecord(withBlock.body) ? withBlock.body : withBlock;
	if (isRecord(body.agentRef)) return null; // already migrated
	const inline = isRecord(body.agentConfig)
		? body.agentConfig
		: isRecord(withBlock.agentConfig)
			? withBlock.agentConfig
			: null;
	if (!inline) return null;
	return { body, inline };
}

/**
 * Rewrite a spec.do task in place to use `agentRef` instead of `agentConfig`.
 * Parallel to rewriteNodeWithRef but targets the SW 1.0 spec shape
 * (with.body.agentRef rather than node.data.taskConfig.with.body.agentRef).
 */
function rewriteSpecTaskWithRef(
	task: Record<string, unknown>,
	originalBody: NodeRecord,
	ref: { id: string; version: number },
	inline: Record<string, unknown>,
): Record<string, unknown> {
	const withBlock = isRecord(task.with) ? { ...task.with } : {};

	const prompt =
		typeof originalBody.prompt === "string"
			? originalBody.prompt
			: typeof withBlock.prompt === "string"
				? (withBlock.prompt as string)
				: "";

	const bodyKeep = { ...originalBody } as Record<string, unknown>;
	delete bodyKeep.agentConfig;
	const overrides: Record<string, unknown> = {};
	if (typeof bodyKeep.maxTurns === "number") overrides.maxTurns = bodyKeep.maxTurns;
	if (typeof bodyKeep.timeoutMinutes === "number")
		overrides.timeoutMinutes = bodyKeep.timeoutMinutes;
	if (typeof bodyKeep.cwd === "string" && bodyKeep.cwd) overrides.cwd = bodyKeep.cwd;
	if (isRecord(bodyKeep.sandboxPolicy)) overrides.sandboxPolicy = bodyKeep.sandboxPolicy;
	const toolsFromInline = Array.isArray(inline.tools) ? (inline.tools as unknown[]) : null;
	if (toolsFromInline && toolsFromInline.length > 0) overrides.tools = toolsFromInline;

	const nextBody: Record<string, unknown> = {
		...bodyKeep,
		prompt,
		agentRef: ref,
	};
	delete nextBody.agentConfig;
	if (Object.keys(overrides).length > 0) nextBody.overrides = overrides;

	const nextWith: Record<string, unknown> = {
		...withBlock,
		body: nextBody,
	};
	delete nextWith.agentConfig;

	return { ...task, call: "durable/run", with: nextWith };
}

function rewriteNodeWithRef(
	node: NodeRecord,
	originalBody: NodeRecord,
	ref: { id: string; version: number },
	inline: Record<string, unknown>,
): NodeRecord {
	const data = isRecord(node.data) ? { ...node.data } : {};
	const taskConfig = isRecord(data.taskConfig) ? { ...data.taskConfig } : {};
	const withBlock = isRecord(taskConfig.with) ? { ...taskConfig.with } : {};

	const prompt =
		typeof originalBody.prompt === "string"
			? originalBody.prompt
			: typeof withBlock.prompt === "string"
				? (withBlock.prompt as string)
				: "";

	const bodyKeep = { ...originalBody } as Record<string, unknown>;
	delete bodyKeep.agentConfig;
	// Carry forward per-node overrides only if they are meaningful.
	const overrides: Record<string, unknown> = {};
	if (typeof bodyKeep.maxTurns === "number") overrides.maxTurns = bodyKeep.maxTurns;
	if (typeof bodyKeep.timeoutMinutes === "number")
		overrides.timeoutMinutes = bodyKeep.timeoutMinutes;
	if (typeof bodyKeep.cwd === "string" && bodyKeep.cwd) overrides.cwd = bodyKeep.cwd;
	if (isRecord(bodyKeep.sandboxPolicy)) overrides.sandboxPolicy = bodyKeep.sandboxPolicy;
	const toolsFromInline = Array.isArray(inline.tools) ? (inline.tools as unknown[]) : null;
	if (toolsFromInline && toolsFromInline.length > 0) overrides.tools = toolsFromInline;

	const nextBody: Record<string, unknown> = {
		...bodyKeep,
		prompt,
		agentRef: ref,
	};
	delete nextBody.agentConfig;
	if (Object.keys(overrides).length > 0) nextBody.overrides = overrides;

	const nextWith: Record<string, unknown> = {
		...withBlock,
		prompt,
		agentRef: ref,
		body: nextBody,
	};
	delete nextWith.agentConfig;

	const nextTaskConfig: Record<string, unknown> = {
		...taskConfig,
		call: "durable/run",
		with: nextWith,
	};
	return { ...node, data: { ...data, taskConfig: nextTaskConfig } };
}
