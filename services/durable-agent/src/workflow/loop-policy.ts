import { celEnv, isCelError, parse, plan, type CelInput } from "@bufbuild/cel";
import type {
	LoopDeclarationOnlyTool,
	LoopPolicy,
	LoopPreparedStep,
	LoopPrepareStepRule,
	LoopStepRecord,
	LoopStopCondition,
	LoopToolChoice,
	LoopUsage,
} from "../types/loop-policy.js";

type NormalizedPrepareRule = {
	fromStep?: number;
	toStep?: number;
	when?: string;
	modelSpec?: string;
	activeTools?: string[];
	toolChoice?: LoopToolChoice;
	trimMessagesTo?: number;
	truncateToolResultChars?: number;
	appendInstructions?: string;
};

export type NormalizedLoopPolicy = {
	stopWhen: LoopStopCondition[];
	approvalRequiredTools: Set<string>;
	defaultModelSpec?: string;
	defaultActiveTools?: string[];
	defaultToolChoice?: LoopToolChoice;
	defaultTrimMessagesTo?: number;
	defaultTruncateToolResultChars?: number;
	defaultAppendInstructions?: string;
	prepareRules: NormalizedPrepareRule[];
	declarationOnlyTools: LoopDeclarationOnlyTool[];
	doneToolResponseField?: string;
};

export type LoopStopEvaluation = {
	shouldStop: boolean;
	reason?: string;
	condition?: LoopStopCondition;
};

type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

type CelBindings = Record<string, unknown>;

const DEFAULT_DONE_TOOL_NAME = "done";
const DEFAULT_DONE_TOOL_DESCRIPTION =
	"Signal that you have completed all required work.";
const DEFAULT_DONE_TOOL_RESPONSE_FIELD = "answer";
const celEnvironment = celEnv();
const compiledCelPrograms = new Map<
	string,
	(ctx?: Record<string, CelInput>) => unknown
>();

function evalCelBoolean(
	expression: string,
	context: Record<string, unknown>,
): boolean {
	try {
		let evaluator = compiledCelPrograms.get(expression);
		if (!evaluator) {
			evaluator = plan(celEnvironment, parse(expression));
			compiledCelPrograms.set(expression, evaluator);
		}
		const result = evaluator(context as Record<string, CelInput>);
		if (isCelError(result)) {
			throw result;
		}
		return result === true;
	} catch (err) {
		console.warn(
			`[loop-policy] CEL expression failed (${expression.slice(0, 80)}):`,
			err,
		);
		return false;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((entry) => asString(entry))
		.filter((entry): entry is string => Boolean(entry));
	return items.length > 0 ? [...new Set(items)] : undefined;
}

function normalizeToolChoice(value: unknown): LoopToolChoice | undefined {
	if (value === "auto" || value === "required" || value === "none") {
		return value;
	}
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.type !== "tool") return undefined;
	const toolName = asString(record.toolName);
	if (!toolName) return undefined;
	return { type: "tool", toolName };
}

