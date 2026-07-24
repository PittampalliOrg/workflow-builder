/**
 * Unified-diff helpers for rendering checkpoint diffs with diff2html.
 *
 * The checkpoint diff endpoint runs `git diff --stat --patch` in the sandbox,
 * which prefixes the real patch with a `--stat` summary block (` path | 3 +-`,
 * `N files changed, ...`). diff2html only wants the patch itself, so we drop
 * everything before the first `diff --git` hunk. The Gitea remote path returns a
 * bare patch (no stat) — for that input this is a no-op.
 */

/** Strip any leading `git diff --stat` summary so only the patch remains. */
export function stripDiffStatPreamble(diff: string): string {
	if (!diff) return "";
	const idx = diff.search(/^diff --git /m);
	// No `diff --git` marker (e.g. an already-clean patch or a non-git diff):
	// return as-is so nothing is lost.
	return idx > 0 ? diff.slice(idx) : diff;
}
