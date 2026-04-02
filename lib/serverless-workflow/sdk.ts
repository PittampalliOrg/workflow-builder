import {
	Classes,
	type Specification,
	validate,
} from "@serverlessworkflow/sdk/esm/index.esm.min.js";

export type SWWorkflow = Specification.Workflow;

export type SWValidationIssue = {
	code: string;
	path: string;
	message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExpressionString(value: unknown): value is string {
	return typeof value === "string" && /^\s*\$\{.+\}\s*$/.test(value);
}

function collectSupportedRuntimeIssues(
	value: unknown,
	path = "/",
): SWValidationIssue[] {
	const issues: SWValidationIssue[] = [];

	if (typeof value === "string") {
		if (value.includes("{{") && value.includes("}}")) {
			issues.push({
				code: "UNSUPPORTED_LEGACY_TEMPLATE",
				path,
				message:
					"Legacy {{ ... }} template syntax is not supported for Serverless Workflow execution",
			});
		}

		const requiresExpression =
			path.endsWith("/input/from") ||
			path.endsWith("/output/as") ||
			path.endsWith("/if") ||
			path.endsWith("/for/in") ||
			(path.endsWith("/when") && path.includes("/switch/"));
		if (requiresExpression && value.trim() && !isExpressionString(value)) {
			issues.push({
				code: "UNSUPPORTED_EXPRESSION_SYNTAX",
				path,
				message:
					"This field must use jq runtime expressions wrapped in ${ ... }",
			});
		}

		return issues;
	}

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			issues.push(
				...collectSupportedRuntimeIssues(
					item,
					`${path}${path.endsWith("/") ? "" : "/"}${index}`,
				),
			);
		}
		return issues;
	}

	if (!isRecord(value)) {
		return issues;
	}

	for (const [key, nested] of Object.entries(value)) {
		issues.push(
			...collectSupportedRuntimeIssues(
				nested,
				`${path}${path.endsWith("/") ? "" : "/"}${key}`,
			),
		);
	}

	return issues;
}

function normalizeEventSourceUri(source: string): string {
	const trimmed = source.trim();
	if (!trimmed) {
		return "https://workflow-builder.local/events/event";
	}
	const normalizedSlug = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `https://workflow-builder.local/events/${normalizedSlug || "event"}`;
}

function repairTaskItems(
	tasks: unknown,
	actions: string[],
	path = "/do",
): void {
	if (!Array.isArray(tasks)) {
		return;
	}

	for (const [index, item] of tasks.entries()) {
		if (!isRecord(item)) {
			continue;
		}
		const [taskName, taskValue] = Object.entries(item)[0] ?? [];
		if (!taskName || !isRecord(taskValue)) {
			continue;
		}

		const taskPath = `${path}/${index}/${taskName}`;
		const forConfig = isRecord(taskValue.for) ? taskValue.for : null;
		if (
			forConfig &&
			Array.isArray(forConfig.do) &&
			!Array.isArray(taskValue.do)
		) {
			taskValue.do = forConfig.do;
			delete forConfig.do;
			actions.push(`Moved nested for.do array to ${taskPath}.do`);
		}

		const emitEvent =
			isRecord(taskValue.emit) && isRecord(taskValue.emit.event)
				? taskValue.emit.event
				: null;
		if (emitEvent && !("with" in emitEvent)) {
			taskValue.emit = {
				event: {
					with: emitEvent,
				},
			};
			actions.push(`Wrapped ${taskPath}.emit.event fields in emit.event.with`);
		}
		const emitEventWith =
			isRecord(taskValue.emit) &&
			isRecord(taskValue.emit.event) &&
			isRecord(taskValue.emit.event.with)
				? taskValue.emit.event.with
				: null;
		if (
			emitEventWith &&
			typeof emitEventWith.source === "string" &&
			!emitEventWith.source.includes("://") &&
			!emitEventWith.source.startsWith("urn:") &&
			!isExpressionString(emitEventWith.source)
		) {
			const previousSource = emitEventWith.source;
			emitEventWith.source = normalizeEventSourceUri(previousSource);
			actions.push(
				`Converted ${taskPath}.emit.event.with.source to URI form (${emitEventWith.source})`,
			);
		}

		if (Array.isArray(taskValue.switch)) {
			const repairedCases = taskValue.switch.flatMap((caseValue) => {
				if (!isRecord(caseValue)) {
					return [caseValue];
				}
				const entries = Object.entries(caseValue);
				if (entries.length <= 1) {
					return [caseValue];
				}
				actions.push(
					`Split multi-key switch case at ${taskPath}.switch into one-case entries`,
				);
				return entries.map(([key, value]) => ({ [key]: value }));
			});
			taskValue.switch = repairedCases;
		}

		if (Array.isArray(taskValue.do)) {
			repairTaskItems(taskValue.do, actions, `${taskPath}/do`);
		}
		if (Array.isArray(taskValue.try)) {
			repairTaskItems(taskValue.try, actions, `${taskPath}/try`);
		}
		if (isRecord(taskValue.catch) && Array.isArray(taskValue.catch.do)) {
			repairTaskItems(taskValue.catch.do, actions, `${taskPath}/catch/do`);
		}
		if (isRecord(taskValue.fork) && Array.isArray(taskValue.fork.branches)) {
			for (const [branchIndex, branch] of taskValue.fork.branches.entries()) {
				repairTaskItems(
					branch,
					actions,
					`${taskPath}/fork/branches/${branchIndex}`,
				);
			}
		}
	}
}

