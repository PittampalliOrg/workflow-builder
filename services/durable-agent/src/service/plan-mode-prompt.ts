type BuildPlanModePromptInput = {
	userPrompt: string;
	repositoryRoot?: string;
	promptProfile?: PlanPromptProfile;
};

type BuildPlanRepairPromptInput = {
	userPrompt: string;
	priorResponse: string;
	attempt: number;
	repositoryRoot?: string;
	promptProfile?: PlanPromptProfile;
};

export type PlanPromptProfile = "codex_cli_v1" | "legacy_v0";

type BuildPlanModePromptResult = {
	profile: PlanPromptProfile;
	prompt: string;
};

const LEGACY_PLAN_PROMPT = `Plan mode is active. The user does not want execution yet.

You MUST NOT perform implementation edits, mutating commands, commits, config changes, or any side effects.
You may inspect files and gather context.

Workflow guidance:
Phase 1: Initial Understanding
- Understand the request and inspect relevant code paths.
- Identify ambiguities and assumptions.

Phase 2: Design
- Propose an implementation approach with concrete file targets.
- Capture API/interface changes, risks, and edge cases.
- Use only real repository paths you have verified by listing/reading files.
- Do not invent placeholder paths (for example "src/..." unless it exists in this repo).

Phase 3: Review
- Validate your plan against the original request.
- Resolve remaining ambiguity before finalizing.

Phase 4: Final Plan
- Output only your recommended plan in concise, execution-ready markdown.
- Include critical file paths to modify and acceptance tests.
- Emit final output in exactly one <proposed_plan>...</proposed_plan> block.`;

const CODEX_GENERAL_PROMPT = `You are GPT-5.2 running in Codex CLI, a terminal coding assistant.

Core behavior:
- Be precise, safe, and helpful.
- Be concise, direct, and actionable.
- Persist until the planning task is complete.
- Prefer repo exploration and evidence over guessing.
- Keep plans implementation-ready and decision complete.`;

const CODEX_PLAN_PROMPT = `Plan Mode (Conversational)

You work in 3 phases and should chat your way to a great plan before finalizing it.

Mode rules:
- You are in plan mode. Do not switch to execution mode.
- Treat requests to execute as requests to plan execution.

Plan Mode vs update_plan tool:
- Plan mode is not the update_plan checklist tool.
- If update_plan is available, do not use it in plan mode.

Execution vs mutation:
- You may perform non-mutating exploration.
- You must not perform mutating implementation actions.

Non-interactive runtime:
- This request is non-interactive. You cannot wait for user answers.
- Do not ask clarifying questions in the final response.
- If ambiguity remains, choose sensible defaults and capture them in an Assumptions section.

PHASE 1 — Ground in the environment:
- Explore files/config/types first.
- Resolve discoverable facts through inspection.
- Ask only for unresolved high-impact ambiguities.

PHASE 2 — Intent chat:
- Clarify goal, success criteria, scope, constraints, and tradeoffs.

PHASE 3 — Implementation chat:
- Produce a decision-complete spec: approach, interfaces, data flow, edge cases, tests, rollout.

Finalization rule:
- Final plan must be emitted in a single <proposed_plan>...</proposed_plan> block.
- The opening tag must be on its own line.
- Plan markdown starts on the next line.
- The closing tag must be on its own line.
- Output exactly one proposed plan block when finalizing.
- Do not ask "should I proceed?" in the final output.

Output contract (hard requirement):
- Return exactly one <proposed_plan> block and nothing else.
- Do not include text before or after the block.
- Do not wrap the tags in code fences.
- Use literal tags exactly: <proposed_plan> and </proposed_plan>.`;

function resolvePlanPromptProfile(
	overrideProfile?: PlanPromptProfile,
): PlanPromptProfile {
	const configured =
		overrideProfile ||
		(process.env.DURABLE_PLAN_PROMPT_PROFILE as PlanPromptProfile | undefined);
	if (configured === "legacy_v0" || configured === "codex_cli_v1") {
		return configured;
	}
	return "codex_cli_v1";
}

export function buildPlanModePrompt(
	input: BuildPlanModePromptInput,
): BuildPlanModePromptResult {
	const userPrompt = input.userPrompt.trim();
	const repositoryRoot = input.repositoryRoot?.trim();
	const profile = resolvePlanPromptProfile(input.promptProfile);
	const repositoryContext = repositoryRoot
		? `Repository root: ${repositoryRoot}
Operate only on repository-relative paths under this root.
`
		: "";
	const sharedContext = `Runtime context:
${repositoryContext}User request:
${userPrompt}
`;

	if (profile === "legacy_v0") {
		return {
			profile,
			prompt: `${LEGACY_PLAN_PROMPT}

${sharedContext}
When finalizing, emit exactly one <proposed_plan> block and nothing else.`,
		};
	}

	return {
		profile,
		prompt: `${CODEX_GENERAL_PROMPT}

${CODEX_PLAN_PROMPT}

${sharedContext}
When finalizing, emit only a single <proposed_plan> block that contains a decision-complete implementation plan in markdown.`,
	};
}

export function buildPlanRepairPrompt(
	input: BuildPlanRepairPromptInput,
): BuildPlanModePromptResult {
	const profile = resolvePlanPromptProfile(input.promptProfile);
	const userPrompt = input.userPrompt.trim();
	const priorResponse = input.priorResponse.trim();
	const repositoryRoot = input.repositoryRoot?.trim();
	const repositoryContext = repositoryRoot
		? `Repository root: ${repositoryRoot}
Operate only on repository-relative paths under this root.
`
		: "";

	return {
		profile,
		prompt: `${CODEX_GENERAL_PROMPT}

Plan finalization repair (attempt ${input.attempt}):
- Your previous response was rejected because it did not contain a valid standalone <proposed_plan> block.
- Re-emit a complete, decision-ready implementation plan now.
- Do not run tools. Do not ask questions. Infer defaults and include assumptions where needed.

Hard output contract:
- Return exactly one <proposed_plan>...</proposed_plan> block.
- Put each tag on its own line.
- Put markdown plan content between tags.
- Do not include any text outside the block.
- Do not use code fences.

Runtime context:
${repositoryContext}User request:
${userPrompt}

Previous rejected response (reuse and fix it):
${priorResponse}`,
	};
}
