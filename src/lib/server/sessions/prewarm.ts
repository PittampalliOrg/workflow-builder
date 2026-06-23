/**
 * Identity-bound prewarm for workflow `durable/run` entry sessions.
 *
 * Cold start for a per-session agent run is ~20–40s (Sandbox create → Kueue
 * admission → scheduling → init-containers → app/daprd boot). Because every
 * session gets a DETERMINISTIC per-session Dapr app-id (`agent-session-<sha20>`),
 * we can create the FINAL Sandbox EARLY — at workflow-execute time, before the
 * orchestrator even starts — so it is admitted + booting while the pre-agent
 * orchestration runs. The orchestrator's later `spawn_session_for_workflow`
 * (→ `maybeProvisionAgentWorkflowHost`) hits the SAME deterministic Sandbox CR
 * name + owner-run-id annotation and ADOPTS the already-booting pod instead of
 * creating a new one. Net: no extra capacity (one pod, created seconds earlier),
 * and `ctx.call_child_workflow(app_id=...)` routes to a pod that's already up.
 *
 * This is NOT a generic warm pool: a shared app-id would break per-session
 * placement routing + the credential invariant. Each prewarmed pod carries its
 * own final identity.
 *
 * SCOPE (first cut): the ENTRY `durable/run` node of dapr-agent-py workflows
 * only. dapr-agent-py model creds are LLM-gateway-side (no per-session Secret),
 * so the prewarm request is byte-identical to the real spawn and adoption is
 * trivially safe. CLI runtimes (per-user token Secret at creation) + direct UI
 * sessions are deferred. Best-effort: a prewarm failure NEVER affects the run.
 */

import { env } from "$env/dynamic/private";
import {
	agentConfigCanUseWorkflowHost,
	maybeProvisionAgentWorkflowHost,
	sessionHostAppId,
	type TraceContext,
} from "$lib/server/sessions/agent-workflow-host";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import {
	reconstructChildSessionId,
	reconstructOrchestratorInstanceId,
} from "$lib/server/sessions/prewarm-id";
import { resolveWorkflowSessionSecretEnv } from "$lib/server/sessions/session-secret-env";
import type { AgentConfig } from "$lib/types/agents";