export function repairWorkflowDefinitionShape(workflow: unknown): {
	workflow: unknown;
	actions: string[];
} {
	if (!workflow || typeof workflow !== "object") {
		return { workflow, actions: [] };
	}

	const cloned = JSON.parse(JSON.stringify(workflow)) as Record<
		string,
		unknown
	>;
	const actions: string[] = [];
	const document =
		cloned.document && typeof cloned.document === "object"
			? (cloned.document as Record<string, unknown>)
			: null;

	if (
		document &&
		typeof document.description === "string" &&
		typeof document.summary !== "string"
	) {
		document.summary = document.description;
		actions.push("Converted document.description to document.summary");
	}

	if (document && "description" in document) {
		delete document.description;
	}

	repairTaskItems(cloned.do, actions);

	return { workflow: cloned, actions };
}

function parseValidationMessage(message: string): SWValidationIssue[] {
	const issues = message
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => {
			const withoutBullet = line.slice(2);
			const parts = withoutBullet.split(" | ").map((part) => part.trim());
			return {
				code: "INVALID_WORKFLOW",
				path: parts[0] || "/",
				message: parts[2] || parts.at(-1) || withoutBullet,
			} satisfies SWValidationIssue;
		});
	return issues.length > 0
		? issues
		: [{ code: "INVALID_WORKFLOW", path: "/", message }];
}

function toPlainWorkflow(
	workflow: Partial<Specification.Workflow>,
): SWWorkflow {
	return JSON.parse(
		Classes.Workflow.serialize(workflow, "json", true),
	) as SWWorkflow;
}

export function validateWorkflowDefinition(
	workflow: unknown,
): SWValidationIssue[] {
	const repairedWorkflow = repairWorkflowDefinitionShape(workflow).workflow;
	const runtimeIssues = collectSupportedRuntimeIssues(repairedWorkflow);
	if (runtimeIssues.length > 0) {
		return runtimeIssues;
	}
	try {
		validate("Workflow", repairedWorkflow);
		return [];
	} catch (error) {
		return parseValidationMessage(
			error instanceof Error ? error.message : "Invalid workflow definition",
		);
	}
}

export function isWorkflowDefinition(
	workflow: unknown,
): workflow is SWWorkflow {
	if (!workflow || typeof workflow !== "object") {
		return false;
	}
	const document = (workflow as Record<string, unknown>).document;
	if (!document || typeof document !== "object") {
		return false;
	}
	return validateWorkflowDefinition(workflow).length === 0;
}

export function normalizeWorkflowDefinition(workflow: unknown): SWWorkflow {
	const repairedWorkflow = repairWorkflowDefinitionShape(workflow).workflow;
	const issues = validateWorkflowDefinition(repairedWorkflow);
	if (issues.length > 0) {
		throw new Error(
			issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
		);
	}
	return toPlainWorkflow(repairedWorkflow as Partial<Specification.Workflow>);
}

export function parseWorkflowDefinition(source: string): SWWorkflow {
	try {
		const parsed = Classes.Workflow.deserialize(source);
		return toPlainWorkflow(parsed);
	} catch (error) {
		throw new Error(
			error instanceof Error
				? error.message
				: "Failed to parse Serverless Workflow definition",
		);
	}
}

export function serializeWorkflowDefinition(
	workflow: unknown,
	format: "yaml" | "json" = "yaml",
): string {
	return Classes.Workflow.serialize(
		normalizeWorkflowDefinition(workflow),
		format,
		true,
	);
}
