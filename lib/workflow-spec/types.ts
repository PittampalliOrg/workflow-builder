import { z } from "zod";

export const WORKFLOW_SPEC_API_VERSION = "workflow-spec/v2" as const;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| { [key: string]: JsonValue }
	| JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.object({}).catchall(JsonValueSchema),
	]),
);

const IdSchema = z
	.string()
	.min(1)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid id format");

const NextLinearSchema = z.union([IdSchema, z.array(IdSchema).min(1)]);

export const ConditionOperatorSchema = z.enum([
	"TEXT_CONTAINS",
	"TEXT_DOES_NOT_CONTAIN",
	"TEXT_EXACTLY_MATCHES",
	"TEXT_DOES_NOT_EXACTLY_MATCH",
	"TEXT_STARTS_WITH",
	"TEXT_DOES_NOT_START_WITH",
	"TEXT_ENDS_WITH",
	"TEXT_DOES_NOT_END_WITH",
	"TEXT_IS_EMPTY",
	"TEXT_IS_NOT_EMPTY",
	"NUMBER_IS_GREATER_THAN",
	"NUMBER_IS_LESS_THAN",
	"NUMBER_IS_EQUAL_TO",
	"BOOLEAN_IS_TRUE",
	"BOOLEAN_IS_FALSE",
	"EXISTS",
	"DOES_NOT_EXIST",
	"LIST_CONTAINS",
	"LIST_DOES_NOT_CONTAIN",
	"LIST_IS_EMPTY",
	"LIST_IS_NOT_EMPTY",
]);

const TriggerBaseSchema = z.object({
	id: IdSchema.default("trigger"),
	next: NextLinearSchema.optional(),
});

const TriggerManualSchema = TriggerBaseSchema.extend({
	type: z.literal("manual"),
	config: z.object({}).catchall(JsonValueSchema).optional().default({}),
});

const TriggerWebhookSchema = TriggerBaseSchema.extend({
	type: z.literal("webhook"),
	config: z
		.object({
			webhookSchema: JsonValueSchema.optional(),
			webhookMockRequest: z.string().optional(),
		})
		.catchall(JsonValueSchema)
		.optional()
		.default({}),
});

const TriggerScheduleSchema = TriggerBaseSchema.extend({
	type: z.literal("schedule"),
	config: z.object({
		scheduleCron: z.string().min(1),
		scheduleTimezone: z.string().min(1),
	}),
});

const TriggerMcpSchema = TriggerBaseSchema.extend({
	type: z.literal("mcp"),
	config: z.object({
		toolName: z.string().min(1),
		toolDescription: z.string().optional(),
		inputSchema: JsonValueSchema.optional(),
		returnsResponse: z.boolean().optional().default(false),
		enabled: z.boolean().optional().default(true),
	}),
});

export const TriggerSpecSchema = z.discriminatedUnion("type", [
	TriggerManualSchema,
	TriggerWebhookSchema,
	TriggerScheduleSchema,
	TriggerMcpSchema,
]);

export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

const BaseStepSpecSchema = z.object({
	id: IdSchema,
	label: z.string().min(1),
	description: z.string().optional(),
	enabled: z.boolean().optional().default(true),
});

const NextIfElseSchema = z.object({
	true: NextLinearSchema,
	false: NextLinearSchema,
});

export const ActionStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("action"),
	config: z
		.object({
			actionType: z.string().min(1),
		})
		.catchall(JsonValueSchema),
	next: NextLinearSchema.optional(),
});

export const ActivityStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("activity"),
	config: z
		.object({
			activityName: z.string().min(1),
		})
		.catchall(JsonValueSchema),
	next: NextLinearSchema.optional(),
});

export const ApprovalGateStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("approval-gate"),
	config: z.object({
		eventName: z.string().min(1),
		timeoutSeconds: z.number().int().positive().optional(),
		timeoutMinutes: z.number().int().positive().optional(),
		timeoutHours: z.number().int().positive().optional(),
		approvers: z.array(z.string().min(1)).optional(),
		message: z.string().optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const TimerStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("timer"),
	config: z.object({
		duration: z.number().int().positive(),
		durationUnit: z.enum(["seconds", "minutes", "hours", "days"]),
		timerDescription: z.string().optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const IfElseStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("if-else"),
	config: z.object({
		operator: ConditionOperatorSchema.optional().default("EXISTS"),
		left: JsonValueSchema,
		right: JsonValueSchema.optional(),
	}),
	next: NextIfElseSchema,
});

export const LoopUntilStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("loop-until"),
	config: z.object({
		operator: ConditionOperatorSchema.optional().default("EXISTS"),
		left: JsonValueSchema,
		right: JsonValueSchema.optional(),
		loopStartNodeId: IdSchema,
		maxIterations: z.number().int().positive().optional(),
		delaySeconds: z.number().int().nonnegative().optional(),
		onMaxIterations: z.enum(["continue", "fail"]).optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const SetStateStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("set-state"),
	config: z.object({
		key: z.string().min(1),
		value: JsonValueSchema,
	}),
	next: NextLinearSchema.optional(),
});

export const TransformStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("transform"),
	config: z.object({
		templateJson: z.string().min(1),
	}),
	next: NextLinearSchema.optional(),
});

export const WorkflowControlStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("workflow-control"),
	config: z.object({
		mode: z.enum(["stop", "continue"]).optional().default("stop"),
		reason: z.string().optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const PublishEventStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("publish-event"),
	config: z.object({
		topic: z.string().min(1),
		eventType: z.string().min(1),
		data: JsonValueSchema.optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const NoteStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("note"),
	config: z.object({}).catchall(JsonValueSchema).optional().default({}),
	next: NextLinearSchema.optional(),
});

export const StepSpecSchema = z.discriminatedUnion("kind", [
	ActionStepSpecSchema,
	ActivityStepSpecSchema,
	ApprovalGateStepSpecSchema,
	TimerStepSpecSchema,
	IfElseStepSpecSchema,
	LoopUntilStepSpecSchema,
	SetStateStepSpecSchema,
	TransformStepSpecSchema,
	WorkflowControlStepSpecSchema,
	PublishEventStepSpecSchema,
	NoteStepSpecSchema,
]);

export type StepSpec = z.infer<typeof StepSpecSchema>;

export const WorkflowSpecSchema = z.object({
	apiVersion: z.literal(WORKFLOW_SPEC_API_VERSION),
	name: z.string().min(1),
	description: z.string().optional(),
	metadata: z
		.object({
			tags: z.array(z.string().min(1)).optional(),
			author: z.string().min(1).optional(),
		})
		.optional(),
	trigger: TriggerSpecSchema,
	steps: z.array(StepSpecSchema).min(1),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export function parseWorkflowSpec(input: unknown): WorkflowSpec {
	return WorkflowSpecSchema.parse(input);
}
