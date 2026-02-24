import {
	type ClaudePlanValidationIssue,
	type ClaudeTaskPlan,
	claudePlanJsonSchema,
	validateClaudeTaskPlan,
} from "./claude-plan-schema.js";

type CommandExecutionResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
	success: boolean;
};

export type ClaudePlanningMeta = {
	planningBackend: "claude_code_v1";
	durationMs: number;
	exitCode: number;
	usedWorkspaceRef: boolean;
	rawResultSize: number;
	model?: string;
};

export class ClaudePlanGenerationError extends Error {
	readonly code:
		| "CLAUDE_CLI_MISSING"
		| "CLAUDE_CLI_FAILED"
		| "CLAUDE_OUTPUT_INVALID_JSON"
		| "CLAUDE_OUTPUT_SCHEMA_INVALID";
	readonly details?: unknown;

	constructor(input: {
		code:
			| "CLAUDE_CLI_MISSING"
			| "CLAUDE_CLI_FAILED"
			| "CLAUDE_OUTPUT_INVALID_JSON"
			| "CLAUDE_OUTPUT_SCHEMA_INVALID";
		message: string;
		details?: unknown;
	}) {
		super(input.message);
		this.name = "ClaudePlanGenerationError";
		this.code = input.code;
		this.details = input.details;
	}
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function preview(text: string, max = 1200): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max)}…`;
}

function extractJsonResult(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new ClaudePlanGenerationError({
			code: "CLAUDE_OUTPUT_INVALID_JSON",
			message: "Claude CLI returned empty stdout",
		});
	}

	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (!line.startsWith("{")) {
			continue;
		}
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Continue scanning upward for the last valid JSON object line.
		}
	}

	throw new ClaudePlanGenerationError({
		code: "CLAUDE_OUTPUT_INVALID_JSON",
		message: "Claude CLI output did not include a JSON result object",
		details: { stdoutPreview: preview(stdout) },
	});
}

function buildPlanningPrompt(input: {
	userPrompt: string;
	repositoryRoot?: string;
}): string {
	const repositoryContext = input.repositoryRoot?.trim()
		? `Repository root: ${input.repositoryRoot.trim()}\nOperate only on repository-relative paths under this root.\n\n`
		: "";

	return `${repositoryContext}You are generating an implementation task graph.

Requirements:
- Return only valid JSON via the provided schema.
- Build a concrete dependency DAG using blockedBy relationships.
- Use stable task IDs.
- Set task status to "pending" for new plans.
- Set blocked=true only when blockedBy has dependencies.
- Keep tasks execution-ready and specific.

User request:
${input.userPrompt.trim()}`;
}

function mapValidationIssues(
	issues: ClaudePlanValidationIssue[],
): Array<{ path: string; message: string; code: string }> {
	return issues.map((issue) => ({
		path: issue.path,
		message: issue.message,
		code: issue.code,
	}));
}

export async function generateClaudeTaskPlan(input: {
	userPrompt: string;
	repositoryRoot?: string;
	model?: string;
	timeoutMs: number;
	executeCommand: (
		command: string,
		timeoutMs: number,
	) => Promise<CommandExecutionResult>;
}): Promise<{ plan: ClaudeTaskPlan; meta: ClaudePlanningMeta }> {
	const prompt = input.userPrompt.trim();
	if (!prompt) {
		throw new ClaudePlanGenerationError({
			code: "CLAUDE_OUTPUT_SCHEMA_INVALID",
			message: "prompt is required",
		});
	}

	const args = [
		"-p",
		buildPlanningPrompt({
			userPrompt: prompt,
			repositoryRoot: input.repositoryRoot,
		}),
		"--permission-mode",
		"plan",
		"--no-session-persistence",
		"--output-format",
		"json",
		"--json-schema",
		JSON.stringify(claudePlanJsonSchema()),
		"--tools",
		"Read,Glob,Grep",
	];
	if (typeof input.model === "string" && input.model.trim().length > 0) {
		args.push("--model", input.model.trim());
	}

	// Force non-interactive stdin so Claude doesn't wait on an open pipe.
	const command = `claude ${args.map(shellEscape).join(" ")} </dev/null`;
	const startedAt = Date.now();
	const result = await input.executeCommand(command, input.timeoutMs);
	const durationMs = Date.now() - startedAt;

	if (!result.success) {
		const stderr = result.stderr.toLowerCase();
		const stdout = result.stdout.toLowerCase();
		const isMissingBinary =
			stderr.includes("not found") ||
			stdout.includes("not found") ||
			stderr.includes("no such file");
		throw new ClaudePlanGenerationError({
			code: isMissingBinary ? "CLAUDE_CLI_MISSING" : "CLAUDE_CLI_FAILED",
			message: isMissingBinary
				? "Claude CLI is not installed in the sandbox image"
				: "Claude CLI planning command failed",
			details: {
				exitCode: result.exitCode,
				stderr: preview(result.stderr),
				stdout: preview(result.stdout),
			},
		});
	}

	const parsedResult = extractJsonResult(result.stdout);
	const structured = parsedResult.structured_output;
	const candidate =
		structured && typeof structured === "object" && !Array.isArray(structured)
			? structured
			: parsedResult;

	const validated = validateClaudeTaskPlan(candidate);
	if (!validated.success) {
		throw new ClaudePlanGenerationError({
			code: "CLAUDE_OUTPUT_SCHEMA_INVALID",
			message: "Claude CLI produced output that failed plan schema validation",
			details: {
				issues: mapValidationIssues(validated.issues),
				stdout: preview(result.stdout),
			},
		});
	}

	return {
		plan: validated.plan,
		meta: {
			planningBackend: "claude_code_v1",
			durationMs,
			exitCode: result.exitCode,
			usedWorkspaceRef: Boolean(input.repositoryRoot),
			rawResultSize: result.stdout.length,
			model: input.model?.trim() || undefined,
		},
	};
}
