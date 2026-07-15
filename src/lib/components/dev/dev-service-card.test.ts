import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), 'dev-service-card.svelte'),
	'utf8'
);

describe('DevServiceCard sidecar status', () => {
	it('awaits the remote resource after refresh before publishing its view', () => {
		expect(source).toContain('if (invalidate) await statusQuery.refresh()');
		expect(source).toContain('view = await statusQuery');
		expect(source).toContain('void refreshStatus(false)');
		expect(source).not.toContain('const view = $derived(statusQuery.current)');
	});
});
