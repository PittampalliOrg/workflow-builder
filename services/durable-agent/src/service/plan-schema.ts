import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const CanonicalPlanTaskSchema = z
	.object({
		id: NonEmptyString.describe("Stable task identifier (for example: T1)"),
		title: NonEmptyString.describe("Short task title"),
		instructions: NonEmptyString.describe(
			"Concrete tool-oriented instructions for execution",
		),
		tool: NonEmptyString.describe(
			"Suggested primary tool (read_file, write_file, edit_file, execute_command, etc.)",
		),
		blockedBy: z
			.array(NonEmptyString)
			.describe("Task ids that must complete first")
			.default([]),
		targetPaths: z
			.array(NonEmptyString)
			.describe("Repository-relative paths touched or verified by this task")
			.default([]),
		acceptanceCriteria: z
			.array(NonEmptyString)
			.describe("Objective completion criteria for this task")
			.default([]),
		reasoning: z.string().trim().describe("Why the task exists").default(""),
	})
	.strict();

export const CanonicalPlanStepSchema = z
	.object({
		step: z.number().int().min(1),
		tool: NonEmptyString,
		action: NonEmptyString,
		reasoning: z.string().trim().default(""),
	})
	.strict();

export const CanonicalPlanSchema = z
	.object({
		artifactType: z.literal("task_graph_v1"),
		goal: NonEmptyString.describe("One sentence summary of the goal"),
		repositoryRoot: z.string().trim().default(""),
		constraints: z
			.object({
				writeScope: z.literal("clone_root").default("clone_root"),
				sandbox: z.literal("strict").default("strict"),
				requireReadBeforeWrite: z.boolean().default(true),
			})
			.strict()
			.default({
				writeScope: "clone_root",
				sandbox: "strict",
				requireReadBeforeWrite: true,
			}),
		tasks: z.array(CanonicalPlanTaskSchema).min(1),
		steps: z.array(CanonicalPlanStepSchema).min(1),
		executionHints: z
			.object({
				suggestedOrder: z.array(NonEmptyString).default([]),
				maxTurns: z.number().int().positive().nullable().default(null),
			})
			.strict()
			.default({ suggestedOrder: [], maxTurns: null }),
		estimated_tool_calls: z.number().int().nonnegative(),
		planMarkdown: z.string().optional(),
	})
	.strict();

export type CanonicalPlan = z.infer<typeof CanonicalPlanSchema>;
export type CanonicalPlanTask = z.infer<typeof CanonicalPlanTaskSchema>;
export type CanonicalPlanStep = z.infer<typeof CanonicalPlanStepSchema>;

export type PlanValidationIssue = {
	path: string;
	message: string;
	code: string;
};

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function toStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => String(item ?? "").trim())
		.filter((item) => item.length > 0);
}

function inferTool(input: Record<string, unknown>): string {
	const direct = String(input.tool ?? "").trim();
	if (direct) return direct;
	const kind = String(input.kind ?? "").trim();
	switch (kind) {
		case "inspect":
			return "read_file";
		case "command":
			return "execute_command";
		case "validate":
			return "read_file";
		case "commit_prep":
			return "execute_command";
		default:
			return "read_file";
	}
}

function toTask(
	value: unknown,
	index: number,
	previousId?: string,
): CanonicalPlanTask {
	const source = asObject(value);
	const id = String(source.id ?? `T${index + 1}`).trim() || `T${index + 1}`;
	const title =
		String(
			source.title ??
				source.subject ??
				source.action ??
				source.description ??
				`Task ${index + 1}`,
		).trim() || `Task ${index + 1}`;
	const instructions =
		String(
			source.instructions ??
				source.action ??
				source.description ??
				source.subject ??
				`Execute ${title}`,
		).trim() || `Execute ${title}`;
	const blockedBy = toStringArray(source.blockedBy);
	if (blockedBy.length === 0 && previousId) {
		blockedBy.push(previousId);
	}

	return {
		id,
		title,
		instructions,
		tool: inferTool(source),
		blockedBy,
		targetPaths: toStringArray(source.targetPaths),
		acceptanceCriteria: toStringArray(source.acceptanceCriteria),
		reasoning: String(source.reasoning ?? "").trim(),
	};
}

