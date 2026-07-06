/**
 * Promote node — emits `call: "dev/preview-promote"` (no inline git shell).
 *
 * The action (implemented server-side) takes the executionId + the best snapshot
 * and opens the PR; we pass iteration:"best" + bestIteration and a title/body
 * derived ENTIRELY from the read_verdict output (feedback / best_score / terminal
 * state), with draft = NOT accepted. Node result data: { ok, prUrl, branch,
 * draft, error }.
 */
import type { GanFixtureConfig } from "../gan-config";
import { jqExpr, READ_VERDICT_OBJ } from "../jq";

const RV = READ_VERDICT_OBJ;

function bodyMarkdownExpr(): string {
	// Hand-written jq: `\\n` is a jq newline (backslash-n). Assembled from the
	// read_verdict object only.
	return jqExpr(
		`(${RV}) as $v` +
			` | ($v.accepted // false) as $acc` +
			` | (($acc) | not) as $draft` +
			` | "Automated UI feature via the workflow-builder planner/generator/critic loop; a skeptical Playwright critic graded the live preview.\\n\\n"` +
			` + "- accepted: " + ($acc | tostring) + "\\n"` +
			` + "- terminalState: " + ($v.terminal // "max_iterations_reached") + "\\n"` +
			` + "- best critic score: " + (($v.best_score // 0) | tostring) + "\\n\\n"` +
			` + (if $draft then "> DRAFT — the critic did not accept this build (or the deterministic gate did not pass). This carries the best-scoring source; outstanding items are below.\\n\\n" else "" end)` +
			` + "## Critic feedback\\n" + (($v.feedback // "") | if . == "" then "(none)" else . end) + "\\n"` +
			` + (if (($v.envIssues // []) | length) > 0 then "\\n## Preview-environment issues (NOT agent defects)\\n" + (($v.envIssues // []) | map("- " + (if (type == "string") then . else tojson end)) | join("\\n")) + "\\n" else "" end)`,
	);
}

export function buildPromoteNode(cfg: GanFixtureConfig): Record<string, unknown> {
	return {
		promote: {
			call: "dev/preview-promote",
			if: jqExpr(`(.trigger.outputMode // "${cfg.defaults.outputMode}") == "pr"`),
			with: {
				executionId: jqExpr(".runtime.executionId"),
				iteration: "best",
				bestIteration: jqExpr(`(${RV}) | (.best_iteration // 0)`),
				draft: jqExpr(`((${RV}) | (.accepted // false)) | not`),
				title: jqExpr(
					`(if ((${RV}) | (.accepted // false)) then "" else "[draft] " end) + "GAN UI feature (automated)"`,
				),
				bodyMarkdown: bodyMarkdownExpr(),
				branchPrefix: cfg.promote.branchPrefix,
			},
			artifacts: [
				{
					from: jqExpr(
						'{ ok:(.data.ok // false), prUrl:(.data.prUrl // ""), branch:(.data.branch // ""), draft:(.data.draft // false), error:(.data.error // "") }',
					),
					kind: "json",
					slot: "primary",
					title: "Pull request",
					description: `dev/preview-promote result (prUrl / branch / draft / error) on ${cfg.promote.repoUrl}.`,
				},
			],
		},
	};
}
