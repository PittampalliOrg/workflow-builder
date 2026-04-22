/**
 * Compact token-count formatter with `k` / `M` suffixes.
 * 0..999 → "N"; 1000..999k → "Nk"; 1M+ → "N.NM".
 * Used on the session detail page's event-detail-panel AND the workflow-run
 * detail page's stats banner so the two surfaces agree on display.
 */
export function fmtTokens(n: number | undefined | null): string {
	const v = Number(n ?? 0);
	if (!Number.isFinite(v)) return "0";
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(v);
}

/**
 * Anthropic / OpenAI model id → context-window size in tokens.
 * Used to feed maxTokens into the svelte-ai-elements Context compound.
 * Extend when new model variants ship or when we turn on Claude's 1M beta
 * header via an env flag.
 */
export function modelContextWindow(model: string | null | undefined): number {
	if (!model) return 200_000;
	if (model.includes("opus-4-7") || model.includes("opus-4-6")) return 200_000;
	if (model.includes("sonnet-4")) return 200_000;
	if (model.includes("haiku-4")) return 200_000;
	if (model.startsWith("gpt-5") || model.startsWith("gpt-4")) return 128_000;
	if (model.includes("o3") || model.includes("o1")) return 200_000;
	return 200_000;
}