function normalizeStopCondition(value: unknown): LoopStopCondition | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const type = asString(record.type);
	if (!type) return undefined;

	if (type === "stepCountIs") {
		const maxSteps = asNumber(record.maxSteps);
		if (!maxSteps || maxSteps < 1) return undefined;
		return { type, maxSteps: Math.floor(maxSteps) };
	}

	if (type === "hasToolCall") {
		const toolName = asString(record.toolName);
		if (!toolName) return undefined;
		return { type, toolName };
	}

	if (type === "toolCallNeedsApproval") {
		const toolNames = normalizeStringArray(record.toolNames);
		return toolNames ? { type, toolNames } : { type };
	}

	if (type === "toolWithoutExecute") {
		return { type };
	}

	if (type === "assistantTextIncludes") {
		const text = asString(record.text);
		if (!text) return undefined;
		return {
			type,
			text,
			caseSensitive: record.caseSensitive === true,
		};
	}

	if (type === "assistantTextMatchesRegex") {
		const pattern = asString(record.pattern);
		if (!pattern) return undefined;
		const flags = asString(record.flags);
		return flags ? { type, pattern, flags } : { type, pattern };
	}

	if (type === "totalUsageAtLeast") {
		const inputTokens = asNumber(record.inputTokens);
		const outputTokens = asNumber(record.outputTokens);
		const totalTokens = asNumber(record.totalTokens);
		if (inputTokens == null && outputTokens == null && totalTokens == null) {
			return undefined;
		}
		return {
			type,
			...(inputTokens != null ? { inputTokens: Math.max(0, inputTokens) } : {}),
			...(outputTokens != null
				? { outputTokens: Math.max(0, outputTokens) }
				: {}),
			...(totalTokens != null ? { totalTokens: Math.max(0, totalTokens) } : {}),
		};
	}

	if (type === "costEstimateExceeds") {
		const usd = asNumber(record.usd);
		if (usd == null || usd < 0) return undefined;
		const inputPer1kUsd = asNumber(record.inputPer1kUsd);
		const outputPer1kUsd = asNumber(record.outputPer1kUsd);
		return {
			type,
			usd,
			...(inputPer1kUsd != null ? { inputPer1kUsd } : {}),
			...(outputPer1kUsd != null ? { outputPer1kUsd } : {}),
		};
	}

	if (type === "celExpression") {
		const expression = asString(record.expression);
		if (!expression) return undefined;
		return { type, expression };
	}

	return undefined;
}

function normalizePrepareRule(
	value: unknown,
): NormalizedPrepareRule | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const fromStepRaw = asNumber(record.fromStep);
	const toStepRaw = asNumber(record.toStep);
	const fromStep =
		fromStepRaw != null && fromStepRaw >= 1
			? Math.floor(fromStepRaw)
			: undefined;
	const toStep =
		toStepRaw != null && toStepRaw >= 1 ? Math.floor(toStepRaw) : undefined;
	if (fromStep != null && toStep != null && fromStep > toStep) {
		return undefined;
	}

	const normalized: NormalizedPrepareRule = {
		...(fromStep != null ? { fromStep } : {}),
		...(toStep != null ? { toStep } : {}),
		...(asString(record.when) ? { when: asString(record.when) } : {}),
		...(asString(record.model) ? { modelSpec: asString(record.model) } : {}),
		...(normalizeStringArray(record.activeTools)
			? { activeTools: normalizeStringArray(record.activeTools) }
			: {}),
		...(normalizeToolChoice(record.toolChoice)
			? { toolChoice: normalizeToolChoice(record.toolChoice) }
			: {}),
		...(asNumber(record.trimMessagesTo) != null
			? {
					trimMessagesTo: Math.max(
						1,
						Math.floor(asNumber(record.trimMessagesTo)!),
					),
				}
			: {}),
		...(asNumber(record.truncateToolResultChars) != null
			? {
					truncateToolResultChars: Math.max(
						64,
						Math.floor(asNumber(record.truncateToolResultChars)!),
					),
				}
			: {}),
		...(asString(record.appendInstructions)
			? { appendInstructions: asString(record.appendInstructions) }
			: {}),
	};

	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePrepareStepPolicy(value: unknown): {
	defaultModelSpec?: string;
	defaultActiveTools?: string[];
	defaultToolChoice?: LoopToolChoice;
	defaultTrimMessagesTo?: number;
	defaultTruncateToolResultChars?: number;
	defaultAppendInstructions?: string;
	prepareRules: NormalizedPrepareRule[];
} {
	const record = asRecord(value);
	if (!record) {
		return { prepareRules: [] };
	}

	const rules = Array.isArray(record.rules)
		? record.rules
				.map((rule) => normalizePrepareRule(rule))
				.filter((rule): rule is NormalizedPrepareRule => Boolean(rule))
		: [];

	const trimMessagesToRaw = asNumber(record.trimMessagesTo);
	const truncateToolResultCharsRaw = asNumber(record.truncateToolResultChars);

	return {
		...(asString(record.model)
			? { defaultModelSpec: asString(record.model) }
			: {}),
		...(normalizeStringArray(record.activeTools)
			? { defaultActiveTools: normalizeStringArray(record.activeTools) }
			: {}),
		...(normalizeToolChoice(record.toolChoice)
			? { defaultToolChoice: normalizeToolChoice(record.toolChoice) }
			: {}),
		...(trimMessagesToRaw != null
			? { defaultTrimMessagesTo: Math.max(1, Math.floor(trimMessagesToRaw)) }
			: {}),
		...(truncateToolResultCharsRaw != null
			? {
					defaultTruncateToolResultChars: Math.max(
						64,
						Math.floor(truncateToolResultCharsRaw),
					),
				}
			: {}),
		...(asString(record.appendInstructions)
			? { defaultAppendInstructions: asString(record.appendInstructions) }
			: {}),
		prepareRules: rules,
	};
}

