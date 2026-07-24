/**
 * Code checkpoint / replay / promotion MCP tools.
 *
 * First-class agent access to the run code-lifecycle surface: the durable
 * per-tool-call code checkpoints a run produces, restoring one into a live
 * sandbox, forking/resuming a run from a node or after a script edit, and
 * promoting a run's captured code version to a real GitHub PR.
 *
 * Auth path mirrors execute_workflow / run_workflow_script: these call
 * workspace-scoped INTERNAL BFF routes (/api/internal/executions/<id>/...) with
 * X-Internal-Token + the signed X-Wfb-Principal-Assertion. The BFF re-derives
 * the workspace from the assertion and confirms the execution belongs to it, so
 * a raw session id is never trusted and cross-workspace runs are 404. Read
 * tools require workflow:read; restore/resume/promote require workflow:execute.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	hasWorkflowMcpScope,
	type WorkflowMcpPrincipal,
	type WorkflowMcpScope,
} from "./auth-context.js";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";

const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// Diffs are whole-checkpoint patches; cap what we hand back to the model.
const DIFF_MAX_CHARS = 60_000;
// Checkpoint rows can list many changed files; bound the echoed paths.
const CHECKPOINT_FILES_MAX = 50;

function textResult(data: unknown) {
	setSpanOutput(data);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(msg: string) {
	setSpanOutput({ error: msg });
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

function internalHeaders(
	principal: WorkflowMcpPrincipal,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Internal-Token": INTERNAL_API_TOKEN,
		"X-Wfb-Principal-Assertion": principal.principalAssertion,
	};
	if (principal.sessionId) headers["X-Wfb-Session-Id"] = principal.sessionId;
	return headers;
}

const CODE_LIFECYCLE_TOOL_SCOPES: Record<string, WorkflowMcpScope> = {
	list_code_checkpoints: "workflow:read",
	get_checkpoint_diff: "workflow:read",
	restore_checkpoint: "workflow:execute",
	resume_workflow_execution: "workflow:execute",
	promote_run_to_pr: "workflow:execute",
};

function scopedToolServer(
	server: McpServer,
	principal?: WorkflowMcpPrincipal,
): McpServer {
	return {
		registerTool(name: string, ...args: unknown[]) {
			const scope = CODE_LIFECYCLE_TOOL_SCOPES[name];
			if (scope && hasWorkflowMcpScope(principal, scope)) {
				return (server as any).registerTool(name, ...args);
			}
			return undefined;
		},
	} as unknown as McpServer;
}

function short(sha: unknown): string | null {
	return typeof sha === "string" && sha ? sha.slice(0, 12) : null;
}

/** Pull file paths out of a checkpoint's changedFiles rows. */
function changedFilePaths(files: unknown): string[] {
	if (!Array.isArray(files)) return [];
	const paths: string[] = [];
	for (const file of files) {
		if (typeof file === "string") {
			paths.push(file);
		} else if (file && typeof file === "object") {
			const path = (file as Record<string, unknown>).path;
			if (typeof path === "string") paths.push(path);
		}
		if (paths.length >= CHECKPOINT_FILES_MAX) break;
	}
	return paths;
}

/** Compact one checkpoint read-model row for the agent. */
function compactCheckpoint(row: Record<string, unknown>): Record<string, unknown> {
	const remoteStatus =
		typeof row.remoteStatus === "string" ? row.remoteStatus : null;
	return {
		id: row.id,
		seq: row.seq ?? null,
		toolName: row.toolName ?? null,
		nodeId: row.nodeId ?? null,
		status: row.status ?? null,
		remoteStatus,
		// A checkpoint is durable (restorable / survives sandbox teardown) only
		// once its commit has been pushed to the in-cluster checkpoint remote.
		durable: remoteStatus === "pushed",
		fileCount: row.fileCount ?? null,
		files: changedFilePaths(row.changedFiles),
		sandboxName: row.sandboxName ?? null,
		beforeSha: short(row.beforeSha),
		afterSha: short(row.afterSha),
		createdAt: row.createdAt ?? null,
	};
}

/** Compact one source-bundle version row for the promote flow. */
function compactVersion(row: Record<string, unknown>): Record<string, unknown> {
	const promotion =
		row.promotion && typeof row.promotion === "object"
			? (row.promotion as Record<string, unknown>)
			: null;
	const prUrl =
		promotion && typeof promotion.prUrl === "string" ? promotion.prUrl : null;
	const gate =
		row.promotionGate && typeof row.promotionGate === "object"
			? (row.promotionGate as Record<string, unknown>)
			: null;
	return {
		artifactId: row.artifactId,
		title: row.title ?? null,
		nodeId: row.nodeId ?? null,
		sizeBytes: row.sizeBytes ?? null,
		createdAt: row.createdAt ?? null,
		promoted: Boolean(prUrl),
		prUrl,
		promotionAllowed: gate ? gate.allowed ?? null : null,
	};
}

