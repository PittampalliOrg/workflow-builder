import { describe, expect, it } from 'vitest';
import {
	checkpointGitChangeLabel,
	checkpointIsDurable,
	checkpointLineDelta,
	checkpointMatchesSession,
	checkpointRemoteLabel,
	checkpointShaRange,
	filterCheckpointsForSession,
	resolveCheckpointStepId,
	shortSha,
	type CodeCheckpoint
} from './code-checkpoints';

function makeCheckpoint(overrides: Partial<CodeCheckpoint> = {}): CodeCheckpoint {
	return {
		id: 'cp-1',
		seq: 1,
		toolName: 'write_file',
		status: 'created',
		beforeSha: 'aaaaaaaaaaaa',
		afterSha: 'bbbbbbbbbbbb',
		remoteUrl: null,
		remoteRef: null,
		remoteStatus: null,
		remoteError: null,
		remotePushedAt: null,
		changedFiles: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }],
		fileCount: 1,
		sourceEventId: 'evt-1',
		sandboxName: 'sandbox-x',
		repoPath: '/workspace',
		error: null,
		createdAt: '2026-07-24T00:00:00Z',
		...overrides
	};
}

describe('shortSha', () => {
	it('truncates to 8 chars and falls back to "none"', () => {
		expect(shortSha('0123456789abcdef')).toBe('01234567');
		expect(shortSha(null)).toBe('none');
		expect(shortSha(undefined)).toBe('none');
	});
});

describe('checkpointIsDurable', () => {
	it('is durable only when pushed with a remote ref', () => {
		expect(checkpointIsDurable(makeCheckpoint({ remoteStatus: 'pushed', remoteRef: 'refs/x' }))).toBe(true);
		expect(checkpointIsDurable(makeCheckpoint({ remoteStatus: 'pushed', remoteRef: null }))).toBe(false);
		expect(checkpointIsDurable(makeCheckpoint({ remoteStatus: 'error', remoteRef: 'refs/x' }))).toBe(false);
	});
});

describe('checkpointRemoteLabel', () => {
	it('maps remote state to a human label', () => {
		expect(checkpointRemoteLabel(makeCheckpoint({ remoteStatus: 'pushed', remoteRef: 'refs/x' }))).toBe('durable');
		expect(checkpointRemoteLabel(makeCheckpoint({ remoteStatus: 'error' }))).toBe('remote error');
		expect(checkpointRemoteLabel(makeCheckpoint({ remoteRef: 'refs/x' }))).toBe('not pushed');
		expect(checkpointRemoteLabel(makeCheckpoint({}))).toBe('local only');
	});
});

describe('checkpointGitChangeLabel + shaRange', () => {
	it('summarizes change status counts and sha range for created checkpoints', () => {
		const cp = makeCheckpoint({
			fileCount: 3,
			changedFiles: [
				{ path: 'a.ts', status: 'A' },
				{ path: 'b.ts', status: 'M' },
				{ path: 'c.ts', status: 'M' }
			]
		});
		expect(checkpointGitChangeLabel(cp)).toBe('A 1 M 2');
		expect(checkpointShaRange(cp)).toBe('aaaaaaaa..bbbbbbbb');
	});

	it('returns null for checkpoints without file changes', () => {
		const cp = makeCheckpoint({ status: 'no_changes', fileCount: 0, changedFiles: [] });
		expect(checkpointGitChangeLabel(cp)).toBeNull();
		expect(checkpointShaRange(cp)).toBeNull();
	});
});

describe('checkpointLineDelta', () => {
	it('sums additions and deletions across files', () => {
		const cp = makeCheckpoint({
			changedFiles: [
				{ path: 'a.ts', additions: 3, deletions: 1 },
				{ path: 'b.ts', additions: 10, deletions: 4 },
				{ path: 'c.bin', binary: true }
			]
		});
		expect(checkpointLineDelta(cp)).toEqual({ additions: 13, deletions: 5 });
	});
});

describe('resolveCheckpointStepId', () => {
	it('prefers nodeId, reducing a canvas path to the bare name', () => {
		expect(resolveCheckpointStepId(makeCheckpoint({ nodeId: '/do/2/build' }))).toBe('build');
		expect(resolveCheckpointStepId(makeCheckpoint({ nodeId: 'build' }))).toBe('build');
	});

	it('falls back to toolCallId, then null', () => {
		expect(resolveCheckpointStepId(makeCheckpoint({ nodeId: null, toolCallId: 'call_42' }))).toBe('call_42');
		expect(resolveCheckpointStepId(makeCheckpoint({ nodeId: null, toolCallId: null }))).toBeNull();
	});
});

describe('checkpointMatchesSession', () => {
	it('matches by explicit session id', () => {
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: 's1' }), { sessionId: 's1' })).toBe(true);
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: 's1' }), { sessionId: 's2' })).toBe(false);
	});

	it('matches by sandbox name', () => {
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: null, sandboxName: 'box' }), { sandboxName: 'box' })).toBe(true);
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: null, sandboxName: 'other' }), { sandboxName: 'box' })).toBe(false);
	});

	it('matches on either identifier and returns all for an empty filter', () => {
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: 's1', sandboxName: 'box' }), { sessionId: 'x', sandboxName: 'box' })).toBe(true);
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: null, sandboxName: null }), null)).toBe(true);
		expect(checkpointMatchesSession(makeCheckpoint({ sessionId: null, sandboxName: null }), {})).toBe(true);
	});
});

describe('filterCheckpointsForSession', () => {
	const withLinkage = makeCheckpoint({ id: 'a', sessionId: 's1', sandboxName: 'box-s1' });
	const otherSession = makeCheckpoint({ id: 'b', sessionId: 's2', sandboxName: 'box-s2' });

	it('filters to the matching session when linkage exists', () => {
		const out = filterCheckpointsForSession([withLinkage, otherSession], { sessionId: 's1' });
		expect(out.map((c) => c.id)).toEqual(['a']);
	});

	it('shows all when no checkpoint carries linkage (older rows)', () => {
		const bare = [
			makeCheckpoint({ id: 'a', sessionId: null, sandboxName: null }),
			makeCheckpoint({ id: 'b', sessionId: null, sandboxName: null })
		];
		expect(filterCheckpointsForSession(bare, { sessionId: 's1' }).map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('shows all for an empty filter', () => {
		expect(filterCheckpointsForSession([withLinkage, otherSession], null)).toHaveLength(2);
	});
});