function buildDoneToolDeclaration(
	policy: LoopPolicy,
): { tool: LoopDeclarationOnlyTool; responseField: string } | null {
	const doneTool = asRecord(policy.doneTool);
	if (!doneTool) return null;
	if (doneTool.enabled === false) return null;

	const name = asString(doneTool.name) ?? DEFAULT_DONE_TOOL_NAME;
	const description =
		asString(doneTool.description) ?? DEFAULT_DONE_TOOL_DESCRIPTION;
	const responseField =
		asString(doneTool.responseField) ?? DEFAULT_DONE_TOOL_RESPONSE_FIELD;
	const providedSchema = doneTool.inputSchema;
	const schema =
		providedSchema && typeof providedSchema === "object"
			? providedSchema
			: {
					type: "object",
					properties: {
						[responseField]: {
							type: "string",
							description: "The final answer.",
						},
					},
					required: [responseField],
				};

	return {
		tool: {
			name,
			description,
			inputSchema: schema,
		},
		responseField,
	};
}

export function normalizeLoopPolicy(raw: unknown): NormalizedLoopPolicy {
	const policy = (asRecord(raw) as LoopPolicy | null) ?? {};
	const stopWhenRaw = policy.stopWhen;
	const rawConditions = Array.isArray(stopWhenRaw)
		? stopWhenRaw
		: stopWhenRaw
			? [stopWhenRaw]
			: [];
	const stopWhen = rawConditions
		.map((condition) => normalizeStopCondition(condition))
		.filter((condition): condition is LoopStopCondition => Boolean(condition));
	const approvalRequiredTools = new Set(
		(normalizeStringArray(policy.approvalRequiredTools) ?? []).map((name) =>
			name.trim().toLowerCase(),
		),
	);
	const prepare = normalizePrepareStepPolicy(policy.prepareStep);
	const defaultToolChoice = normalizeToolChoice(policy.defaultToolChoice);
	const defaultActiveTools = normalizeStringArray(policy.defaultActiveTools);
	const doneTool = buildDoneToolDeclaration(policy);

	return {
		stopWhen,
		approvalRequiredTools,
		...prepare,
		...(defaultToolChoice ? { defaultToolChoice } : {}),
		...(defaultActiveTools ? { defaultActiveTools } : {}),
		declarationOnlyTools: doneTool ? [doneTool.tool] : [],
		...(doneTool ? { doneToolResponseField: doneTool.responseField } : {}),
	};
}

function stepInRuleRange(
	stepNumber: number,
	rule: NormalizedPrepareRule,
): boolean {
	if (rule.fromStep != null && stepNumber < rule.fromStep) return false;
	if (rule.toStep != null && stepNumber > rule.toStep) return false;
	return true;
}

function mergeDefined<T>(
	base: T | undefined,
	next: T | undefined,
): T | undefined {
	return next !== undefined ? next : base;
}

