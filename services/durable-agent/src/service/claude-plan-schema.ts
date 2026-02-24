import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const ClaudeTaskStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	"failed",
	"skipped",
]);

export const ClaudeTaskSchema = z
	.object({
		id: NonEmptyString,
		subject: NonEmptyString,
		description: NonEmptyString,
		status: ClaudeTaskStatusSchema.default("pending"),
		blocked: z.boolean().optional(),
		blockedBy: z.array(NonEmptyString).default([]),
		tool: z.string().trim().optional(),
		targetPaths: z.array(NonEmptyString).default([]),
		acceptanceCriteria: z.array(NonEmptyString).default([]),
		reasoning: z.string().trim().optional(),
	})
	.strict();

export const ClaudeTaskPlanSchema = z
	.object({
		artifactType: z.literal("claude_task_graph_v1"),
		goal: NonEmptyString,
		tasks: z.array(ClaudeTaskSchema).min(1),
		estimated_tool_calls: z.number().int().nonnegative(),
	})
	.strict();

export const TaskExecutionResultSchema = z.object({
	taskId: z.string(),
	status: ClaudeTaskStatusSchema,
	durationMs: z.number().nonnegative().optional(),
	output: z.string().optional(),
	error: z.string().optional(),
	retryCount: z.number().int().nonnegative().default(0),
	exitCode: z.number().int().optional(),
});

export type ClaudeTaskPlan = z.infer<typeof ClaudeTaskPlanSchema>;
export type ClaudeTask = z.infer<typeof ClaudeTaskSchema>;
export type ClaudeTaskStatus = z.infer<typeof ClaudeTaskStatusSchema>;
export type TaskExecutionResult = z.infer<typeof TaskExecutionResultSchema>;

export type ClaudePlanValidationIssue = {
	path: string;
	message: string;
	code: string;
};

function formatZodIssues(error: z.ZodError): ClaudePlanValidationIssue[] {
	return error.issues.map((issue) => ({
		path: issue.path.length > 0 ? issue.path.join(".") : "$",
		message: issue.message,
		code: issue.code,
	}));
}

function normalizeTask(input: unknown, index: number): ClaudeTask {
	const source =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};

	const id = String(source.id ?? `${index + 1}`).trim() || `${index + 1}`;
	const subject =
		String(source.subject ?? source.title ?? `Task ${index + 1}`).trim() ||
		`Task ${index + 1}`;
	const description =
		String(source.description ?? source.instructions ?? subject).trim() ||
		subject;
	const blockedBy = Array.isArray(source.blockedBy)
		? source.blockedBy
				.map((item) => String(item ?? "").trim())
				.filter((item) => item.length > 0)
		: [];
	const normalizedBlockedBy = [
		...new Set(blockedBy.filter((item) => item !== id)),
	];
	const explicitBlocked =
		typeof source.blocked === "boolean" ? source.blocked : undefined;

	const statusRaw = String(source.status ?? "pending")
		.trim()
		.toLowerCase();
	const status: ClaudeTask = {
		id,
		subject,
		description,
		status:
			statusRaw === "in_progress" ||
			statusRaw === "completed" ||
			statusRaw === "failed" ||
			statusRaw === "skipped"
				? statusRaw
				: "pending",
		blocked: explicitBlocked ?? normalizedBlockedBy.length > 0,
		blockedBy: normalizedBlockedBy,
		tool: typeof source.tool === "string" ? source.tool.trim() : undefined,
		targetPaths: Array.isArray(source.targetPaths)
			? source.targetPaths
					.map((item) => String(item ?? "").trim())
					.filter((item) => item.length > 0)
			: [],
		acceptanceCriteria: Array.isArray(source.acceptanceCriteria)
			? source.acceptanceCriteria
					.map((item) => String(item ?? "").trim())
					.filter((item) => item.length > 0)
			: [],
		reasoning:
			typeof source.reasoning === "string"
				? source.reasoning.trim()
				: undefined,
	};
	return status;
}

function normalizeCandidate(input: unknown): Record<string, unknown> {
	const source =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	const tasksRaw = Array.isArray(source.tasks) ? source.tasks : [];
	const tasks = tasksRaw.map((task, index) => normalizeTask(task, index));

	const goal = String(source.goal ?? "Execute the requested plan").trim();
	const estimatedRaw = source.estimated_tool_calls;
	const estimatedParsed =
		typeof estimatedRaw === "number"
			? Math.floor(estimatedRaw)
			: Number.parseInt(String(estimatedRaw ?? ""), 10);
	const estimatedToolCalls =
		Number.isFinite(estimatedParsed) && estimatedParsed >= 0
			? estimatedParsed
			: tasks.length;

	return {
		artifactType: "claude_task_graph_v1",
		goal: goal || "Execute the requested plan",
		tasks,
		estimated_tool_calls: estimatedToolCalls,
	};
}

export function validateClaudeTaskPlan(
	input: unknown,
):
	| { success: true; plan: ClaudeTaskPlan }
	| { success: false; issues: ClaudePlanValidationIssue[] } {
	const normalized = normalizeCandidate(input);
	const parsed = ClaudeTaskPlanSchema.safeParse(normalized);
	if (parsed.success) {
		return { success: true, plan: parsed.data };
	}
	return {
		success: false,
		issues: formatZodIssues(parsed.error),
	};
}

export function claudePlanJsonSchema(): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["artifactType", "goal", "tasks", "estimated_tool_calls"],
		properties: {
			artifactType: { const: "claude_task_graph_v1" },
			goal: { type: "string", minLength: 1 },
			estimated_tool_calls: { type: "integer", minimum: 0 },
			tasks: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"id",
						"subject",
						"description",
						"status",
						"blocked",
						"blockedBy",
					],
					properties: {
						id: { type: "string", minLength: 1 },
						subject: { type: "string", minLength: 1 },
						description: { type: "string", minLength: 1 },
						status: {
							type: "string",
							enum: [
								"pending",
								"in_progress",
								"completed",
								"failed",
								"skipped",
							],
						},
						blocked: { type: "boolean" },
						blockedBy: {
							type: "array",
							items: { type: "string", minLength: 1 },
						},
						tool: { type: "string" },
						targetPaths: {
							type: "array",
							items: { type: "string", minLength: 1 },
						},
						acceptanceCriteria: {
							type: "array",
							items: { type: "string", minLength: 1 },
						},
						reasoning: { type: "string" },
					},
				},
			},
		},
	};
}
