/**
 * Loop `while` and `summary` set expressions.
 *
 * Both derive EXCLUSIVELY from the read_verdict node's parsed stdout (the single
 * source of truth) — never re-parsing the raw critique message or re-testing the
 * gate stdout. The promote node's dev/preview-promote result feeds pullRequest /
 * promoteOk / promoteError; when outputMode==pr and no prUrl came back, the
 * summary carries the promote error rather than an empty string.
 */
import type { GanFixtureConfig } from "../gan-config";
import { jqExpr, READ_VERDICT_OBJ } from "../jq";

const RV = READ_VERDICT_OBJ;

/** Continue the refine loop while NOT accepted AND NOT stalled. */
export function buildWhile(): string {
	return jqExpr(
		`( ((${RV}) | (.accepted // false)) | not ) and ( ((${RV}) | (.stalled // false)) | not )`,
	);
}

export function buildSummarySet(cfg: GanFixtureConfig): Record<string, string> {
	const routesDefault = JSON.stringify(cfg.defaults.evaluationRoutes);
	return {
		service: jqExpr(`.enter_dev_mode.service // .trigger.service // "${cfg.defaults.service}"`),
		browseUrl: jqExpr('.enter_dev_mode.browseUrl // ""'),
		evaluationRoutes: jqExpr(`.trigger.evaluationRoutes // ${routesDefault}`),
		outputMode: jqExpr(`.trigger.outputMode // "${cfg.defaults.outputMode}"`),
		accepted: jqExpr(`(${RV}) | (.accepted // false)`),
		gatePass: jqExpr(`(${RV}) | (.gate_pass // false)`),
		stalled: jqExpr(`(${RV}) | (.stalled // false)`),
		bestScore: jqExpr(`(${RV}) | (.best_score // 0)`),
		terminalState: jqExpr(`(${RV}) | (.terminal // "max_iterations_reached")`),
		verdictSource: jqExpr(`(${RV}) | (.verdict_source // "missing")`),
		iterations: jqExpr(".loop.iterations // 0"),
		finalSummary: jqExpr('.loop.last.generate.content // ""'),
		verdict: jqExpr(".loop.last.critique // {}"),
		promoteOk: jqExpr(".promote.ok // false"),
		promoteError: jqExpr('.promote.error // ""'),
		// PR url, or (when a PR was expected but none returned) the promote error.
		pullRequest: jqExpr(
			`(.promote.prUrl // "") as $u | (if ($u == "" and ((.trigger.outputMode // "${cfg.defaults.outputMode}") == "pr")) then ("promote-failed: " + (.promote.error // "no PR url returned")) else $u end)`,
		),
	};
}