export function prepareLoopStep(
	policy: NormalizedLoopPolicy,
	stepNumber: number,
	celBindings?: CelBindings,
): LoopPreparedStep {
	let modelSpec = policy.defaultModelSpec;
	let activeTools = policy.defaultActiveTools;
	let toolChoice = policy.defaultToolChoice;
	let trimMessagesTo = policy.defaultTrimMessagesTo;
	let truncateToolResultChars = policy.defaultTruncateToolResultChars;
	let appendInstructions = policy.defaultAppendInstructions;

	for (const rule of policy.prepareRules) {
		if (!stepInRuleRange(stepNumber, rule)) continue;
		if (
			rule.when &&
			!(celBindings ? evalCelBoolean(rule.when, celBindings) : false)
		) {
			continue;
		}
		modelSpec = mergeDefined(modelSpec, rule.modelSpec);
		activeTools = mergeDefined(activeTools, rule.activeTools);
		toolChoice = mergeDefined(toolChoice, rule.toolChoice);
		trimMessagesTo = mergeDefined(trimMessagesTo, rule.trimMessagesTo);
		truncateToolResultChars = mergeDefined(
			truncateToolResultChars,
			rule.truncateToolResultChars,
		);
		appendInstructions = mergeDefined(
			appendInstructions,
			rule.appendInstructions,
		);
	}

	return {
		...(modelSpec ? { modelSpec } : {}),
		...(activeTools && activeTools.length > 0 ? { activeTools } : {}),
		...(toolChoice ? { toolChoice } : {}),
		...(trimMessagesTo != null ? { trimMessagesTo } : {}),
		...(truncateToolResultChars != null ? { truncateToolResultChars } : {}),
		...(appendInstructions ? { appendInstructions } : {}),
		...(policy.declarationOnlyTools.length > 0
			? { declarationOnlyTools: policy.declarationOnlyTools }
			: {}),
	};
}

