/**
 * Shared model + helpers for git-backed workspace code checkpoints.
 *
 * Extracted from the run-detail page so the run page, the session-detail Code &
 * Changes panel, and the Timeline checkpoint markers all speak the same shape
 * and derive labels/durability/step-mapping identically. Pure functions live
 * here (unit-tested); the fetch helpers wrap the checkpoint REST surface.
 */

export type CodeCheckpointFile = {
	path?: string;
	status?: string;
	previousPath?: string | null;
	additions?: number | null;
	deletions?: number | null;
	binary?: boolean;
};

export type CodeCheckpoint = {
	id: string;
	seq: number | null;
	toolName: string;
	status: 'created' | 'no_changes' | 'skipped' | 'error';
	beforeSha: string | null;
	afterSha: string | null;
	remoteUrl: string | null;
	remoteRef: string | null;
	remoteStatus: string | null;
	remoteError: string | null;
	remotePushedAt: string | null;
	changedFiles: CodeCheckpointFile[];
	fileCount: number;
	sourceEventId: string;
	sandboxName: string | null;
	repoPath: string;
	error: string | null;
	createdAt: string;
	// Optional linkage — present on newer rows; used to filter a checkpoint to
	// the session that produced it and to resolve the fork point.
	sessionId?: string | null;
	toolCallId?: string | null;
	nodeId?: string | null;
};

export function shortSha(value: string | null | undefined): string {
	return value ? value.slice(0, 8) : 'none';
}

export function checkpointFilePath(file: CodeCheckpointFile): string {
	return String(file.path ?? '');
}

export function checkpointFileSummary(file: CodeCheckpointFile): string {
	const parts = [];
	if (typeof file.additions === 'number') parts.push(`+${file.additions}`);
	if (typeof file.deletions === 'number') parts.push(`-${file.deletions}`);
	if (file.binary) parts.push('binary');
	return parts.join(' ');
}

export function checkpointFileStatusLabel(file: CodeCheckpointFile): string {
	const status = String(file.status ?? '').trim().toUpperCase();
	if (!status) return file.binary ? 'BIN' : 'M';
	if (status.startsWith('R')) return status;
	if (status.startsWith('C')) return status;
	return status.slice(0, 1);
}

export function checkpointHasFileChanges(checkpoint: CodeCheckpoint): boolean {
	return checkpoint.status === 'created' && checkpoint.fileCount > 0;
}

export function checkpointGitChangeLabel(checkpoint: CodeCheckpoint): string | null {
	if (!checkpointHasFileChanges(checkpoint)) return null;
	const counts = new Map<string, number>();
	for (const file of checkpoint.changedFiles) {
		const status = checkpointFileStatusLabel(file);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	if (counts.size === 0) return `M ${checkpoint.fileCount}`;
	const order = ['A', 'M', 'D', 'R', 'C', 'T', 'U'];
	return [...counts.entries()]
		.sort(([left], [right]) => {
			const leftIndex = order.findIndex((prefix) => left.startsWith(prefix));
			const rightIndex = order.findIndex((prefix) => right.startsWith(prefix));
			return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
		})
		.map(([status, count]) => `${status} ${count}`)
		.join(' ');
}

/** Aggregate +additions / -deletions across a checkpoint's files (for chips). */
export function checkpointLineDelta(checkpoint: CodeCheckpoint): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const file of checkpoint.changedFiles) {
		if (typeof file.additions === 'number') additions += file.additions;
		if (typeof file.deletions === 'number') deletions += file.deletions;
	}
	return { additions, deletions };
}

export function checkpointShaRange(checkpoint: CodeCheckpoint): string | null {
	if (!checkpointHasFileChanges(checkpoint)) return null;
	if (!checkpoint.beforeSha || !checkpoint.afterSha) return null;
	return `${shortSha(checkpoint.beforeSha)}..${shortSha(checkpoint.afterSha)}`;
}

export function checkpointGitRemoteLabel(checkpoint: CodeCheckpoint): string | null {
	if (!checkpointHasFileChanges(checkpoint)) return null;
	if (checkpointIsDurable(checkpoint)) return 'pushed';
	if (checkpoint.remoteStatus === 'error') return 'push failed';
	if (checkpoint.remoteRef) return 'local ref';
	return null;
}

