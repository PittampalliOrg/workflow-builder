/**
 * Goal authoring pre-step (`planGoal`) — turn raw user intent into a validated,
 * canonical `goalSpec` for the evaluator-gated goal loop.
 *
 * This is the Anthropic "Planner" / sprint-contract role: an INDEPENDENT,
 * ISOLATED LLM call that authors the goal's objective + acceptance criteria +
 * ground-truth evidence commands. It is deliberately separate from the doer
 * agent — the doer must never author its own checks (that is gaming; same
 * isolation principle as the evaluator). The call never receives a doer
 * transcript.
 *
 * Mirrors the dual-provider structured-generation pattern of
 * `src/lib/server/workflows/greenfield-prompt.ts` (OpenAI-compatible gateway
 * when available, else Anthropic direct) + a tolerant JSON extractor.
 *
 * Validation here is STATIC ONLY (lint) — we do NOT execute the proposed
 * commands. The output goalSpec matches the canonical contract consumed by
 * POST /api/v1/sessions/[id]/goal, the durable/run body.goalSpec, and
 * thread_goals (evidence.commands -> evidencePlan.commands).
 *
 * See docs/goal-authoring-and-claude-alignment.md (Part C).
 */
import { env } from "$env/dynamic/private";
import {
	callOpenAICompatibleChatCompletion,
	openAICompatibleTrafficAvailable,
} from "$lib/server/ai/openai-gateway";

/**
 * A single gradable rubric criterion. `objective` criteria are checkable against
 * ground truth (an evidence command); `subjective` criteria are judged by the
 * critic LLM/agent. `dimension` tags subjective design criteria with one of the
 * Anthropic design dimensions (design_quality | originality | craft | functionality).
 */
export type RubricCriterion = {
	id: string;
	kind: "objective" | "subjective";
	description: string;
	dimension?: string;
};

export type Rubric = { criteria: RubricCriterion[] };

export type GoalSpec = {
	objective: string;
	acceptanceCriteria: string[];
	evidence: { commands: string[] };
	/**
	 * Optional gradable rubric driving the generator+critic evaluator-optimizer
	 * loop. Absent ⇒ today's deterministic-evidence-only behavior. See
	 * docs/generator-critic-multi-agent.md.
	 */
	rubric?: Rubric;
	maxIterations?: number;
	tokenBudget?: number;
};

export type GoalSpecLint = {
	/** Non-fatal authoring warnings surfaced to the user / artifact. */
	warnings: string[];
};

export type PlanGoalContext = {
	repo?: string;
	cwd?: string;
	runtime?: string;
	notes?: string;
};

export type PlanGoalResult = {
	goalSpec: GoalSpec;
	rationale: string;
	lint: GoalSpecLint;
};

// DeepSeek V4 (and other reasoning models) spend completion tokens on internal
// reasoning BEFORE emitting content — at a low cap they hit finish_reason=length
// with EMPTY content. 1200 was far too small (reasoning alone consumed the whole
// budget). Give very generous headroom so reasoning never starves the JSON
// output; env-overridable.
const MAX_TOKENS = Number(env.GOAL_PLAN_MAX_TOKENS) || 32000;
const DEFAULT_MAX_ITERATIONS = 30;
// Floor authored maxIterations so a planner picking a tiny number (e.g. 3)
// doesn't prematurely cap the evaluator reject→fix→retry loop.
const MIN_MAX_ITERATIONS = 10;
const ITERATION_CEILING = 200;