export function computeUsageTotals(steps: LoopStepRecord[]): UsageTotals {
	return steps.reduce<UsageTotals>(
		(acc, step) => ({
			inputTokens: acc.inputTokens + (step.usage?.inputTokens ?? 0),
			outputTokens: acc.outputTokens + (step.usage?.outputTokens ?? 0),
			totalTokens: acc.totalTokens + (step.usage?.totalTokens ?? 0),
		}),
		{ inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	);
}

function isApprovalRequired(
	toolName: string,
	conditionToolNames: string[] | undefined,
	approvalRequiredTools: Set<string>,
): boolean {
	const normalized = toolName.trim().toLowerCase();
	if (conditionToolNames && conditionToolNames.length > 0) {
		return conditionToolNames.some(
			(name) => name.trim().toLowerCase() === normalized,
		);
	}
	return approvalRequiredTools.has(normalized);
}

export function evaluateStopConditions(input: {
	policy: NormalizedLoopPolicy;
	currentStep: LoopStepRecord;
	allSteps: LoopStepRecord[];
	executableByToolName: Map<string, boolean>;
	approvalRequiredTools?: Set<string>;
	celBindings?: CelBindings;
}): LoopStopEvaluation {
	const { policy, currentStep, allSteps, executableByToolName } = input;
	const approvalRequiredTools =
		input.approvalRequiredTools ?? policy.approvalRequiredTools;
	if (policy.stopWhen.length === 0) {
		return { shouldStop: false };
	}

	const totals = computeUsageTotals(allSteps);
	for (const condition of policy.stopWhen) {
		if (condition.type === "stepCountIs") {
			if (currentStep.stepNumber >= condition.maxSteps) {
				return {
					shouldStop: true,
					reason: `stopWhen.stepCountIs(${condition.maxSteps}) matched at step ${currentStep.stepNumber}`,
					condition,
				};
			}
			continue;
		}

		if (condition.type === "hasToolCall") {
			const matched = currentStep.toolCalls.some(
				(tc) =>
					tc.function.name.trim().toLowerCase() ===
					condition.toolName.trim().toLowerCase(),
			);
			if (matched) {
				return {
					shouldStop: true,
					reason: `stopWhen.hasToolCall(${condition.toolName}) matched`,
					condition,
				};
			}
			continue;
		}

		if (condition.type === "toolWithoutExecute") {
			const matched = currentStep.toolCalls.some(
				(tc) => executableByToolName.get(tc.function.name) !== true,
			);
			if (matched) {
				return {
					shouldStop: true,
					reason: "stopWhen.toolWithoutExecute matched",
					condition,
				};
			}
			continue;
		}

		if (condition.type === "toolCallNeedsApproval") {
			const matched = currentStep.toolCalls.some((tc) =>
				isApprovalRequired(
					tc.function.name,
					condition.toolNames,
					approvalRequiredTools,
				),
			);
			if (matched) {
				return {
					shouldStop: true,
					reason: "stopWhen.toolCallNeedsApproval matched",
					condition,
				};
			}
			continue;
		}

		if (condition.type === "assistantTextIncludes") {
			const haystack = condition.caseSensitive
				? (currentStep.assistantText ?? "")
				: (currentStep.assistantText ?? "").toLowerCase();
			const needle = condition.caseSensitive
				? condition.text
				: condition.text.toLowerCase();
			if (needle && haystack.includes(needle)) {
				return {
					shouldStop: true,
					reason: `stopWhen.assistantTextIncludes("${condition.text}") matched`,
					condition,
				};
			}
			continue;
		}

		if (condition.type === "assistantTextMatchesRegex") {
			try {
				const regex = new RegExp(condition.pattern, condition.flags);
				if (regex.test(currentStep.assistantText ?? "")) {
					return {
						shouldStop: true,
						reason: `stopWhen.assistantTextMatchesRegex(${condition.pattern}) matched`,
						condition,
					};
				}
			} catch {
				// Ignore invalid regex patterns.
			}
			continue;
		}

		if (condition.type === "totalUsageAtLeast") {
			const inputReached =
				condition.inputTokens == null ||
				totals.inputTokens >= condition.inputTokens;
			const outputReached =
				condition.outputTokens == null ||
				totals.outputTokens >= condition.outputTokens;
			const totalReached =
				condition.totalTokens == null ||
				totals.totalTokens >= condition.totalTokens;
			if (inputReached && outputReached && totalReached) {
				return {
					shouldStop: true,
					reason: "stopWhen.totalUsageAtLeast matched",
					condition,
				};
			}
			continue;
		}

		if (condition.type === "costEstimateExceeds") {
			const inputPer1kUsd = condition.inputPer1kUsd ?? 0;
			const outputPer1kUsd = condition.outputPer1kUsd ?? 0;
			const estimate =
				(totals.inputTokens * inputPer1kUsd +
					totals.outputTokens * outputPer1kUsd) /
				1000;
			if (estimate >= condition.usd) {
				return {
					shouldStop: true,
					reason: `stopWhen.costEstimateExceeds(${condition.usd}) matched at $${estimate.toFixed(4)}`,
					condition,
				};
			}
		}

		if (condition.type === "celExpression") {
			if (
				input.celBindings &&
				evalCelBoolean(condition.expression, input.celBindings)
			) {
				return {
					shouldStop: true,
					reason: "stopWhen.celExpression matched",
					condition,
				};
			}
		}
	}

	return { shouldStop: false };
}

export function usageFromUnknown(value: unknown): LoopUsage | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const inputTokens = asNumber(record.inputTokens);
	const outputTokens = asNumber(record.outputTokens);
	const totalTokens = asNumber(record.totalTokens);
	if (inputTokens == null && outputTokens == null && totalTokens == null) {
		return undefined;
	}
	return {
		...(inputTokens != null ? { inputTokens } : {}),
		...(outputTokens != null ? { outputTokens } : {}),
		...(totalTokens != null ? { totalTokens } : {}),
	};
}
