import { z } from "zod";
import type {
	ActionConfigFieldBase,
	ActionDefinition,
} from "@/lib/actions/types";
import { flattenConfigFields } from "@/lib/actions/utils";

const TEMPLATE_HINT =
	"Template strings like {{@nodeId:Label.field}} are allowed.";

function isTemplateString(value: unknown): boolean {
	return (
		typeof value === "string" && value.includes("{{") && value.includes("}}")
	);
}

function shouldShowField(
	field: { showWhen?: { field: string; equals: string } },
	config: Record<string, unknown>,
): boolean {
	if (!field.showWhen) return true;
	return config[field.showWhen.field] === field.showWhen.equals;
}

function baseFieldSchema(field: ActionConfigFieldBase): z.ZodTypeAny {
	switch (field.type) {
		case "template-textarea":
			// Textareas often store JSON strings in the UI, but allow JSON literals too.
			// We later normalize objects/arrays back to strings before persisting.
			return z.union([
				z.string().describe(TEMPLATE_HINT),
				z.array(z.unknown()),
				z.object({}).passthrough(),
				z.number(),
				z.boolean(),
				z.null(),
			]);
		case "number":
			// UI stores number inputs as strings, but allow numeric literals too.
			// Detailed validation (required, template vs numeric, min) happens in superRefine.
			return z.union([z.number(), z.string().describe(TEMPLATE_HINT)]);
		case "select": {
			const allowed = field.options?.map((o) => o.value) || [];
			if (allowed.length === 0) {
				return z.string();
			}
			// Allow either a valid enum value, or a template string.
			return z.string().superRefine((val, ctx) => {
				if (val.trim() === "") return;
				if (isTemplateString(val)) return;
				if (!allowed.includes(val)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Invalid value "${val}". Allowed: ${allowed.join(", ")}`,
					});
				}
			});
		}
		case "schema-builder":
			// Stored as JSON string in the UI. Accept templates too.
			return z.string().superRefine((val, ctx) => {
				if (val.trim() === "") return;
				if (isTemplateString(val)) return;
				try {
					const parsed = JSON.parse(val) as unknown;
					if (!Array.isArray(parsed)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "Schema must be a JSON array.",
						});
					}
				} catch {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Schema must be valid JSON.",
					});
				}
			});
		default:
			return z.string();
	}
}

export function buildActionConfigSchema(
	action: ActionDefinition,
): z.ZodTypeAny {
	const flat = flattenConfigFields(action.configFields);

	// Start with optional fields, enforce required/showWhen in superRefine.
	const shape: Record<string, z.ZodTypeAny> = {
		actionType: z.literal(action.id),
		integrationId: z.string().optional(),
		auth: z.string().optional(),
	};

	for (const field of flat) {
		shape[field.key] = baseFieldSchema(field).optional();
	}

	return z
		.object(shape)
		.passthrough()
		.superRefine((config, ctx) => {
			for (const field of flat) {
				const shown = shouldShowField(field, config);
				if (!shown) continue;

				const val = config[field.key];
				if (field.required) {
					if (val === undefined || val === null) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: [field.key],
							message: `Missing required field "${field.label}" (${field.key}).`,
						});
						continue;
					}
					if (typeof val === "string" && val.trim() === "") {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: [field.key],
							message: `Missing required field "${field.label}" (${field.key}).`,
						});
					}
				}

				// Enforce number typing + min when not a template.
				if (field.type === "number") {
					if (val === undefined || val === null) continue;
					if (typeof val === "string" && val.trim() === "") continue;
					if (typeof val === "string" && isTemplateString(val)) continue;

					let n: number | null = null;
					if (typeof val === "number") {
						n = val;
					} else if (typeof val === "string") {
						// Ensure it is a number-like string (UI stores numbers as strings).
						const trimmed = val.trim();
						if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: [field.key],
								message: `Expected a number.`,
							});
							continue;
						}
						n = Number(trimmed);
					} else {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: [field.key],
							message: `Expected a number.`,
						});
						continue;
					}

					if (field.min !== undefined && n < field.min) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: [field.key],
							message: `Value must be >= ${field.min}.`,
						});
					}
				}
			}
		});
}
