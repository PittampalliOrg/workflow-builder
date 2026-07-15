import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./code-versions-panel.svelte', import.meta.url), 'utf8');

describe('code versions promotion UX', () => {
	it('reconciles strict promotion through the client port and durable projection', () => {
		expect(source).toContain('promoteStrictCheckpointUntilConfirmed');
		expect(source).toContain('strictCheckpointPromotionReceiptFromVersion');
		expect(source).toContain('reconcilePersistedPromotions(body.versions)');
		expect(source).toContain('Verifying the exact GitHub receipt');
		expect(source).not.toContain('$lib/server');
	});

	it('keeps promotion transport errors separate from acceptance results', () => {
		expect(source).toContain('promotionError?: string');
		expect(source).toContain('acceptanceError?: string');
		expect(source).not.toContain('result?.error');
	});
});
