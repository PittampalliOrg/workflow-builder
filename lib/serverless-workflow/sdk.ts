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
	try {
		validate("Workflow", workflow);
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
	const issues = validateWorkflowDefinition(workflow);
	if (issues.length > 0) {
		throw new Error(
			issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
		);
	}
	return toPlainWorkflow(workflow as Partial<Specification.Workflow>);
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