/** True when a version has not yet been promoted to a PR. */
function isUnpromoted(row: Record<string, unknown>): boolean {
	const promotion =
		row.promotion && typeof row.promotion === "object"
			? (row.promotion as Record<string, unknown>)
			: null;
	return !(promotion && typeof promotion.prUrl === "string" && promotion.prUrl);
}

export type CodeLifecycleToolsContext = {
	principal?: WorkflowMcpPrincipal;
	fetchImpl?: typeof fetch;
};

export function registerCodeLifecycleTools(
	server: McpServer,
	ctx: CodeLifecycleToolsContext,
): RegisteredTool[] {
	const principal = ctx.principal;
	const fetchImpl = ctx.fetchImpl ?? fetch;
	const toolServer = scopedToolServer(server, principal);
	const tools: RegisteredTool[] = [];

	const requireReady = (): WorkflowMcpPrincipal | string => {
		if (!principal) {
			return "Workspace authentication is required. Call get_workflow_context for setup guidance.";
		}
		if (!INTERNAL_API_TOKEN) {
			return "INTERNAL_API_TOKEN is not configured for run code-lifecycle operations.";
		}
		return principal;
	};

	const executionBase = (executionId: string) =>
		`${WORKFLOW_BUILDER_URL}/api/internal/executions/${encodeURIComponent(executionId)}`;

	// ── list_code_checkpoints ───────────────────────────────
	(toolServer as any).registerTool(
		"list_code_checkpoints",
		{
			title: "List Code Checkpoints",
			description:
				"List the code checkpoints a run captured — one durable commit per code-mutating tool call (edit/write/patch) inside the run's sandbox. Returns compact rows: id, seq, toolName, nodeId, status, remoteStatus, durable (true once the commit is pushed to the in-cluster checkpoint remote and therefore restorable), fileCount, changed file paths, sandboxName, short before/afterSha, createdAt. Use this to see exactly what code each step changed and to pick a checkpointId for get_checkpoint_diff (inspect the patch) or restore_checkpoint (roll a live sandbox back to it). This is the programmatic form of the run's Changes tab.",
			inputSchema: {
				executionId: z
					.string()
					.describe("workflow_executions.id of the run to list checkpoints for."),
			},
		},
		async (args: { executionId: string }) => {
			const ready = requireReady();
			if (typeof ready === "string") return errorResult(ready);
			try {
				const resp = await fetchImpl(
					`${executionBase(args.executionId)}/code-checkpoints`,
					{ headers: internalHeaders(ready) },
				);
				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(
						`Failed to list code checkpoints (HTTP ${resp.status}): ${text}`,
					);
				}
				const data = (await resp.json()) as { checkpoints?: unknown };
				const rows = Array.isArray(data.checkpoints) ? data.checkpoints : [];
				return textResult({
					executionId: args.executionId,
					count: rows.length,
					checkpoints: rows.map((row) =>
						compactCheckpoint(row as Record<string, unknown>),
					),
				});
			} catch (err) {
				return errorResult(`Failed to list code checkpoints: ${err}`);
			}
		},
	);
	tools.push({
		name: "list_code_checkpoints",
		description: "List a run's per-tool-call code checkpoints",
	});

	// ── get_checkpoint_diff ─────────────────────────────────
	(toolServer as any).registerTool(
		"get_checkpoint_diff",
		{
			title: "Get Checkpoint Diff",
			description:
				"Return the unified diff a single code checkpoint recorded — the whole checkpoint, or one file when `path` is given. Use a checkpointId from list_code_checkpoints. The diff is read from the checkpoint's sandbox when live, else from the durable checkpoint remote; large patches are truncated. Read this to review exactly what a step changed before restoring or promoting.",
			inputSchema: {
				executionId: z.string().describe("workflow_executions.id of the run."),
				checkpointId: z
					.string()
					.describe("Checkpoint id from list_code_checkpoints."),
				path: z
					.string()
					.optional()
					.describe("Optional repo-relative file path to limit the diff to one file."),
			},
		},
		async (args: { executionId: string; checkpointId: string; path?: string }) => {
			const ready = requireReady();
			if (typeof ready === "string") return errorResult(ready);
			try {
				const url = new URL(
					`${executionBase(args.executionId)}/code-checkpoints/${encodeURIComponent(
						args.checkpointId,
					)}/diff`,
				);
				if (args.path) url.searchParams.set("path", args.path);
				const resp = await fetchImpl(url.toString(), {
					headers: internalHeaders(ready),
				});
				const data = (await resp.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				if (!resp.ok) {
					return errorResult(
						`Failed to load checkpoint diff (HTTP ${resp.status}): ${
							typeof data.error === "string" ? data.error : JSON.stringify(data)
						}`,
					);
				}
				const diff = typeof data.diff === "string" ? data.diff : "";
				const truncated = diff.length > DIFF_MAX_CHARS;
				return textResult({
					executionId: args.executionId,
					checkpointId: args.checkpointId,
					filePath: data.filePath ?? args.path ?? null,
					source: data.source ?? null,
					exitCode: data.exitCode ?? null,
					message: data.message ?? null,
					diff: truncated ? diff.slice(0, DIFF_MAX_CHARS) : diff,
					truncated,
				});
			} catch (err) {
				return errorResult(`Failed to load checkpoint diff: ${err}`);
			}
		},
	);
	tools.push({
		name: "get_checkpoint_diff",
		description: "Get one code checkpoint's unified diff",
	});

	// ── restore_checkpoint ──────────────────────────────────
	(toolServer as any).registerTool(
		"restore_checkpoint",
		{
			title: "Restore Code Checkpoint",
			description:
				"DESTRUCTIVE: hard-reset a live sandbox's workspace to a checkpoint's commit (git reset --hard + clean), discarding any uncommitted changes and later commits in that sandbox. The checkpoint must be durable (remoteStatus 'pushed' — see list_code_checkpoints). Pass the target `sandboxName` (an active sandbox, e.g. from list_code_checkpoints rows); omitting it is rejected. Use this to roll an agent's workspace back to a known-good step before re-running from there.",
			inputSchema: {
				executionId: z.string().describe("workflow_executions.id of the run."),
				checkpointId: z
					.string()
					.describe("Durable checkpoint id from list_code_checkpoints."),
				sandboxName: z
					.string()
					.optional()
					.describe(
						"Target live sandbox to overwrite. Required by the backend; a checkpoint row's sandboxName is a valid target.",
					),
			},
		},
		async (args: {
			executionId: string;
			checkpointId: string;
			sandboxName?: string;
		}) => {
			const ready = requireReady();
			if (typeof ready === "string") return errorResult(ready);
			try {
				const resp = await fetchImpl(
					`${executionBase(args.executionId)}/code-checkpoints/${encodeURIComponent(
						args.checkpointId,
					)}/restore`,
					{
						method: "POST",
						headers: internalHeaders(ready),
						body: JSON.stringify({
							...(args.sandboxName ? { sandboxName: args.sandboxName } : {}),
						}),
					},
				);
				const data = (await resp.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				if (!resp.ok) {
					return errorResult(
						`Failed to restore checkpoint (HTTP ${resp.status}): ${
							typeof data.error === "string" ? data.error : JSON.stringify(data)
						}`,
					);
				}
				return textResult(data);
			} catch (err) {
				return errorResult(`Failed to restore checkpoint: ${err}`);
			}
		},
	);
	tools.push({
		name: "restore_checkpoint",
		description: "Restore a live sandbox to a durable code checkpoint",
	});

	// ── resume_workflow_execution ───────────────────────────
	(toolServer as any).registerTool(
		"resume_workflow_execution",
		{
			title: "Resume Workflow Execution",
			description:
				"Fork/resume a run as a NEW execution that reuses the source run's work, then returns the new executionId. Two lanes by engine: for an SW-graph run it forks from a node — skips every top-level node before `fromNodeId` (omit to auto-resume from the node in-flight when the run stopped) and re-runs from there, seeding the workspace from the nearest predecessor node snapshot. For a dynamic-script run it is resume-after-edit — starts a fresh run of the CURRENT (possibly edited) script, imports the source run's done-call journal so unchanged calls resolve without new agent sessions and only changed calls re-dispatch, seeding the shared workspace from the last reused call's snapshot; the source must be terminal (stop it first). Use it to fix a failed step and continue, or iterate a later step without paying for the prefix. Response includes { ok, executionId (the NEW run), sourceExecutionId, newInstanceId, seededFromSnapshot } plus fromNodeId (SW) or journalImportFromExecutionId (script).",
			inputSchema: {
				executionId: z
					.string()
					.describe("workflow_executions.id of the source run to fork/resume."),
				fromNodeId: z
					.string()
					.optional()
					.describe(
						"SW-graph only: the top-level node to resume from (nodes before it are skipped). Omit to auto-pick the node in-flight when the run stopped. Ignored by dynamic-script resume-after-edit.",
					),
			},
		},
		async (args: { executionId: string; fromNodeId?: string }) => {
			const ready = requireReady();
			if (typeof ready === "string") return errorResult(ready);
			try {
				const resp = await fetchImpl(
					`${executionBase(args.executionId)}/resume`,
					{
						method: "POST",
						headers: internalHeaders(ready),
						body: JSON.stringify({
							...(args.fromNodeId ? { fromNodeId: args.fromNodeId } : {}),
						}),
					},
				);
				const data = (await resp.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				if (!resp.ok) {
					return errorResult(
						`Failed to resume execution (HTTP ${resp.status}): ${
							typeof data.error === "string" ? data.error : JSON.stringify(data)
						}`,
					);
				}
				return textResult(data);
			} catch (err) {
				return errorResult(`Failed to resume execution: ${err}`);
			}
		},
	);
	tools.push({
		name: "resume_workflow_execution",
		description: "Fork/resume a run from a node or after a script edit",
	});

	// ── promote_run_to_pr ───────────────────────────────────
	(toolServer as any).registerTool(
		"promote_run_to_pr",
		{
			title: "Promote Run To PR",
			description:
				"Open a REAL GitHub PR (or push a branch) from a run's captured code version, via the in-cluster promotion helper. Composite: with no `artifactId` it lists the run's source-bundle versions and, if exactly one is unpromoted, promotes it; if several are unpromoted it returns the list so you can re-call with a chosen `artifactId` (with none it reports nothing to promote). With `artifactId` it promotes that version. `mode` 'pr' (default) opens a PR, 'branch' pushes a branch. `repo` ('owner/name') and `base` default from the version/run when omitted; `title` sets the PR title. Strict preview captures are rejected here (they promote through preview continuation). Returns { ok, prUrl, branch, commitSha, repo, base, promotionGate } on success.",
			inputSchema: {
				executionId: z.string().describe("workflow_executions.id of the run."),
				artifactId: z
					.string()
					.optional()
					.describe(
						"Source-bundle version to promote (from the returned list). Omit to auto-pick the single unpromoted version.",
					),
				mode: z
					.enum(["pr", "branch"])
					.optional()
					.describe("'pr' (default) opens a PR; 'branch' pushes a branch."),
				repo: z
					.string()
					.optional()
					.describe("Target repo 'owner/name'. Defaults from the version/run."),
				base: z
					.string()
					.optional()
					.describe("Base branch. Defaults from the version/run, else 'main'."),
				title: z.string().optional().describe("PR title."),
			},
		},
		async (args: {
			executionId: string;
			artifactId?: string;
			mode?: "pr" | "branch";
			repo?: string;
			base?: string;
			title?: string;
		}) => {
			const ready = requireReady();
			if (typeof ready === "string") return errorResult(ready);

			const promote = async (artifactId: string) => {
				const resp = await fetchImpl(
					`${executionBase(args.executionId)}/versions/${encodeURIComponent(
						artifactId,
					)}/promote`,
					{
						method: "POST",
						headers: internalHeaders(ready),
						body: JSON.stringify({
							...(args.mode ? { mode: args.mode } : {}),
							...(args.repo ? { repo: args.repo } : {}),
							...(args.base ? { base: args.base } : {}),
							...(args.title ? { title: args.title } : {}),
						}),
					},
				);
				const data = (await resp.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				if (!resp.ok) {
					return errorResult(
						`Failed to promote version (HTTP ${resp.status}): ${
							typeof data.error === "string" ? data.error : JSON.stringify(data)
						}`,
					);
				}
				return textResult({ artifactId, ...data });
			};

			try {
				if (args.artifactId) return await promote(args.artifactId);

				// No artifactId: list versions and pick the single unpromoted one.
				const resp = await fetchImpl(
					`${executionBase(args.executionId)}/versions`,
					{ headers: internalHeaders(ready) },
				);
				const data = (await resp.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				if (!resp.ok) {
					return errorResult(
						`Failed to list run versions (HTTP ${resp.status}): ${
							typeof data.error === "string" ? data.error : JSON.stringify(data)
						}`,
					);
				}
				const versions = Array.isArray(data.versions)
					? (data.versions as Record<string, unknown>[])
					: [];
				const unpromoted = versions.filter(isUnpromoted);
				if (unpromoted.length === 1) {
					return await promote(String(unpromoted[0].artifactId));
				}
				return textResult({
					executionId: args.executionId,
					needsArtifactId: true,
					unpromotedCount:
						typeof data.unpromotedCount === "number"
							? data.unpromotedCount
							: unpromoted.length,
					message:
						unpromoted.length === 0
							? "No unpromoted code versions to promote for this run."
							: "Multiple unpromoted versions — re-call promote_run_to_pr with a chosen artifactId.",
					versions: versions.map(compactVersion),
				});
			} catch (err) {
				return errorResult(`Failed to promote run: ${err}`);
			}
		},
	);
	tools.push({
		name: "promote_run_to_pr",
		description: "Promote a run's code version to a real GitHub PR/branch",
	});

	return tools;
}
