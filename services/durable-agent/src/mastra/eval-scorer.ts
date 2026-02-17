/**
 * Eval Scorer — runs post-workflow scoring outside the Dapr generator.
 *
 * Scorers evaluate agent output quality (hallucination, relevance, etc.)
 * after the workflow completes. Results are included in completion event payload.
 */

/**
 * Structural interface matching a Mastra eval scorer.
 */
export interface ScorerLike {
	name: string;
	score(opts: {
		input: string;
		output: string;
		[key: string]: unknown;
	}): Promise<{ score: number; details?: Record<string, unknown> }>;
}

export interface ScoringResult {
	scorer: string;
	score: number;
	details?: Record<string, unknown>;
	error?: string;
}

/**
 * Run scorers on agent input/output after workflow completion.
 *
 * Executed OUTSIDE the Dapr workflow generator (in main.ts after
 * waitForWorkflowCompletion returns). Safe to do I/O directly.
 *
 * @param scorers - Array of Mastra-compatible scorers
 * @param input - Original user input/prompt
 * @param output - Agent's final answer
 * @param runId - Optional workflow instance ID for correlation
 * @returns Array of scoring results (one per scorer)
 */
export async function runScorers(
	scorers: ScorerLike[],
	input: string,
	output: string,
	runId?: string,
): Promise<ScoringResult[]> {
	if (scorers.length === 0) return [];

	const results: ScoringResult[] = [];

	for (const scorer of scorers) {
		try {
			const result = await scorer.score({ input, output, runId });
			results.push({
				scorer: scorer.name,
				score: result.score,
				details: result.details,
			});
			console.log(
				`[eval-scorer] ${scorer.name}: score=${result.score}${runId ? ` run=${runId}` : ""}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[eval-scorer] ${scorer.name} failed: ${msg}`);
			results.push({
				scorer: scorer.name,
				score: -1,
				error: msg,
			});
		}
	}

	return results;
}

/**
 * Instantiate scorers from a comma-separated config string.
 * Dynamically imports @mastra/evals if available.
 *
 * @param config - e.g., "hallucination,relevance,toxicity"
 * @returns Array of scorer instances
 */
export async function createScorers(config: string): Promise<ScorerLike[]> {
	if (!config.trim()) return [];

	const names = config
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const scorers: ScorerLike[] = [];

	try {
		const mastraEvals = await import("@mastra/evals");
		const mod = mastraEvals as any;

		for (const name of names) {
			// Try common patterns: HallucinationScorer, RelevanceScorer, etc.
			const pascalName = name.charAt(0).toUpperCase() + name.slice(1);
			const Cls =
				mod[`${pascalName}Scorer`] ?? mod[`${pascalName}Metric`] ?? mod[name];

			if (Cls) {
				scorers.push(new Cls());
				console.log(`[eval-scorer] Loaded scorer: ${name}`);
			} else {
				console.warn(
					`[eval-scorer] Scorer "${name}" not found in @mastra/evals`,
				);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			msg.includes("Cannot find module") ||
			msg.includes("MODULE_NOT_FOUND")
		) {
			console.log(
				"[eval-scorer] @mastra/evals not installed, skipping scorers",
			);
		} else {
			console.warn(`[eval-scorer] Failed to load scorers: ${msg}`);
		}
	}

	return scorers;
}
