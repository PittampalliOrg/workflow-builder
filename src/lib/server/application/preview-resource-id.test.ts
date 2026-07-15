import { describe, expect, it } from 'vitest';
import { isPreviewResourceId } from '$lib/server/application/preview-resource-id';

describe('preview resource identifier contract', () => {
	it.each([
		'_O-r4CT3dAp9CRUi7ImCA',
		'-O_r4CT3dAp9CRUi7ImCA',
		'execution-1',
		'legacy.execution:1'
	])('accepts workflow-compatible identifier %s', (value) => {
		expect(isPreviewResourceId(value)).toBe(true);
	});

	it.each(['', '../other', 'execution/id', 'execution id', 'a'.repeat(257)])(
		'rejects unsafe identifier %j',
		(value) => {
			expect(isPreviewResourceId(value)).toBe(false);
		}
	);
});
