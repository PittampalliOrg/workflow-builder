import type {
	SourceBundlePromotionGateInput,
	SourceBundlePromotionGatePort,
	SourceBundlePromotionGateResult,
	SourceBundlePromotionRunnerInput,
	SourceBundlePromotionRunnerPort,
	SourceBundlePromotionRunnerResult,
} from "$lib/server/application/ports";
import { evaluatePromotionGate } from "$lib/server/workflows/promotion-gates";
import {
	internalBffBaseUrl,
	provisionWorkspaceHelperPod,
	runHelperCommand,
} from "$lib/server/workflows/helper-pod";

export class WorkflowPromotionGateAdapter
	implements SourceBundlePromotionGatePort
{
	evaluatePromotionGate(
		input: SourceBundlePromotionGateInput,
	): SourceBundlePromotionGateResult {
		return evaluatePromotionGate(input);
	}
}

export class HelperPodSourceBundlePromotionRunner
	implements SourceBundlePromotionRunnerPort
{
	async promoteSourceBundle(
		input: SourceBundlePromotionRunnerInput,
	): Promise<SourceBundlePromotionRunnerResult> {
		const helper = await provisionWorkspaceHelperPod(input.executionId, "promote", {
			withGithubToken: true,
		});
		if (!helper) {
			return {
				status: "unavailable",
				message: "could not provision a helper pod for promote",
			};
		}

		const bundleUrl = `${internalBffBaseUrl()}/api/internal/files/${input.fileId}/content`;
		const command = buildPromotionCommand(input, helper.token, bundleUrl);
		const result = await runHelperCommand(
			helper.baseUrl,
			helper.token,
			command,
			"/tmp",
			300_000,
		);
		if (!result) {
			return {
				status: "unavailable",
				message: "promote command failed (no pod response)",
			};
		}

		const output = `${result.stdout}\n${result.stderr}`;
		const errorMatch = output.match(/ERR=(\w+)/);
		const prMatch = output.match(/PR_URL=(\S+)/);
		const branchMatch = output.match(/BRANCH_PUSHED=(\S+)/);
		if (errorMatch && !prMatch && !branchMatch) {
			return {
				status: "command_error",
				error: errorMatch[1],
				output,
			};
		}

		const prError = output.match(/PR_ERR=(.+)/);
		return {
			status: "ok",
			output,
			prUrl: prMatch ? prMatch[1] : null,
			branch: branchMatch ? branchMatch[1] : null,
			prError: !prMatch && prError ? prError[1].trim() : null,
		};
	}
}

function buildPromotionCommand(
	input: SourceBundlePromotionRunnerInput,
	token: string,
	bundleUrl: string,
) {
	const overlayPaths = input.syncPaths.map(shQuote).join(" ");
	const destSub = input.repoSubdir ? `/${input.repoSubdir}` : "";
	const cloneStep =
		input.tier === "tar-overlay"
			? `git clone -q --depth 1 -b "$BASE" "https://x-access-token:$GH@github.com/${input.repo}.git" /tmp/promote && ` +
				`cd /tmp/promote && git checkout -q -b "$BR" && ` +
				`DEST="/tmp/promote${destSub}" && mkdir -p "$DEST" && ` +
				`for p in ${overlayPaths}; do rm -rf "$DEST/$p"; done && ` +
				`tar -xzf /tmp/v.bundle -C "$DEST" && ` +
				`git config user.email agent@workflow-builder.local && git config user.name 'workflow-builder' && ` +
				`git add -A && git commit -q -m "$TITLE" || { echo "ERR=no_changes"; exit 0; }`
			: input.tier === "thin"
				? `git clone -q "https://x-access-token:$GH@github.com/${input.repo}.git" /tmp/promote && cd /tmp/promote && ` +
					`git fetch -q /tmp/v.bundle 'refs/*:refs/wfb-bundle/*' >/dev/null 2>&1 || git fetch -q /tmp/v.bundle >/dev/null 2>&1; ` +
					`TGT=$(git bundle list-heads /tmp/v.bundle 2>/dev/null | head -1 | awk '{print $1}'); ` +
					`git checkout -q -b "$BR" "$TGT"`
				: `git clone -q /tmp/v.bundle /tmp/promote && cd /tmp/promote && git checkout -q -b "$BR"`;

	return [
		`set -e`,
		`TOK=${shQuote(token)}`,
		`REPO=${shQuote(input.repo)}; BASE=${shQuote(input.base)}; MODE=${shQuote(input.mode)}; TITLE=${shQuote(input.title)}`,
		`GH="$GITHUB_TOKEN"`,
		`[ -n "$GH" ] || { echo "ERR=no_github_token"; exit 0; }`,
		`rm -rf /tmp/promote /tmp/v.bundle`,
		`curl -fsS -H "X-Internal-Token: $TOK" ${shQuote(bundleUrl)} -o /tmp/v.bundle || { echo "ERR=bundle_fetch_failed"; exit 0; }`,
		`git config --global --add safe.directory '*' 2>/dev/null || true`,
		`BR="wfb-promote-$(date +%s)"`,
		cloneStep,
		`git config user.email agent@workflow-builder.local; git config user.name 'workflow-builder'`,
		`git push -q "https://x-access-token:$GH@github.com/$REPO.git" HEAD:"$BR" || { echo "ERR=push_failed"; exit 0; }`,
		`if [ "$MODE" = pr ]; then`,
		`  PR=$(curl -fsS -X POST -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls" -d "{\\"title\\":\\"$TITLE\\",\\"head\\":\\"$BR\\",\\"base\\":\\"$BASE\\",\\"body\\":\\"Promoted from a workflow-builder code version (durable source bundle).\\"}" || echo '{}')`,
		`  URL=$(printf '%s' "$PR" | grep -oE 'https://github.com/[^"]+/pull/[0-9]+' | head -1)`,
		`  if [ -n "$URL" ]; then echo "PR_URL=$URL"; else echo "PR_ERR=$(printf '%s' "$PR" | grep -oE '"message"[^,}]*' | head -1)"; fi`,
		`else echo "BRANCH_PUSHED=$BR"; fi`,
	].join("\n");
}

function shQuote(value: string): string {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}