export function checkpointShouldShowRemoteError(checkpoint: CodeCheckpoint): boolean {
	if (!checkpoint.remoteError) return false;
	if (
		!checkpointHasFileChanges(checkpoint) &&
		['no changes', 'no staged changes'].includes(checkpoint.remoteError.trim().toLowerCase())
	) {
		return false;
	}
	return true;
}

export function checkpointIsDurable(checkpoint: CodeCheckpoint): boolean {
	return checkpoint.remoteStatus === 'pushed' && !!checkpoint.remoteRef;
}

export function checkpointRemoteLabel(checkpoint: CodeCheckpoint): string {
	if (checkpointIsDurable(checkpoint)) return 'durable';
	if (checkpoint.remoteStatus === 'error') return 'remote error';
	if (checkpoint.remoteRef) return 'not pushed';
	return 'local only';
}

/**
 * The step id the resume/fork API expects for a checkpoint's owning step.
 *
 * The resume orchestrator keys on the bare node name (spec `do` key). Checkpoints
 * carry a `nodeId` when produced inside an SW node; dynamic-script checkpoints
 * fall back to the tool-call id. Returns null when neither is known — callers
 * degrade to the run's default fork point.
 */
export function resolveCheckpointStepId(checkpoint: CodeCheckpoint): string | null {
	const raw = checkpoint.nodeId ?? checkpoint.toolCallId ?? null;
	if (!raw) return null;
	return raw.includes('/') ? (raw.split('/').filter(Boolean).pop() ?? raw) : raw;
}

/** Whether a checkpoint belongs to the given session (linkage-aware; permissive). */
export function checkpointMatchesSession(
	checkpoint: CodeCheckpoint,
	sessionId: string | null | undefined
): boolean {
	if (!sessionId) return true;
	// Prefer the explicit session linkage; fall back to sandbox name (sessions and
	// their sandboxes are 1:1 in practice) so older rows still filter sensibly.
	if (checkpoint.sessionId) return checkpoint.sessionId === sessionId;
	if (checkpoint.sandboxName) return checkpoint.sandboxName === sessionId;
	return false;
}

export async function readApiError(response: Response, fallback: string): Promise<string> {
	const contentType = response.headers.get('content-type') ?? '';
	if (contentType.includes('application/json')) {
		const body = await response.json().catch(() => null);
		if (body && typeof body.message === 'string') return body.message;
		if (body && typeof body.error === 'string') return body.error;
	}
	const text = await response.text().catch(() => '');
	return text.trim() || fallback;
}

export async function fetchCodeCheckpoints(
	executionId: string,
	fetchImpl: typeof fetch = fetch
): Promise<CodeCheckpoint[]> {
	const res = await fetchImpl(`/api/workflows/executions/${executionId}/code-checkpoints`);
	if (!res.ok) throw new Error(await readApiError(res, `HTTP ${res.status}`));
	const data = await res.json();
	return (data.checkpoints ?? []) as CodeCheckpoint[];
}

export async function fetchCheckpointDiff(
	executionId: string,
	checkpointId: string,
	filePath: string | null = null,
	fetchImpl: typeof fetch = fetch
): Promise<{ diff: string; error: string | null }> {
	const pathQuery = filePath ? `?path=${encodeURIComponent(filePath)}` : '';
	const res = await fetchImpl(
		`/api/workflows/executions/${executionId}/code-checkpoints/${checkpointId}/diff${pathQuery}`
	);
	if (!res.ok) throw new Error(await readApiError(res, 'Failed to load checkpoint diff'));
	const data = await res.json();
	return {
		diff: typeof data.diff === 'string' ? data.diff : '',
		error: data.error ? String(data.error) : null
	};
}

export async function restoreCheckpointToSandbox(
	executionId: string,
	checkpointId: string,
	sandboxName: string,
	repoPath: string,
	fetchImpl: typeof fetch = fetch
): Promise<{ afterSha: string; sandboxName: string }> {
	const res = await fetchImpl(
		`/api/workflows/executions/${executionId}/code-checkpoints/${checkpointId}/restore`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sandboxName, repoPath })
		}
	);
	if (!res.ok) throw new Error(await readApiError(res, 'Failed to restore checkpoint'));
	const data = await res.json();
	return { afterSha: data.afterSha, sandboxName: data.sandboxName };
}