function isPresentString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Tolerant JSON extraction: raw, fenced ```json block, or first {...} match. */
function extractJson(text: string): Record<string, unknown> {
	const candidates = [
		text.trim(),
		text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim(),
		text.match(/\{[\s\S]*\}/)?.[0]?.trim(),
	].filter((c): c is string => isPresentString(c));

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as Record<string, unknown>;
		} catch {
			// try next
		}
	}
	throw new Error("Could not extract valid JSON from planGoal response");
}

const SYSTEM_PROMPT = [
	"You are a Goal Planner. You turn a user's raw intent into a precise, testable",
	"'sprint contract' for an autonomous coding agent — you do NOT do the work",
	"yourself. Respond with JSON only.",
	"",
	"Author the contract so completion can be judged against GROUND TRUTH, not the",
	"agent's own claims:",
	"- objective: ONE clear, measurable end state. State the constraints that must",
	"  not change. Concise but unambiguous.",
	"- acceptanceCriteria: 2-6 specific, measurable conditions, including edge cases.",
	"  Each must be independently checkable.",
	"- evidence.commands: shell commands that PROVE the criteria against ground truth.",
	"  Rules: each command must be independently runnable, exit 0 ONLY when the",
	"  criterion is met, print actionable output on failure, and TOGETHER cover the",
	"  criteria. Order them so earlier (cheaper/foundational) checks run first.",
	"  CRITICAL: commands must NOT leak the answer. Never echo, grep-for, or embed the",
	"  literal expected value/string a criterion is testing — the agent can read these",
	"  commands, so a command that contains the answer lets it hardcode the check.",
	"  Write tests that exercise behavior (run the program, assert on its real output)",
	"  rather than asserting a string equals a constant you spelled out here.",
	"- rubric: a gradable checklist an INDEPENDENT critic uses to accept/reject the",
	"  work. Each criterion has: id (short slug), kind ('objective' or 'subjective'),",
	"  description (what 'good' means), and for subjective design criteria an optional",
	"  dimension. Use 'objective' for anything a command proves (tests, build, lint) —",
	"  these should align with evidence.commands. Use 'subjective' for qualities a",
	"  command cannot judge (style/tone adherence, translation nuance, UX/visual",
	"  quality); for visual/frontend work prefer the dimensions design_quality,",
	"  originality, craft, functionality. Author 2-6 criteria covering the objective.",
	"- maxIterations: the max number of autonomous TURNS for the doer agent (a small",
	"  task is ~10-20; a larger one up to ~40). This is a turn count, NOT a token count.",
	"- rationale: 1-3 sentences explaining the contract for a human reviewer.",
	"",
	"Return json with exactly these keys: objective (string), acceptanceCriteria",
	"(string[]), evidence (object with key commands: string[]), rubric (object with",
	"key criteria: array of {id, kind, description, dimension?}), maxIterations",
	"(number), rationale (string). Do NOT include a token budget.",
	"",
	"Example of the desired json output format (shape only — author real content):",
	'{"objective":"Implement <X> in /sandbox/solution.js","acceptanceCriteria":["<criterion 1>","<criterion 2>"],"evidence":{"commands":["cd /sandbox && node -e \'<assert behavior; exit non-zero on failure>\'"]},"rubric":{"criteria":[{"id":"tests","kind":"objective","description":"All acceptance checks pass"},{"id":"craft","kind":"subjective","dimension":"craft","description":"<what good craft looks like here>"}]},"maxIterations":15,"rationale":"<why this contract proves the objective>"}',
].join("\n");

function buildUserPrompt(intent: string, context?: PlanGoalContext): string {
	const lines = [`User intent: ${intent.trim()}`];
	if (context?.repo) lines.push(`Repository: ${context.repo}`);
	if (context?.cwd) lines.push(`Working directory: ${context.cwd}`);
	if (context?.runtime) lines.push(`Agent runtime: ${context.runtime}`);
	if (context?.notes) lines.push(`Additional context: ${context.notes}`);
	return lines.join("\n");
}

function normalizeModel(model: string | undefined | null): string | undefined {
	if (!isPresentString(model)) return undefined;
	return model.trim();
}

/**
 * The MLflow AI gateway routes by BARE model name (e.g. `deepseek-v4-pro`,
 * `gpt-5.5`) — a `provider/model` spec like `deepseek/deepseek-v4-pro` 500s.
 * Strip a single leading provider segment so canonical model specs route
 * correctly. Multi-segment names (e.g. `nvidia/meta/llama-3.1-8b`) are left
 * intact (the gateway owns their routing).
 */
function gatewayModelName(model: string): string {
	const parts = model.split("/");
	return parts.length === 2 ? parts[1] : model;
}

async function callAnthropic(
	system: string,
	user: string,
	model: string,
	apiKey: string,
): Promise<string> {
	const cleanModel = model.startsWith("anthropic/")
		? model.slice("anthropic/".length)
		: model;
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: cleanModel,
			max_tokens: MAX_TOKENS,
			system,
			messages: [{ role: "user", content: user }],
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Anthropic API error ${response.status}: ${await response.text()}`,
		);
	}
	const data = await response.json();
	const content = data.content?.[0]?.text;
	if (!isPresentString(content)) throw new Error("No content in Anthropic response");
	return content;
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((v): v is string => typeof v === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function coercePositiveInt(value: unknown, ceiling: number): number | undefined {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: NaN;
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.min(Math.floor(n), ceiling);
}

const RUBRIC_DIMENSIONS = new Set([
	"design_quality",
	"originality",
	"craft",
	"functionality",
]);

/** Coerce raw rubric output into a validated Rubric, or undefined if absent/empty. */
export function normalizeRubric(raw: unknown): Rubric | undefined {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const rawCriteria = Array.isArray(obj.criteria) ? obj.criteria : [];
	const criteria: RubricCriterion[] = [];
	rawCriteria.forEach((entry, i) => {
		if (!entry || typeof entry !== "object") return;
		const c = entry as Record<string, unknown>;
		const description = isPresentString(c.description) ? c.description.trim() : "";
		if (!description) return;
		const id = isPresentString(c.id)
			? c.id.trim().replace(/\s+/g, "-").toLowerCase()
			: `criterion-${i + 1}`;
		const kind = c.kind === "objective" ? "objective" : "subjective";
		const dimension =
			isPresentString(c.dimension) && RUBRIC_DIMENSIONS.has(c.dimension.trim())
				? c.dimension.trim()
				: undefined;
		criteria.push({ id, kind, description, ...(dimension ? { dimension } : {}) });
	});
	return criteria.length ? { criteria } : undefined;
}

/** Validate/coerce raw LLM output into the canonical goalSpec contract. */
export function normalizeGoalSpec(raw: Record<string, unknown>): GoalSpec {
	const objective = isPresentString(raw.objective) ? raw.objective.trim() : "";
	if (!objective) {
		throw new Error("planGoal produced no objective");
	}
	const acceptanceCriteria = coerceStringArray(raw.acceptanceCriteria);
	const evidenceObj = (raw.evidence ?? {}) as Record<string, unknown>;
	const commands = coerceStringArray(evidenceObj.commands);
	// Floor maxIterations so a too-small authored value can't prematurely cap the
	// evaluator loop.
	const maxIterations = Math.max(
		coercePositiveInt(raw.maxIterations, ITERATION_CEILING) ??
			DEFAULT_MAX_ITERATIONS,
		MIN_MAX_ITERATIONS,
	);

	// NOTE: planGoal deliberately does NOT author `tokenBudget`. The goal loop's
	// budget is CUMULATIVE input+output+cache-creation across every turn (realistically
	// 50k–500k); a planner LLM mis-sizes it as a small per-response number (observed:
	// 500) → the run trips `budget_limited` on turn 1 before any work lands. Leave it
	// unset (run bounded by maxIterations); a budget is opt-in for the user to add.
	const rubric = normalizeRubric(raw.rubric);

	return {
		objective,
		acceptanceCriteria,
		evidence: { commands },
		...(rubric ? { rubric } : {}),
		maxIterations,
	};
}

/**
 * Static lint of the proposed evidence (NO execution). Surfaces authoring
 * smells: prose-shaped "commands", missing evidence when criteria exist, and
 * commands that leak the answer (echo/grep of a literal acceptance-criterion
 * string lets the doer hardcode the check — defeats the gate, see #209).
 */
export function lintEvidenceCommands(spec: GoalSpec): GoalSpecLint {
	const warnings: string[] = [];
	const { commands } = spec.evidence;

	if (spec.acceptanceCriteria.length && !commands.length) {
		warnings.push(
			"No evidence commands declared — without them completion falls back to self-judged (the agent grades itself). Add commands that prove each criterion.",
		);
	}

	// Distinctive multi-word fragments from each criterion; if a command embeds
	// one verbatim it is likely leaking the expected answer into the check.
	const criterionFragments = spec.acceptanceCriteria
		.flatMap((c) => c.match(/"([^"]{4,})"|'([^']{4,})'/g) ?? [])
		.map((m) => m.replace(/^['"]|['"]$/g, "").toLowerCase())
		.filter((s) => s.length >= 4);

	commands.forEach((cmd, i) => {
		const trimmed = cmd.trim();
		const label = `Evidence command ${i + 1}`;
		// Prose smell: no recognizable command token and ends like a sentence.
		const looksLikeCommand = /[|&;<>]|\b(npm|pnpm|node|python|grep|test|cat|ls|bash|sh|go|cargo|make|jq|curl|diff|exit|\.\/)\b|^[a-z0-9._/-]+\s/i.test(
			trimmed,
		);
		if (!looksLikeCommand) {
			warnings.push(
				`${label} does not look like a runnable shell command: "${trimmed.slice(0, 60)}".`,
			);
		}
		const lower = trimmed.toLowerCase();
		const leaked = criterionFragments.find((frag) => lower.includes(frag));
		if (leaked) {
			warnings.push(
				`${label} appears to embed the expected answer ("${leaked.slice(0, 40)}") — the agent can read this command and hardcode the check. Test behavior instead of asserting a literal you spelled out.`,
			);
		}
	});

	return { warnings };
}

/**
 * Author a goalSpec from raw intent. Isolated, runtime-agnostic, one-shot.
 * Provider routing mirrors greenfield-prompt: OpenAI-compatible gateway when
 * available, else Anthropic direct. Throws if no provider is configured or the
 * model output can't be parsed into a valid objective.
 */
export async function planGoal(
	intent: string,
	context?: PlanGoalContext,
	options?: { model?: string },
): Promise<PlanGoalResult> {
	if (!isPresentString(intent)) {
		throw new Error("intent is required");
	}
	const anthropicKey = env.ANTHROPIC_API_KEY;
	const openaiAvailable = openAICompatibleTrafficAvailable();
	if (!anthropicKey && !openaiAvailable) {
		throw new Error("No AI API key configured for planGoal");
	}

	const user = buildUserPrompt(intent, context);
	const override = normalizeModel(options?.model);

	const responseText = openaiAvailable
		? await callOpenAICompatibleChatCompletion({
				model: gatewayModelName(
					override ?? env.GOAL_PLAN_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.5",
				),
				maxTokens: MAX_TOKENS,
				responseFormat: { type: "json_object" },
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: user },
				],
			})
		: await callAnthropic(
				SYSTEM_PROMPT,
				user,
				override ?? env.GOAL_PLAN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
				anthropicKey!,
			);

	const raw = extractJson(responseText);
	const goalSpec = normalizeGoalSpec(raw);
	const rationale = isPresentString(raw.rationale) ? raw.rationale.trim() : "";
	const lint = lintEvidenceCommands(goalSpec);
	return { goalSpec, rationale, lint };
}

/**
 * Recover a validated goalSpec from a planner AGENT's free-text output (no LLM
 * call). A `durable/run` planner agent has no structured-output mode — its
 * result is free text — so when an agent-run authors + validates the goalSpec
 * (writing/running tests in its own sandbox), it emits the spec as a fenced
 * ```json block and this tolerant extract turns it back into the canonical
 * contract. Reuses the same parser/normalizer/lint as planGoal. See
 * docs/goal-authoring-and-claude-alignment.md (planner agent).
 */
export function finalizeGoalSpecFromText(text: string): PlanGoalResult {
	if (!isPresentString(text)) {
		throw new Error("fromText is required");
	}
	const raw = extractJson(text);
	const goalSpec = normalizeGoalSpec(raw);
	const rationale = isPresentString(raw.rationale) ? raw.rationale.trim() : "";
	const lint = lintEvidenceCommands(goalSpec);
	return { goalSpec, rationale, lint };
}
