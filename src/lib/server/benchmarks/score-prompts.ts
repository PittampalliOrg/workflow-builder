// LLM-judge prompts for benchmark scorers. Each prompt is a system+user
// pair; the runner asks for a JSON response { score: 0..1, reasoning: str }.
// Versioning is per-prompt — bump scorerVersion whenever you change the
// prompt so old/new scores don't intermix.

export const EDIT_MINIMALITY_PROMPT = {
	system: `You are an expert code-review assistant grading a single coding-agent attempt
on a SWE-bench problem. You judge ONE specific axis at a time.

Your job: rate the *minimality* of the agent's patch — did it change only
what was needed, or did it sprawl into unrelated edits?

Output strictly this JSON (no extra text, no markdown):
{
  "score": <number 0..1>,
  "reasoning": "<one sentence>"
}

Score guidance:
- 1.0: surgical patch, only touches lines directly relevant to the bug
- 0.7: focused but with some defensive cleanup that's reasonable
- 0.5: moderately spread out — multiple files / refactor-adjacent
- 0.2: large rewrite touching many unrelated files
- 0.0: doesn't address the problem at all`,

	user: (params: {
		instanceId: string;
		problemStatement: string;
		modelPatch: string;
		goldPatch: string | null;
	}) => `## Instance
${params.instanceId}

## Problem statement
${params.problemStatement.slice(0, 4000)}

## Agent's patch (model_patch)
\`\`\`diff
${params.modelPatch.slice(0, 8000)}
\`\`\`

${
	params.goldPatch
		? `## Reference (gold) patch
\`\`\`diff
${params.goldPatch.slice(0, 4000)}
\`\`\`

For comparison only — do not require the agent to match the gold patch
exactly. Many correct solutions look different.`
		: "## Reference patch\nNot available."
}

Score the agent's patch on minimality. Output JSON only.`,
};

export const REASONING_QUALITY_PROMPT = {
	system: `You are an expert code-review assistant grading a single coding-agent attempt
on a SWE-bench problem.

Your job: rate the *reasoning quality* — did the agent demonstrate sound
diagnostic reasoning when proposing the fix? Look for evidence in the
patch comments / commit message that the agent understood the bug.

Output strictly this JSON (no extra text, no markdown):
{
  "score": <number 0..1>,
  "reasoning": "<one sentence>"
}

Score guidance:
- 1.0: patch hints at correct root-cause understanding
- 0.7: plausible reasoning, perhaps incomplete
- 0.5: reasoning is unclear or mechanical
- 0.2: appears to be guesswork
- 0.0: no reasoning evident`,

	user: (params: {
		instanceId: string;
		problemStatement: string;
		modelPatch: string;
	}) => `## Instance
${params.instanceId}

## Problem statement
${params.problemStatement.slice(0, 4000)}

## Agent's patch
\`\`\`diff
${params.modelPatch.slice(0, 8000)}
\`\`\`

Score the reasoning quality. Output JSON only.`,
};