function toStep(
	value: unknown,
	index: number,
	fallbackTask?: CanonicalPlanTask,
): CanonicalPlanStep {
	const source = asObject(value);
	const stepNumberRaw = source.step;
	const parsedStepNumber =
		typeof stepNumberRaw === "number"
			? Math.floor(stepNumberRaw)
			: Number.parseInt(String(stepNumberRaw ?? ""), 10);
	const step =
		Number.isFinite(parsedStepNumber) && parsedStepNumber > 0
			? parsedStepNumber
			: index + 1;

	const tool =
		String(source.tool ?? fallbackTask?.tool ?? "read_file").trim() ||
		"read_file";
	const action =
		String(
			source.action ??
				source.instructions ??
				source.description ??
				fallbackTask?.instructions ??
				`Execute step ${step}`,
		).trim() || `Execute step ${step}`;
	const reasoning = String(
		source.reasoning ?? fallbackTask?.reasoning ?? "",
	).trim();

	return {
		step,
		tool,
		action,
		reasoning,
	};
}

function toCanonicalCandidate(input: unknown): Record<string, unknown> {
	const source = asObject(input);
	const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
	const rawSteps = Array.isArray(source.steps) ? source.steps : [];

	const tasks: CanonicalPlanTask[] =
		rawTasks.length > 0
			? rawTasks.map((task, index) => toTask(task, index))
			: rawSteps.map((step, index) =>
					toTask(
						{
							id: `T${index + 1}`,
							title: `Step ${index + 1}`,
							instructions:
								asObject(step).action ??
								asObject(step).description ??
								`Execute step ${index + 1}`,
							tool: asObject(step).tool ?? "read_file",
							reasoning: asObject(step).reasoning ?? "",
							blockedBy: index > 0 ? [`T${index}`] : [],
						},
						index,
						index > 0 ? `T${index}` : undefined,
					),
				);

	const steps: CanonicalPlanStep[] =
		rawSteps.length > 0
			? rawSteps.map((step, index) => toStep(step, index, tasks[index]))
			: tasks.map((task, index) =>
					toStep(
						{
							step: index + 1,
							tool: task.tool,
							action: task.instructions,
							reasoning: task.reasoning,
						},
						index,
						task,
					),
				);

	const goal =
		String(source.goal ?? source.objective ?? "").trim() ||
		"Execute the requested plan";

	const estimatedToolCallsRaw = source.estimated_tool_calls;
	const estimatedToolCallsParsed =
		typeof estimatedToolCallsRaw === "number"
			? Math.floor(estimatedToolCallsRaw)
			: Number.parseInt(String(estimatedToolCallsRaw ?? ""), 10);
	const estimatedToolCalls =
		Number.isFinite(estimatedToolCallsParsed) && estimatedToolCallsParsed >= 0
			? estimatedToolCallsParsed
			: tasks.length;

	return {
		artifactType: "task_graph_v1",
		goal,
		repositoryRoot: String(source.repositoryRoot ?? "").trim(),
		constraints: {
			writeScope: "clone_root",
			sandbox: "strict",
			requireReadBeforeWrite:
				asObject(source.constraints).requireReadBeforeWrite !== false,
		},
		tasks,
		steps,
		executionHints: {
			suggestedOrder: toStringArray(
				asObject(source.executionHints).suggestedOrder,
			),
			maxTurns:
				typeof asObject(source.executionHints).maxTurns === "number"
					? Math.floor(asObject(source.executionHints).maxTurns as number)
					: null,
		},
		estimated_tool_calls: estimatedToolCalls,
		...(typeof source.planMarkdown === "string"
			? { planMarkdown: source.planMarkdown }
			: {}),
	};
}

export function formatPlanValidationIssues(
	error: z.ZodError,
): PlanValidationIssue[] {
	return error.issues.map((issue) => ({
		path: issue.path.length > 0 ? issue.path.join(".") : "$",
		message: issue.message,
		code: issue.code,
	}));
}

export function validateCanonicalPlan(input: unknown):
	| { success: true; plan: CanonicalPlan }
	| {
			success: false;
			issues: PlanValidationIssue[];
	  } {
	const parsed = CanonicalPlanSchema.safeParse(input);
	if (parsed.success) {
		return { success: true, plan: parsed.data };
	}
	return {
		success: false,
		issues: formatPlanValidationIssues(parsed.error),
	};
}

export function normalizeAndValidateCanonicalPlan(input: unknown):
	| { success: true; plan: CanonicalPlan }
	| {
			success: false;
			issues: PlanValidationIssue[];
	  } {
	const candidate = toCanonicalCandidate(input);
	return validateCanonicalPlan(candidate);
}
