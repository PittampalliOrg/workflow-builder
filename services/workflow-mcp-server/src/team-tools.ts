/**
 * Agent Teams MCP tools (Phase 1)
 *
 * spawn_teammate / list_teammates / send_message / broadcast / create_task /
 * claim_task / update_task / shutdown_teammate — the coordination surface an
 * agent uses to run a team of peers. The acting session comes from the goal
 * AsyncLocalStorage context (X-Wfb-Session-Id); the team comes from the team
 * context (X-Wfb-Team-Id). Suppressed entirely when X-Wfb-Team-Depth is set
 * (a teammate cannot spawn nested teams).
 *
 * Read + task-authoring tools hit the DB directly (team-db.ts). The tools that
 * need session spawning, event injection, NATS, the atomic claim, or the
 * Lifecycle Controller go through the BFF internal API — the same "tool →
 * internal endpoint" shape update_goal uses for /evaluate.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";
import { currentGoalSessionId } from "./goal-context.js";
import { currentTeamId } from "./team-context.js";
import { getTeam, listMembers, listTasks } from "./team-db.js";

const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function textResult(data: unknown) {
	setSpanOutput(data);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(msg: string) {
	setSpanOutput({ error: msg });
	return { content: [{ type: "text" as const, text: msg }], isError: true };
}

/** Resolve (sessionId, teamId) or return an error result. */
function requireCtx():
	| { sessionId: string; teamId: string }
	| { error: ReturnType<typeof errorResult> } {
	const sessionId = currentGoalSessionId();
	const teamId = currentTeamId();
	if (!sessionId)
		return {
			error: errorResult(
				"No session context: team tools require the X-Wfb-Session-Id header (set by the platform).",
			),
		};
	if (!teamId)
		return {
			error: errorResult(
				"No team context: team tools require the X-Wfb-Team-Id header (set by the platform when the team is formed).",
			),
		};
	return { sessionId, teamId };
}

