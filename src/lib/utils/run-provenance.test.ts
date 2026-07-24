import { describe, expect, it } from 'vitest';
import { deriveRunProvenance, hasRunProvenance } from './run-provenance';

describe('deriveRunProvenance', () => {
	it('is empty for a plain run', () => {
		const p = deriveRunProvenance({});
		expect(p).toEqual({
			isFork: false,
			forkFromNode: null,
			seededFromSnapshot: false,
			snapshotNode: null,
			snapshotPath: null,
			isReproduce: false
		});
		expect(hasRunProvenance(p)).toBe(false);
	});

	it('flags a fork with its replay node', () => {
		const p = deriveRunProvenance({ rerunOfExecutionId: 'exec-1', resumeFromNode: 'build' });
		expect(p.isFork).toBe(true);
		expect(p.forkFromNode).toBe('build');
		expect(hasRunProvenance(p)).toBe(true);
	});

	it('flags a snapshot-seeded fork and extracts the snapshot node', () => {
		const p = deriveRunProvenance({
			rerunOfExecutionId: 'exec-1',
			seedWorkspaceFrom: '.snapshots/instance-root/build'
		});
		expect(p.seededFromSnapshot).toBe(true);
		expect(p.snapshotNode).toBe('build');
		expect(p.snapshotPath).toBe('.snapshots/instance-root/build');
	});

	it('does not flag snapshot for an end-state workspace seed', () => {
		const p = deriveRunProvenance({ seedWorkspaceFrom: 'sw-example-exec-root' });
		expect(p.seededFromSnapshot).toBe(false);
		expect(p.snapshotNode).toBeNull();
	});

	it('flags reproduce only from a persisted trigger source', () => {
		expect(deriveRunProvenance({ triggerSource: 'reproduce' }).isReproduce).toBe(true);
		expect(deriveRunProvenance({ triggerSource: 'Reproduce' }).isReproduce).toBe(true);
		expect(deriveRunProvenance({ triggerSource: 'manual' }).isReproduce).toBe(false);
	});
});
