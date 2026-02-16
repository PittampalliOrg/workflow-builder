/**
 * Git-based workspace diff
 *
 * Snapshots the workspace as a git baseline before the agent runs,
 * then `git diff` after to produce a proper unified patch.
 */

import { executeCommandViaSandbox } from "./sandbox-config.js";

/**
 * Snapshot the workspace as a git baseline commit.
 * Returns true if the baseline was created successfully.
 */
export async function gitBaseline(): Promise<boolean> {
	try {
		const result = await executeCommandViaSandbox(
			"git init -q && git add -A && git commit -q -m baseline --allow-empty",
			{ timeout: 15_000 },
		);
		if (result.exitCode !== 0) {
			console.warn(`[agent] git baseline failed: ${result.stderr}`);
			return false;
		}
		return true;
	} catch (err) {
		console.warn(`[agent] git baseline error: ${err}`);
		return false;
	}
}

/**
 * Generate a unified diff of all workspace changes since the baseline commit.
 */
export async function gitDiff(): Promise<string | undefined> {
	try {
		const result = await executeCommandViaSandbox(
			"git add -A && git diff --cached HEAD --no-color",
			{ timeout: 15_000 },
		);
		if (result.exitCode !== 0) {
			console.warn(`[agent] git diff failed: ${result.stderr}`);
			return undefined;
		}
		const patch = result.stdout.trim();
		return patch || undefined;
	} catch (err) {
		console.warn(`[agent] git diff error: ${err}`);
		return undefined;
	}
}