/** POST a team action to the BFF internal API. */
async function callBff(
	teamId: string,
	action: string,
	body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
	const url = `${WORKFLOW_BUILDER_URL}/api/internal/team/${encodeURIComponent(
		teamId,
	)}/${action}`;
	const resp = await fetch(url, {
		method: "POST",
		headers: {
			"X-Internal-Token": INTERNAL_API_TOKEN,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* non-JSON body */
	}
	return { ok: resp.ok, status: resp.status, json, text };
}

/**
 * Register the team tools. `role` gates the lead-only management tools:
 *   • "lead"   → all 8 tools
 *   • "member" → worker tools only (no spawn_teammate / shutdown_teammate — a
 *                teammate cannot spawn nested teams or shut peers down)
 */
export function registerTeamTools(
	server: McpServer,
	opts?: { role?: "lead" | "member" },
): RegisteredTool[] {
	const includeLeadTools = (opts?.role ?? "lead") !== "member";
	const tools: RegisteredTool[] = [];
	const reg = (server as any).registerTool.bind(server);

	// ── spawn_teammate (lead only) ──────────────────────────
	if (includeLeadTools) {
	reg(
		"spawn_teammate",
		{
			title: "Spawn Teammate",
			description:
				"Spawn a peer teammate agent into your team. It runs concurrently in its own session/context and can claim tasks, message you, and be messaged by name. Give it a stable name and a self-contained prompt (it does NOT inherit your conversation).",
			inputSchema: {
				agentSlug: z
					.string()
					.describe("Agent slug/type to spawn (e.g. a project agent)."),
				name: z.string().describe("Addressable teammate name, unique within the team."),
				prompt: z
					.string()
					.describe("Self-contained initial instruction for the teammate."),
				model: z.string().optional().describe("Optional model key override."),
				planModeRequired: z
					.boolean()
					.optional()
					.describe("If true, the teammate plans in read-only mode until you approve."),
			},
		},
		async (args: {
			agentSlug: string;
			name: string;
			prompt: string;
			model?: string;
			planModeRequired?: boolean;
		}) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot spawn a teammate.");
			try {
				const r = await callBff(ctx.teamId, "spawn", {
					leadSessionId: ctx.sessionId,
					agentSlug: args.agentSlug,
					name: args.name,
					prompt: args.prompt,
					model: args.model,
					planModeRequired: args.planModeRequired ?? false,
				});
				if (!r.ok) return errorResult(`spawn_teammate failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to spawn teammate: ${err}`);
			}
		},
	);
	tools.push({ name: "spawn_teammate", description: "Spawn a peer teammate agent" });
	}

	// ── list_teammates ──────────────────────────────────────
	reg(
		"list_teammates",
		{
			title: "List Teammates",
			description:
				"List the members of your team with their name, role (lead|member), status (working|idle|failed|shutdown), and model.",
			inputSchema: {},
		},
		async () => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			try {
				const members = await listMembers(ctx.teamId);
				return textResult({
					teammates: members.map((m) => ({
						name: m.name,
						role: m.role,
						status: m.status,
						model: m.model,
						sessionId: m.session_id,
					})),
				});
			} catch (err) {
				return errorResult(`Failed to list teammates: ${err}`);
			}
		},
	);
	tools.push({ name: "list_teammates", description: "List team members" });

	// ── send_message ────────────────────────────────────────
	reg(
		"send_message",
		{
			title: "Send Message To Teammate",
			description:
				"Send a point-to-point message to one teammate by name. It is delivered into that teammate's live session as a user message and wakes it if idle.",
			inputSchema: {
				to: z.string().describe("Recipient teammate name."),
				content: z.string().describe("Message text."),
			},
		},
		async (args: { to: string; content: string }) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot send a message.");
			try {
				const r = await callBff(ctx.teamId, "message", {
					fromSessionId: ctx.sessionId,
					to: args.to,
					content: args.content,
				});
				if (!r.ok) return errorResult(`send_message failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to send message: ${err}`);
			}
		},
	);
	tools.push({ name: "send_message", description: "Message one teammate" });

	// ── broadcast ───────────────────────────────────────────
	reg(
		"broadcast",
		{
			title: "Broadcast To Team",
			description:
				"Send a message to every teammate at once (team-wide fan-out). Use sparingly — for point-to-point use send_message.",
			inputSchema: { content: z.string().describe("Message text for the whole team.") },
		},
		async (args: { content: string }) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot broadcast.");
			try {
				const r = await callBff(ctx.teamId, "broadcast", {
					fromSessionId: ctx.sessionId,
					content: args.content,
				});
				if (!r.ok) return errorResult(`broadcast failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to broadcast: ${err}`);
			}
		},
	);
	tools.push({ name: "broadcast", description: "Broadcast to all teammates" });

	// ── create_task ─────────────────────────────────────────
	reg(
		"create_task",
		{
			title: "Create Team Task",
			description:
				"Add a task to the shared team task list. Teammates claim unblocked tasks with claim_task. Use dependsOn (task ids) to gate a task until its prerequisites complete.",
			inputSchema: {
				title: z.string().describe("Short task title."),
				description: z.string().optional().describe("Full task detail / acceptance."),
				dependsOn: z
					.array(z.string())
					.optional()
					.describe("Task ids that must be completed before this is claimable."),
				assignTo: z
					.string()
					.optional()
					.describe(
						"Reserve for one teammate by name: only they can claim it, and they pick it up before any open task.",
					),
			},
		},
		async (args: {
			title: string;
			description?: string;
			dependsOn?: string[];
			assignTo?: string;
		}) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot create a task.");
			try {
				// Routed through the BFF so the TaskCreated quality gate covers EVERY
				// authoring path. assignTo uses 'queue' mode: reserved for the
				// designee's claim rather than handed over already-in_progress.
				const r = await callBff(ctx.teamId, "tasks", {
					title: args.title,
					description: args.description ?? null,
					dependsOn: args.dependsOn ?? [],
					assignTo: args.assignTo,
					assignMode: args.assignTo ? "queue" : undefined,
					createdBySessionId: ctx.sessionId,
				});
				if (r.status === 422 && (r.json as { blocked?: boolean } | null)?.blocked) {
					return errorResult(
						`Task creation was blocked by a team quality gate: ${
							(r.json as { reason?: string }).reason ?? "no reason given"
						}`,
					);
				}
				if (!r.ok)
					return errorResult(`create_task failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to create task: ${err}`);
			}
		},
	);
	tools.push({ name: "create_task", description: "Add a shared team task" });

	// ── claim_task ──────────────────────────────────────────
	reg(
		"claim_task",
		{
			title: "Claim Next Task",
			description:
				"Atomically claim your next team task: tasks reserved for you first, then the oldest unblocked open task. Returns the claimed task, or null when nothing is claimable. The task you claim is YOURS regardless of your role name — complete it before going idle. Race-safe: no two teammates can claim the same task.",
			inputSchema: {},
		},
		async () => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot claim a task.");
			try {
				const r = await callBff(ctx.teamId, "claim", { sessionId: ctx.sessionId });
				if (!r.ok) return errorResult(`claim_task failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				const payload = r.json as { blocked?: string; message?: string } | null;
				if (payload?.blocked === "plan_approval_required") {
					return errorResult(
						payload.message ??
							"Plan approval required: call submit_plan and wait for the lead before claiming tasks.",
					);
				}
				return textResult(r.json ?? { task: null });
			} catch (err) {
				return errorResult(`Failed to claim task: ${err}`);
			}
		},
	);
	tools.push({ name: "claim_task", description: "Claim the next unblocked task" });

	// ── update_task ─────────────────────────────────────────
	reg(
		"update_task",
		{
			title: "Update Task Status",
			description:
				'Mark a task complete. status must be "completed". Completing a task unblocks any tasks that depend on it.',
			inputSchema: {
				taskId: z.string().describe("The task id to update."),
				status: z.string().describe('Must be "completed".'),
				note: z
					.string()
					.optional()
					.describe("Completion note: the deliverable or a summary of the work done."),
			},
		},
		async (args: { taskId: string; status: string; note?: string }) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (args.status !== "completed")
				return errorResult('update_task can only set status="completed".');
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot update a task.");
			try {
				// Routed through the BFF so the TaskCompleted quality gate covers
				// every completion path. A blocked completion returns the gate's
				// feedback — fix the work, then complete again.
				const r = await callBff(
					ctx.teamId,
					`tasks/${encodeURIComponent(args.taskId)}/complete`,
					{ sessionId: ctx.sessionId, note: args.note ?? null },
				);
				if (r.status === 422 && (r.json as { blocked?: boolean } | null)?.blocked) {
					return errorResult(
						`Completion was blocked by a team quality gate: ${
							(r.json as { reason?: string }).reason ?? "no reason given"
						}\nAddress the feedback, then call update_task again.`,
					);
				}
				if (r.status === 404) return errorResult(`No task ${args.taskId} in this team.`);
				if (!r.ok)
					return errorResult(`update_task failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to update task: ${err}`);
			}
		},
	);
	tools.push({ name: "update_task", description: "Mark a task completed" });

	// ── wait_teammates ──────────────────────────────────────
	// Codex `wait_agent` parity, bounded: a SHORT synchronous join for leads
	// (async waiting stays push-based — idle notices arrive as messages). The
	// predicates mirror team_join_workflow_v1 in the orchestrator (keep the two
	// 6-line implementations in sync).
	reg(
		"wait_teammates",
		{
			title: "Wait For Teammates",
			description:
				"Block briefly (<=120s) until the team quiesces: until='tasks-complete' (every task done) or 'all-idle' (no teammate actively working). Returns {satisfied, timedOut, members, tasks}. For long waits rely on teammate idle messages instead.",
			inputSchema: {
				until: z
					.enum(["tasks-complete", "all-idle"])
					.optional()
					.describe("Quiescence predicate (default tasks-complete)."),
				timeoutSeconds: z
					.number()
					.optional()
					.describe("Max seconds to wait, 5–120 (default 60)."),
			},
		},
		async (args: { until?: "tasks-complete" | "all-idle"; timeoutSeconds?: number }) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			const until = args.until ?? "tasks-complete";
			const timeoutSeconds = Math.min(120, Math.max(5, args.timeoutSeconds ?? 60));
			const deadline = Date.now() + timeoutSeconds * 1000;
			const QUIESCENT = new Set(["idle", "suspended", "shutdown", "failed"]);
			try {
				for (;;) {
					const [members, tasks] = await Promise.all([
						listMembers(ctx.teamId),
						listTasks(ctx.teamId),
					]);
					const workers = members.filter((m) => m.role !== "lead");
					const satisfied =
						until === "all-idle"
							? workers.length > 0 &&
								workers.every((m) => QUIESCENT.has(String(m.status ?? "")))
							: tasks.length > 0 && tasks.every((t) => t.status === "completed");
					if (satisfied || Date.now() >= deadline) {
						return textResult({
							satisfied,
							timedOut: !satisfied,
							until,
							members: members.map((m) => ({
								name: m.name,
								role: m.role,
								status: m.status,
							})),
							tasks: tasks.map((t) => ({
								id: t.id,
								title: t.title,
								status: t.status,
							})),
						});
					}
					await new Promise((resolve) => setTimeout(resolve, 5_000));
				}
			} catch (err) {
				return errorResult(`Failed to wait for teammates: ${err}`);
			}
		},
	);
	tools.push({ name: "wait_teammates", description: "Bounded wait for team quiescence" });

	// ── depth refusal (members) ─────────────────────────────
	// A teammate that WANTS to delegate gets an explicit refusal instead of a
	// silent capability gap (Codex parity: "depth limit reached — solve the
	// task yourself"). Silent suppression makes models improvise; a clear "no,
	// and here's what to do instead" self-corrects.
	if (!includeLeadTools) {
		const refuse = (what: string) =>
			errorResult(
				`Team nesting is not allowed: teammates cannot ${what}. Solve the task yourself, or send_message the lead to ask for more help.`,
			);
		reg(
			"spawn_teammate",
			{
				title: "Spawn Teammate (unavailable)",
				description:
					"NOT AVAILABLE to teammates: team nesting is not allowed. Solve the task yourself or ask the lead (send_message) for more help.",
				inputSchema: {},
			},
			async () => refuse("spawn nested teammates"),
		);
		tools.push({ name: "spawn_teammate", description: "Refused for teammates (nesting guard)" });
		reg(
			"shutdown_teammate",
			{
				title: "Shut Down Teammate (unavailable)",
				description:
					"NOT AVAILABLE to teammates: only the lead manages the team. Ask the lead via send_message.",
				inputSchema: {},
			},
			async () => refuse("shut down peers"),
		);
		tools.push({ name: "shutdown_teammate", description: "Refused for teammates (lead-only)" });

		// ── submit_plan (members) ─────────────────────────────
		reg(
			"submit_plan",
			{
				title: "Submit Plan For Approval",
				description:
					"Plan-mode teammates: submit your implementation plan to the lead for approval. You cannot claim tasks until the lead approves. If revisions are requested, revise and submit again.",
				inputSchema: {
					plan: z.string().describe("The concrete plan: steps, files, risks, done-criteria."),
				},
			},
			async (args: { plan: string }) => {
				const ctx = requireCtx();
				if ("error" in ctx) return ctx.error;
				if (!INTERNAL_API_TOKEN)
					return errorResult("INTERNAL_API_TOKEN is not configured; cannot submit a plan.");
				try {
					const members = await listMembers(ctx.teamId);
					const me = members.find((m) => m.session_id === ctx.sessionId);
					const lead = members.find((m) => m.role === "lead");
					if (!lead) return errorResult("No lead found for this team.");
					const r = await callBff(ctx.teamId, "message", {
						fromSessionId: ctx.sessionId,
						to: lead.name,
						content: `PLAN APPROVAL REQUEST from "${me?.name ?? "teammate"}":\n\n${args.plan}\n\nReply with approve_plan(name: "${me?.name ?? "?"}", approved: true|false, feedback?).`,
					});
					if (!r.ok)
						return errorResult(`submit_plan failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
					return textResult({
						ok: true,
						status: "submitted",
						note: "Wait for the lead's decision message before claiming tasks.",
					});
				} catch (err) {
					return errorResult(`Failed to submit plan: ${err}`);
				}
			},
		);
		tools.push({ name: "submit_plan", description: "Submit a plan for lead approval" });
	}

	// ── approve_plan (lead only) ────────────────────────────
	if (includeLeadTools) {
		reg(
			"approve_plan",
			{
				title: "Approve Or Reject A Teammate's Plan",
				description:
					"Decide a plan-mode teammate's PLAN APPROVAL REQUEST. approved=true lifts plan mode (the teammate can claim tasks); approved=false keeps the gate and sends your feedback for revision.",
				inputSchema: {
					name: z.string().describe("Teammate name whose plan you are deciding."),
					approved: z.boolean().describe("true = approve, false = request revisions."),
					feedback: z
						.string()
						.optional()
						.describe("Required when rejecting: what must change. Optional praise when approving."),
				},
			},
			async (args: { name: string; approved: boolean; feedback?: string }) => {
				const ctx = requireCtx();
				if ("error" in ctx) return ctx.error;
				if (!INTERNAL_API_TOKEN)
					return errorResult("INTERNAL_API_TOKEN is not configured; cannot decide a plan.");
				try {
					const r = await callBff(ctx.teamId, "plan-approval", {
						requestedBySessionId: ctx.sessionId,
						name: args.name,
						approved: args.approved,
						feedback: args.feedback,
					});
					if (!r.ok)
						return errorResult(`approve_plan failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
					return textResult(r.json ?? { ok: true });
				} catch (err) {
					return errorResult(`Failed to decide plan: ${err}`);
				}
			},
		);
		tools.push({ name: "approve_plan", description: "Approve/reject a teammate's plan" });

		// ── revive_teammate (lead only) ───────────────────────
		reg(
			"revive_teammate",
			{
				title: "Revive Teammate",
				description:
					"Respawn a SHUTDOWN or FAILED teammate under the same name with a fresh session (it does not inherit the old session's memory — the task list and messages are its ground truth). Use after a teammate fails, or when finished work needs a follow-up.",
				inputSchema: {
					name: z.string().describe("The shutdown/failed teammate's name."),
					prompt: z
						.string()
						.optional()
						.describe("Fresh instruction for the revived teammate (what to do now)."),
				},
			},
			async (args: { name: string; prompt?: string }) => {
				const ctx = requireCtx();
				if ("error" in ctx) return ctx.error;
				if (!INTERNAL_API_TOKEN)
					return errorResult("INTERNAL_API_TOKEN is not configured; cannot revive a teammate.");
				try {
					const r = await callBff(ctx.teamId, "revive", {
						requestedBySessionId: ctx.sessionId,
						name: args.name,
						prompt: args.prompt,
					});
					if (!r.ok)
						return errorResult(`revive_teammate failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
					return textResult(r.json ?? { ok: true });
				} catch (err) {
					return errorResult(`Failed to revive teammate: ${err}`);
				}
			},
		);
		tools.push({ name: "revive_teammate", description: "Respawn a shutdown/failed teammate" });
	}

	// ── shutdown_teammate (lead only) ───────────────────────
	if (includeLeadTools) {
	reg(
		"shutdown_teammate",
		{
			title: "Shut Down Teammate",
			description:
				"Gracefully shut down a teammate by name. Cooperative — the teammate finishes its current step, then stops. Only the lead should shut teammates down.",
			inputSchema: { name: z.string().describe("Teammate name to shut down.") },
		},
		async (args: { name: string }) => {
			const ctx = requireCtx();
			if ("error" in ctx) return ctx.error;
			if (!INTERNAL_API_TOKEN)
				return errorResult("INTERNAL_API_TOKEN is not configured; cannot shut down a teammate.");
			try {
				const r = await callBff(ctx.teamId, "shutdown", {
					requestedBySessionId: ctx.sessionId,
					name: args.name,
				});
				if (!r.ok) return errorResult(`shutdown_teammate failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
				return textResult(r.json ?? { ok: true });
			} catch (err) {
				return errorResult(`Failed to shut down teammate: ${err}`);
			}
		},
	);
	tools.push({ name: "shutdown_teammate", description: "Shut down a teammate" });
	}

	// Reference so the imported helper is used even before the driver lands.
	void getTeam;

	return tools;
}
