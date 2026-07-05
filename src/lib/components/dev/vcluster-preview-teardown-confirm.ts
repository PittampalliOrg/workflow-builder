/**
 * #29: the vcluster-preview teardown confirmation message.
 *
 * Extracted from the panel so it is unit-testable. Context: a 2026-07-05 incident where
 * a one-click (no-confirm) delete in the previews panel removed both a warm-pool member
 * and a claimed PR preview in one session — the delete affordance never surfaced what a
 * row actually was. The message must make the blast radius obvious: the preview's name
 * (a claimed pool member's row name IS its alias), the backing pool member it recycles,
 * and its origin (a PR preview is normally torn down by its PR closing, not by hand).
 */
export interface TeardownConfirmTarget {
	name: string;
	/** The backing warm-pool member id (pool-<n>) when this preview was claimed. */
	pool?: string | null;
	/** Lifecycle origin: "user" | "pr" | null/undefined (legacy/human preview). */
	origin?: string | null;
}

export function teardownConfirmMessage(p: TeardownConfirmTarget): string {
	const lines = [`Tear down preview "${p.name}"?`];
	if (p.pool) {
		lines.push(
			`This is a claimed warm-pool environment: alias "${p.name}" is backed by pool member ${p.pool}, which will be torn down and recycled.`
		);
	} else {
		lines.push('This permanently deletes the vcluster and its database.');
	}
	if (p.origin === 'pr') {
		lines.push(
			'Origin: PR preview — it is normally torn down automatically when its pull request closes.'
		);
	} else if (p.origin) {
		lines.push(`Origin: ${p.origin}.`);
	}
	return lines.join('\n\n');
}
