import { describe, expect, it } from 'vitest';
import { decodePageCursor, encodePageCursor, pageCursorScope } from './pagination';

describe('workflow diagnostics pagination', () => {
	it('round-trips an offset only for the same query scope', () => {
		const scope = pageCursorScope('spans', {
			executionId: 'execution-1',
			query: 'failed',
			limit: 25
		});
		const cursor = encodePageCursor(25, scope);

		expect(cursor).not.toBeNull();
		expect(decodePageCursor(cursor, scope)).toBe(25);
	});

	it('rejects a cursor when filters or execution scope change', () => {
		const originalScope = pageCursorScope('logs', {
			executionId: 'execution-1',
			query: null,
			limit: 50
		});
		const changedScope = pageCursorScope('logs', {
			executionId: 'execution-2',
			query: null,
			limit: 50
		});
		const cursor = encodePageCursor(50, originalScope);

		expect(cursor).not.toBeNull();
		expect(decodePageCursor(cursor, changedScope)).toBeNull();
	});

	it('rejects oversized, malformed, and unbounded cursors', () => {
		const scope = pageCursorScope('executions', { projectId: 'project-1', limit: 20 });
		const beyondLimit = Buffer.from(
			JSON.stringify({ version: 1, offset: 10_001, scope }),
			'utf8'
		).toString('base64url');

		expect(decodePageCursor('x'.repeat(513), scope)).toBeNull();
		expect(decodePageCursor('not-json', scope)).toBeNull();
		expect(decodePageCursor(beyondLimit, scope)).toBeNull();
		expect(encodePageCursor(10_001, scope)).toBeNull();
	});
});