function truthyEnv(value: string | undefined): boolean {
	const raw = (value ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function prewarmEnabled(): boolean {
	return truthyEnv(env.AGENT_PREWARM_ENABLED ?? process.env.AGENT_PREWARM_ENABLED);
}

/**
 * CLI runtimes (claude-code-cli/codex/agy) are gated SEPARATELY: their prewarmed
 * pod bakes the user's per-session CLI token Secret at creation, so prewarm must
 * resolve it byte-identically to the real spawn (shared `resolveWorkflowSessionSecretEnv`).
 * Default off — opt in once verified, independently of the dapr default.
 */
function prewarmCliEnabled(): boolean {
	return truthyEnv(env.AGENT_PREWARM_CLI_ENABLED ?? process.env.AGENT_PREWARM_CLI_ENABLED);
}

function prewarmNodeLimit(): number {
	const raw = Number(env.AGENT_PREWARM_NODE_LIMIT ?? process.env.AGENT_PREWARM_NODE_LIMIT ?? 1);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Top-level `durable/run` entry nodes (in `document.do` order). Deliberately
 * does NOT recurse into `switch`/`fork`/loop bodies: only nodes that sit at the
 * top level of the sequence are guaranteed to execute, so only they are safe to
 * prewarm (a node behind a branch might never run → wasted pod). A `durable/run`
 * that appears after other top-level nodes (e.g. a `workspace_profile` step) is
 * still top-level and still reached, so it qualifies.
 */
function topLevelDurableRunEntries(
	spec: Record<string, unknown>,
): { taskName: string; task: Record<string, unknown> }[] {
	// SW 1.0: `do` is a TOP-LEVEL sibling of `document` (which holds name/dsl).
	// Mirror resolver.ts `extractDoList`: prefer `document.do`, else `spec.do`.
	const document = isRecord(spec.document) ? spec.document : null;
	const doList =
		document && Array.isArray(document.do)
			? document.do
			: Array.isArray(spec.do)
				? (spec.do as unknown[])
				: null;
	if (!doList) return [];
	const out: { taskName: string; task: Record<string, unknown> }[] = [];
	for (const entry of doList) {
		if (!isRecord(entry)) continue;
		for (const [taskName, task] of Object.entries(entry)) {
			if (isRecord(task) && task.call === "durable/run") {
				out.push({ taskName, task });
			}
		}
	}
	return out;
}

/**
 * Resolve the node's `sharedWorkspaceKey` for CLI prewarm, matching EXACTLY what
 * the orchestrator+ensure-for-workflow will pass — this becomes the JuiceFS subPath
 * the prewarmed pod's shared workspace mounts, and a wrong key means the ADOPTED
 * pod sees a DIFFERENT subtree than the rest of the run (so a downstream node can't
 * see the entry node's files). The node `workspaceRef` (mirrors resolver:
 * `with.workspaceRef` else `with.body.workspaceRef`) may be:
 *   - absent → ensure-for-workflow falls back to `workflowExecutionId`, which the
 *     orchestrator bridge sets to `tc.db_execution_id` = the BARE execution.id
 *     (canonical_context["workflowExecutionId"], sw_workflow.py:554).
 *   - whole-string jq `${ .runtime.executionId }` (the common pattern) → the
 *     orchestrator evaluates `.runtime.executionId` to `tc.execution_id` = the
 *     INSTANCE id `sw-<safeName>-exec-<execId>` (sw_workflow.py:741), NOT the bare
 *     id. So this case must return the instance id — they genuinely differ.
 *   - a literal non-jq string → that literal (orchestrator passes it through).
 *   - ANY OTHER jq `${...}` → UNKNOWN at execute-time. Returning "skip" makes the
 *     caller NOT prewarm that node (a wrong key would silently mis-mount).
 */
function resolveSharedWorkspaceKey(
	withBlock: Record<string, unknown>,
	executionId: string,
	orchestratorInstanceId: string,
): string | "skip" {
	const raw =
		(typeof withBlock.workspaceRef === "string" && withBlock.workspaceRef.trim()) ||
		(isRecord(withBlock.body) &&
			typeof withBlock.body.workspaceRef === "string" &&
			withBlock.body.workspaceRef.trim()) ||
		"";
	if (!raw) return executionId; // absent → ensure falls back to the bare execution id
	if (!raw.includes("${")) return raw; // literal → orchestrator passes through
	// jq: `.runtime.executionId` is the orchestrator INSTANCE id, not the bare id.
	if (/^\$\{\s*\.runtime\.executionId\s*\}$/.test(raw)) return orchestratorInstanceId;
	return "skip";
}

/**
 * Fire-and-forget prewarm of the entry `durable/run` node(s) for a just-triggered
 * workflow execution. MUST be called as `void prewarm(...).catch(...)` — it is
 * best-effort and never throws. Covers dapr-agent-py (AGENT_PREWARM_ENABLED) and,
 * when AGENT_PREWARM_CLI_ENABLED, interactive-cli runtimes (needs `userId` to
 * resolve the per-session CLI token Secret byte-identically to the real spawn).
 */
export async function prewarmWorkflowEntrySessions(params: {
	/** Spec AFTER `resolveSpecAgentRefs` (nodes carry stamped `with.agentConfig`). */
	spec: Record<string, unknown>;
	executionId: string;
	/** Authed user — required to resolve CLI per-session creds (CLI prewarm only). */
	userId?: string | null;
	traceContext?: TraceContext | null;
}): Promise<void> {
	if (!prewarmEnabled()) return;

	const workflowName =
		(isRecord(params.spec.document) && typeof params.spec.document.name === "string"
			? params.spec.document.name
			: typeof params.spec.name === "string"
				? (params.spec.name as string)
				: "") || "";
	if (!workflowName) return;

	// The orchestrator instance id (`sw-<safeName>-exec-<execId>`) is constant for
	// this execution; `${ .runtime.executionId }` workspaceRefs resolve to it.
	const orchestratorInstanceId = reconstructOrchestratorInstanceId({
		workflowName,
		executionId: params.executionId,
	});

	const entries = topLevelDurableRunEntries(params.spec).slice(0, prewarmNodeLimit());

	for (const { taskName, task } of entries) {
		try {
			const withBlock = isRecord(task.with) ? task.with : null;
			if (!withBlock) continue;
			const agentConfig = (isRecord(withBlock.agentConfig)
				? withBlock.agentConfig
				: isRecord(withBlock.body) && isRecord(withBlock.body.agentConfig)
					? withBlock.body.agentConfig
					: null) as AgentConfig | null;
			if (!agentConfig) continue;

			// Gate: must be a Kueue-host-eligible runtime (excludes browser /
			// warm-pool). CLI runtimes (interactiveTerminal) are additionally
			// gated on AGENT_PREWARM_CLI_ENABLED + a resolvable user.
			if (!agentConfigCanUseWorkflowHost(agentConfig)) continue;
			const runtime = (agentConfig as { runtime?: string }).runtime;
			const descriptor = getRuntimeDescriptor(runtime);
			if (!descriptor) continue;
			const isCli = descriptor.capabilities.interactiveTerminal === true;
			// Both interactive-cli AND juicefs-shared runtimes (e.g.
			// dapr-agent-py-juicefs) mount the per-execution JuiceFS workspace, so
			// both must bake the SAME sharedWorkspaceKey at prewarm time — otherwise
			// the prewarmed pod is created mountless and the real dispatch adopts it
			// (creation-identical adoption) WITHOUT /sandbox/work.
			const usesSharedWorkspace =
				isCli || descriptor.capabilities.workspaceBackend === "juicefs-shared";
			if (isCli && (!prewarmCliEnabled() || !params.userId)) continue;

			// Creation-identical inputs for adoption: the per-session Secret +
			// shared-workspace key are baked at Sandbox creation, so prewarm must
			// match what the real spawn (ensure-for-workflow) will pass. For CLI:
			// resolve the SAME secret env (shared resolver — throws 412 if the user
			// has no linked token, caught below as a best-effort skip) and
			// sharedWorkspaceKey = node workspaceRef ?? executionId. For dapr both
			// are null (gateway-side model creds, no shared key).
			let sessionSecretEnv: Record<string, string> | null = null;
			let sharedWorkspaceKey: string | null = null;
			if (usesSharedWorkspace) {
				// Both interactive-cli AND juicefs-shared (dapr-agent-py-juicefs)
				// key by the CANONICAL orchestrator instance id (resolved from the
				// node workspaceRef `${ .runtime.executionId }`) — the SAME key the
				// cli_workspace_command helper pod and the Files-tab webdav reader
				// (workflowExecutions.daprInstanceId) use, so agents + the
				// deterministic spine + the Files tab all share one /sandbox/work
				// subtree. Mirrors ensure-for-workflow.
				const wsKey = resolveSharedWorkspaceKey(
					withBlock,
					params.executionId,
					orchestratorInstanceId,
				);
				if (wsKey === "skip") {
					console.info(
						`[prewarm] skip node "${taskName}" exec=${params.executionId}: workspaceRef is a non-executionId jq expression (key unpredictable)`,
					);
					continue;
				}
				sharedWorkspaceKey = wsKey;
				if (isCli) {
					sessionSecretEnv = await resolveWorkflowSessionSecretEnv({
						userId: params.userId as string,
						runtimeDescriptor: descriptor,
					});
				}
			}

			// instance_prefix mirrors the orchestrator's runtime_registry.resolve():
			// every resolveSpecAgentRefs node carries a stamped `agentAppId`, so
			// resolve() ALWAYS takes the agentAppId branch → `_synthetic()` which
			// hardcodes instance_prefix="durable" for ALL runtimes (NOT the runtime
			// descriptor's instancePrefix — that field is for agent-runtime-<slug>
			// pool naming, not the child-workflow instance id). dapr matched by luck
			// (its prefix is also "durable"); CLI's "durable-claude-cli" did NOT.
			const stampedAppId =
				(typeof withBlock.agentAppId === "string" && withBlock.agentAppId.trim()) ||
				(isRecord(withBlock.body) &&
					typeof withBlock.body.agentAppId === "string" &&
					withBlock.body.agentAppId.trim());
			const instancePrefix = stampedAppId ? "durable" : descriptor.instancePrefix;
			const childSessionId = reconstructChildSessionId({
				workflowName,
				executionId: params.executionId,
				instancePrefix,
				taskName,
				runIndex: 0,
			});

			// waitReadySeconds=0 → return immediately (don't block this detached
			// promise on pod readiness; the real spawn waits). The deterministic CR
			// name + owner-run-id "<sessionId>|" make the later spawn ADOPT this pod.
			void maybeProvisionAgentWorkflowHost({
				sessionId: childSessionId,
				agentConfig,
				workflowExecutionId: params.executionId,
				benchmarkRunId: null,
				benchmarkInstanceId: null,
				timeoutMinutes:
					typeof withBlock.timeoutMinutes === "number"
						? (withBlock.timeoutMinutes as number)
						: null,
				traceContext: params.traceContext ?? null,
				sessionSecretEnv,
				sharedWorkspaceKey,
				waitReadySeconds: 0,
			})
				.then((result) => {
					if (result) {
						console.info(
							`[prewarm] entry node "${taskName}" exec=${params.executionId} -> ${result.agentAppId} (${result.status ?? "created"})`,
						);
					}
				})
				.catch((err) => {
					console.warn(
						`[prewarm] entry node "${taskName}" exec=${params.executionId} failed (best-effort): ${String(err)}`,
					);
				});
		} catch (err) {
			console.warn(
				`[prewarm] skipped node "${taskName}" exec=${params.executionId}: ${String(err)}`,
			);
		}
	}
}
