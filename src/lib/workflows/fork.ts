/**
 * Shared fork/resume helper — used by the run-detail header AND the canvas
 * "Fork from here" action. Calls the owner-scoped resume endpoint, which starts a
 * FRESH execution of the workflow's CURRENT (possibly edited) spec, skipping the
 * prefix before `fromNodeId` and CoW-seeding the source run's workspace.
 *
 * `fromNodeId` accepts a bare node name OR a canvas id ("/do/<i>/<name>") — reduced
 * to the last path segment to match the orchestrator's bare-name keying. Omit it to
 * resume from the source run's in-flight node.
 */
export interface ForkResult {
	ok: boolean;
	executionId?: string;
	error?: string;
}

export function bareNodeName(nodeId: string | null | undefined): string | undefined {
	if (!nodeId) return undefined;
	return nodeId.includes('/') ? (nodeId.split('/').filter(Boolean).pop() ?? nodeId) : nodeId;
}

/**
 * Replay intent. Both call the same resume endpoint; `reproduce` re-runs the
 * selected suffix unchanged (deterministic baseline), `fork` iterates on the
 * current — possibly edited — spec. The mode is advisory metadata on the request
 * (the server labels the run when it persists a trigger source).
 */
export type ForkMode = 'fork' | 'reproduce';

export async function forkRun(
	sourceExecutionId: string,
	fromNodeId?: string | null,
	mode: ForkMode = 'fork'
): Promise<ForkResult> {
	const node = bareNodeName(fromNodeId);
	try {
		const body: Record<string, unknown> = { mode };
		if (node) body.fromNodeId = node;
		const res = await fetch(`/api/workflows/executions/${sourceExecutionId}/resume`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const b = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			executionId?: string;
			message?: string;
			error?: string;
		};
		if (!res.ok || !b?.ok || !b.executionId) {
			return { ok: false, error: b?.message || b?.error || `Failed (HTTP ${res.status})` };
		}
		return { ok: true, executionId: b.executionId };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Request failed' };
	}
}
