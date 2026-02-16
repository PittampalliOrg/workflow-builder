import { z } from "zod";

export const WORKFLOW_SPEC_API_VERSION = "workflow-spec/v1" as const;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| { [key: string]: JsonValue }
	| JsonValue[];

// Provider-safe JSON value schema for LLM structured output:
// - Avoids `z.unknown()` which becomes `{}` in JSON Schema (rejected by some providers).
// - Avoids `z.record()` which emits `propertyNames` (rejected by some providers).
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

export const TriggerSpecSchema = z.object({
	id: IdSchema.default("trigger"),
	type: z.enum(["manual", "webhook"]),
	// Flexible JSON bag (also safe for LLM structured output providers).
	config: z.object({}).catchall(JsonValueSchema).optional().default({}),
	next: z.union([IdSchema, z.array(IdSchema).min(1)]).optional(),
});

export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

const BaseStepSpecSchema = z.object({
	id: IdSchema,
	label: z.string().min(1),
	description: z.string().optional(),
	enabled: z.boolean().optional().default(true),
});

const NextLinearSchema = z.union([IdSchema, z.array(IdSchema).min(1)]);
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

export const ApprovalGateStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("approval-gate"),
	config: z.object({
		eventName: z.string().min(1),
		timeoutSeconds: z.number().int().positive().optional(),
		approvers: z.array(z.string().min(1)).optional(),
		message: z.string().optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const TimerStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("timer"),
	config: z.object({
		durationSeconds: z.number().int().positive().optional(),
		durationMinutes: z.number().int().positive().optional(),
		durationHours: z.number().int().positive().optional(),
		label: z.string().optional(),
	}),
	next: NextLinearSchema.optional(),
});

export const IfElseStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("if-else"),
	config: z.object({
		operator: z.string().min(1).optional().default("EXISTS"),
		left: JsonValueSchema,
		right: JsonValueSchema.optional(),
	}),
	next: NextIfElseSchema,
});

export const LoopUntilStepSpecSchema = BaseStepSpecSchema.extend({
	kind: z.literal("loop-until"),
	config: z.object({
		operator: z.string().min(1).optional().default("EXISTS"),
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
		template: JsonValueSchema,
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
	ApprovalGateStepSpecSchema,
	TimerStepSpecSchema,
	IfElseStepSpecSchema,
	LoopUntilStepSpecSchema,
	SetStateStepSpecSchema,
	TransformStepSpecSchema,
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
